import { MAX_CATCHUP_ACTIONS_PER_FRAME } from "../constants";
import type { InputAction } from "../types";
import { lowerBound } from "../util/helpers";

/**
 * Look-ahead scheduler.
 *
 * Shape:
 *
 *   Chart -> Timeline -> [ Scheduler ] -> InputManager -> KeyboardEvents
 *
 * There is exactly ONE `requestAnimationFrame` loop and a small number of
 * short-lived timers — never one timer per note. On every frame the scheduler:
 *
 *   1. samples the clock (so the caller can refit its model)
 *   2. flushes anything already overdue (catch-up after a stall)
 *   3. arms or retargets a precise timer for the next batch
 *
 * Timers chain to the next batch without waiting for another animation frame,
 * and periodically recheck predictions across longer gaps. Near a deadline,
 * they busy-wait at most `spinThreshold` ms against `performance.now()` for
 * sub-millisecond placement. The busy-wait is bounded to a few ms.
 *
 * Batching: actions sharing an identical timestamp are fired from a single
 * timer in timeline order, which is what preserves same-frame simultaneous
 * input ordering for replay compatibility.
 */

export interface SchedulerHooks {
  /** Current chart time, ms. */
  nowChart: () => number;
  /** Host (`performance.now()`) time at which a chart time is predicted to occur. */
  hostTimeFor: (chartTime: number) => number;
  /** Fire one batch of same-timestamp actions, in order. */
  fire: (actions: InputAction[], firedAtHost: number, targetChartTime: number) => void;
  /**
   * Called at start/resume and on each frame to sample the clock model.
   *
   * Returning a number asks the scheduler to resync its cursor to that chart
   * time. This is how a seek is distinguished from a frame stall: only the
   * clock model sees both samples, and only it can tell "the playhead jumped
   * while host time barely moved" (a seek — skip the notes we passed) from
   * "host time and the playhead both advanced" (a stall — play what we owe).
   */
  sample?: (host: number, chart: number) => number | void;
  /** Diagnostics / debug log. Must not throw. */
  log?: (message: string, data?: unknown) => void;
  /** Called when old overdue actions are skipped to bound catch-up work. */
  onOverrun?: (droppedCount: number, atChartTime: number, skipped: readonly InputAction[]) => void;
  /** Called when the final action has been fired. */
  onComplete?: () => void;
}

export interface SchedulerOptions {
  lookahead: number;
  spinThreshold: number;
  now?: () => number;
  scheduleTask?: (fn: () => void, delayMs: number) => number;
  cancelTask?: (handle: number) => void;
  requestFrame?: (cb: (t: number) => void) => number;
  cancelFrame?: (handle: number) => void;
}

/**
 * `setTimeout` clamps to ~4ms in the foreground and much worse in background
 * tabs. A `MessageChannel` port task runs at the end of the current task
 * without that clamp, so we use it for the final short hop and fall back to
 * `setTimeout` when it is unavailable.
 */
export interface FastTask {
  schedule: (fn: () => void, delayMs: number) => number;
  cancel: (handle: number) => void;
  /** Close the underlying channel and drop pending work. */
  dispose: () => void;
}

export function createFastTask(): FastTask {
  const pending = new Map<number, () => void>();
  let nextId = 1;
  let channel: MessageChannel | null = null;

  try {
    // MessageChannel exists in browsers and in Node >= 15, but a sandboxed
    // page may remove it; the setTimeout fallback below covers that.
    if (typeof MessageChannel !== "undefined") {
      channel = new MessageChannel();
      channel.port1.onmessage = (event: MessageEvent) => {
        const id = event.data as number;
        const fn = pending.get(id);
        if (!fn) return;
        pending.delete(id);
        try {
          fn();
        } catch (err) {
          console.error("[Autoplay] scheduled task threw", err);
        }
      };

      // Browsers do not keep a page alive for a MessagePort, but Node refs its
      // ports and would hold the process open. `unref` is Node-only, so probe
      // for it instead of assuming either environment.
      for (const port of [channel.port1, channel.port2]) {
        const maybeUnref = (port as unknown as { unref?: () => void }).unref;
        if (typeof maybeUnref === "function") {
          try {
            maybeUnref.call(port);
          } catch {
            /* not supported here; harmless */
          }
        }
      }
    }
  } catch {
    channel = null;
  }

  const timers = new Map<number, number>();

  function run(id: number) {
    const timer = timers.get(id);
    if (timer !== undefined && timer !== 0) clearTimeout(timer);
    timers.delete(id);
    if (channel) channel.port2.postMessage(id);
    else {
      const fn = pending.get(id);
      if (fn) {
        pending.delete(id);
        fn();
      }
    }
  }

  return {
    schedule(fn, delayMs) {
      const id = nextId++;
      pending.set(id, fn);
      if (delayMs <= 0 && channel) {
        // Post immediately, skipping the timer entirely.
        run(id);
      } else {
        // Without MessageChannel, even the zero-delay fallback must be
        // asynchronous so callers can store and cancel the returned handle.
        timers.set(id, setTimeout(() => run(id), Math.max(0, delayMs)) as unknown as number);
      }
      return id;
    },
    cancel(id) {
      const timer = timers.get(id);
      if (timer !== undefined && timer !== 0) clearTimeout(timer);
      timers.delete(id);
      pending.delete(id);
    },
    dispose() {
      for (const timer of timers.values()) {
        if (timer !== 0) clearTimeout(timer);
      }
      timers.clear();
      pending.clear();
      try {
        channel?.port1.close();
        channel?.port2.close();
      } catch {
        /* already closed */
      }
      channel = null;
    },
  };
}

const DEFAULT_NOW = () => performance.now();
const DEFAULT_RAF = (cb: (t: number) => void) => requestAnimationFrame(cb);
const DEFAULT_CANCEL_RAF = (h: number) => cancelAnimationFrame(h);

/** Every option, fully resolved. */
interface ResolvedOptions {
  lookahead: number;
  spinThreshold: number;
  now: () => number;
  scheduleTask: (fn: () => void, delayMs: number) => number;
  cancelTask: (handle: number) => void;
  requestFrame: (cb: (t: number) => void) => number;
  cancelFrame: (handle: number) => void;
}

export class Scheduler {
  private hooks: SchedulerHooks;
  private opts: ResolvedOptions;

  private actions: InputAction[] = [];
  private cursor = 0;
  private running = false;
  private paused = false;

  private frameHandle: number | null = null;
  private armedHandle: number | null = null;
  private armedBatchIndex = -1;
  private armedHostTime = Number.NaN;
  /** Invalidates a canceled callback even if it was already queued. */
  private armedToken = 0;

  /** Invalidates every outstanding timer. Bumped on stop/pause/rebase. */
  private epoch = 0;

  /**
   * Shift applied to every action's chart time before it is compared against
   * the playhead. Negative fires earlier.
   *
   * This must live here rather than only inside `hostTimeFor`: the catch-up
   * loop compares raw action times against the current chart time, and if the
   * two paths disagree the offset is silently ignored whenever a note is fired
   * by catch-up instead of by its armed timer.
   */
  private actionOffset = 0;

  private fast = createFastTask();
  private now: () => number;

  // Jitter tracking
  private jitterSum = 0;
  private jitterAbsSum = 0;
  private jitterCount = 0;
  private lastJitter = 0;

  public firedCount = 0;
  public droppedCount = 0;

  constructor(hooks: SchedulerHooks, options: SchedulerOptions) {
    this.hooks = hooks;
    this.now = options.now ?? DEFAULT_NOW;
    this.opts = {
      lookahead: options.lookahead,
      spinThreshold: options.spinThreshold,
      now: this.now,
      scheduleTask: options.scheduleTask ?? ((fn, d) => this.fast.schedule(fn, d)),
      cancelTask: options.cancelTask ?? ((h) => this.fast.cancel(h)),
      requestFrame: options.requestFrame ?? DEFAULT_RAF,
      cancelFrame: options.cancelFrame ?? DEFAULT_CANCEL_RAF,
    };
  }

  /** Load a timeline. Resets cursor and counters. */
  load(actions: InputAction[], startFromChartTime?: number): void {
    // Live setting changes can replace the timeline while a timer is armed.
    // Cancel and invalidate it before changing action indexes, so it cannot
    // block or fire a batch from the old timeline.
    this.clearArmed();
    this.epoch++;
    this.actions = actions;
    const offset = this.actionOffset;
    this.cursor =
      startFromChartTime === undefined
        ? 0
        : lowerBound(actions, startFromChartTime, (a) => a.time + offset);
    this.firedCount = 0;
    this.droppedCount = 0;
    this.jitterSum = 0;
    this.jitterAbsSum = 0;
    this.jitterCount = 0;
    this.lastJitter = 0;
    this.armedBatchIndex = -1;
  }

  /**
   * Move the cursor to a chart time without clearing the timeline.
   * Used after a seek, a resume, or a detected discontinuity.
   */
  rebase(chartTime: number): void {
    this.clearArmed();
    const offset = this.actionOffset;
    this.cursor = lowerBound(this.actions, chartTime, (a) => a.time + offset);
    this.hooks.log?.(`scheduler rebased to ${chartTime.toFixed(1)}ms (cursor=${this.cursor})`);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.paused = false;
    this.epoch++;
    this.scheduleFrame();
    this.primeTimer();
    this.hooks.log?.(`scheduler started (${this.actions.length} actions)`);
  }

  /** Stop firing but keep the cursor. */
  pause(): void {
    if (!this.running) return;
    this.paused = true;
    this.clearArmed();
    this.hooks.log?.("scheduler paused");
  }

  resume(): void {
    if (!this.running || !this.paused) return;
    this.paused = false;
    // Re-sync the cursor to wherever the chart actually is, so a pause that
    // lasted a while doesn't dump a burst of stale actions.
    this.rebase(this.hooks.nowChart());
    this.primeTimer();
    this.hooks.log?.("scheduler resumed");
  }

  /** Full stop: cancel timers, invalidate epoch, drop the timeline. */
  stop(): void {
    this.running = false;
    this.paused = false;
    this.epoch++;
    this.clearArmed();
    this.cancelFrame();
    this.cursor = 0;
    this.actions = [];
    this.hooks.log?.("scheduler stopped");
  }

  /** Same as stop() but preserves the loaded timeline for a later resume. */
  halt(): void {
    this.running = false;
    this.paused = false;
    this.epoch++;
    this.clearArmed();
    this.cancelFrame();
    this.hooks.log?.("scheduler halted");
  }

  get isRunning(): boolean {
    return this.running && !this.paused;
  }

  get isPaused(): boolean {
    return this.running && this.paused;
  }

  get remaining(): number {
    return Math.max(this.actions.length - this.cursor, 0);
  }

  get total(): number {
    return this.actions.length;
  }

  get cursorIndex(): number {
    return this.cursor;
  }

  get armedCount(): number {
    return this.armedHandle === null ? 0 : 1;
  }

  /** Next queued release for a held column, used only by the safety watchdog. */
  nextReleaseAt(column: number): number | null {
    if (!this.isRunning) return null;
    for (let i = this.cursor; i < this.actions.length; i++) {
      const action = this.actions[i];
      if (action.column === column) return action.type === "up" ? this.dueTime(i) : null;
    }
    return null;
  }

  getJitter(): { last: number; avg: number; samples: number } {
    return {
      last: this.lastJitter,
      avg: this.jitterCount > 0 ? this.jitterAbsSum / this.jitterCount : 0,
      samples: this.jitterCount,
    };
  }

  /** Update scheduling parameters live (settings changed mid-run). */
  setOptions(lookahead: number, spinThreshold: number): void {
    this.opts.lookahead = lookahead;
    this.opts.spinThreshold = spinThreshold;
  }

  /**
   * Set the timing offset in ms and resync the cursor.
   *
   * Changing the offset moves every action's effective time, so the cursor has
   * to be re-derived against the playhead or the scheduler would be left
   * pointing at the wrong place in the timeline.
   */
  setActionOffset(offset: number): void {
    if (!Number.isFinite(offset) || offset === this.actionOffset) return;
    this.actionOffset = offset;
    this.clearArmed();
    if (this.actions.length > 0) this.rebase(this.hooks.nowChart());
  }

  get actionTimeOffset(): number {
    return this.actionOffset;
  }

  /** Effective due time of an action, including the timing offset. */
  private dueTime(index: number): number {
    return this.actions[index].time + this.actionOffset;
  }

  /** First action strictly after the current playhead, in O(log n). */
  private afterDue(chartNow: number): number {
    let lo = this.cursor;
    let hi = this.actions.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.dueTime(mid) <= chartNow) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /* ----------------------------- internals ----------------------------- */

  /** Prime the clock and arm asynchronously; the caller can finish starting first. */
  private primeTimer(): void {
    const hostNow = this.now();
    const chartNow = this.hooks.nowChart();
    const resyncTo = this.hooks.sample?.(hostNow, chartNow);
    if (typeof resyncTo === "number" && Number.isFinite(resyncTo)) this.rebase(resyncTo);
    this.armNext();
  }

  private armNext(): void {
    if (!this.isRunning || this.armedHandle !== null || this.cursor >= this.actions.length) return;
    const predictedHost = this.hooks.hostTimeFor(this.dueTime(this.cursor));
    if (Number.isFinite(predictedHost)) this.armBatch(this.cursor, predictedHost);
  }

  private scheduleFrame(): void {
    if (this.frameHandle !== null) return;
    this.frameHandle = this.opts.requestFrame((t) => {
      this.frameHandle = null;
      this.tick(t);
    });
  }

  private cancelFrame(): void {
    if (this.frameHandle !== null) {
      this.opts.cancelFrame(this.frameHandle);
      this.frameHandle = null;
    }
  }

  private clearArmed(): void {
    this.armedToken++;
    if (this.armedHandle !== null) {
      this.opts.cancelTask(this.armedHandle);
      this.armedHandle = null;
    }
    this.armedBatchIndex = -1;
    this.armedHostTime = Number.NaN;
  }

  private armBatch(batchIndex: number, predictedHost: number): void {
    const epoch = this.epoch;
    const token = ++this.armedToken;
    this.armedBatchIndex = batchIndex;
    this.armedHostTime = predictedHost;
    // Wake at least once per lookahead window even across long gaps. Besides
    // tracking rate changes, this lets the timer chain keep working if frames
    // are delayed while the browser can still run ordinary tasks.
    const delay = Math.min(
      Math.max(0, predictedHost - this.now() - this.opts.spinThreshold),
      Math.max(16, this.opts.lookahead),
    );
    this.armedHandle = this.opts.scheduleTask(() => {
      // Cancellation can race a callback already queued by the browser. Do not
      // let that stale callback clear or fire its replacement timer.
      if (token !== this.armedToken) return;
      this.armedHandle = null;
      this.armedBatchIndex = -1;
      this.armedHostTime = Number.NaN;
      this.onArmedFired(epoch, batchIndex);
    }, delay);
  }

  private tick(_frameTime: number): void {
    if (!this.running) return;

    const hostNow = this.now();
    const chartNow = this.hooks.nowChart();

    // Let the caller refit its clock model, and act on a resync request.
    // Doing this before the paused check means a seek while paused still
    // leaves the cursor in the right place for the eventual resume.
    const resyncTo = this.hooks.sample?.(hostNow, chartNow);
    if (typeof resyncTo === "number" && Number.isFinite(resyncTo)) {
      this.rebase(resyncTo);
    }

    if (this.paused) {
      // Keep the heartbeat alive but do no scheduling work.
      this.scheduleFrame();
      return;
    }

    if (this.cursor >= this.actions.length) {
      // Nothing left. Fire completion once, then stop the loop.
      this.running = false;
      this.cancelFrame();
      this.clearArmed();
      this.hooks.onComplete?.();
      return;
    }

    // --- Catch-up: flush anything already due -------------------------
    // A long main-thread stall may leave hundreds of actions overdue. Bound
    // the work, but skip only the oldest *overdue* actions — never the future
    // remainder of the chart. Keep whole timestamp batches together.
    const dueEnd = this.afterDue(chartNow);
    if (dueEnd - this.cursor > MAX_CATCHUP_ACTIONS_PER_FRAME) {
      const start = this.cursor;
      let end = dueEnd - MAX_CATCHUP_ACTIONS_PER_FRAME;
      while (end < dueEnd && this.dueTime(end) === this.dueTime(end - 1)) end++;
      const skipped = this.actions.slice(start, end);
      this.clearArmed();
      this.cursor = end;
      this.droppedCount += skipped.length;
      const epoch = this.epoch;
      this.hooks.onOverrun?.(skipped.length, chartNow, skipped);
      if (!this.running || this.paused || this.epoch !== epoch) return;
    }

    while (this.cursor < this.actions.length && this.dueTime(this.cursor) <= chartNow) {
      // Catch-up can beat an armed timer after a clock change or frame stall.
      // Cancel it before advancing so it cannot block the next batch.
      if (this.armedHandle !== null) this.clearArmed();
      const batch = this.takeBatchAtCursor();
      const epoch = this.epoch;
      this.dispatch(batch, hostNow, chartNow, true);
      if (!this.running || this.paused || this.epoch !== epoch) return;
    }

    if (this.cursor >= this.actions.length) {
      this.scheduleFrame();
      return;
    }

    // --- Arm the next batch ------------------------------------------
    const predictedHost = this.hooks.hostTimeFor(this.dueTime(this.cursor));
    if (this.armedHandle !== null &&
        (this.armedBatchIndex !== this.cursor || predictedHost < this.armedHostTime - 1)) {
      // Acceleration can move an already-armed deadline earlier. Later
      // predictions are rechecked when the current timer wakes up.
      this.clearArmed();
    }
    if (this.armedHandle === null && Number.isFinite(predictedHost)) {
      this.armBatch(this.cursor, predictedHost);
    }

    this.scheduleFrame();
  }

  /** Collect all actions sharing the cursor's effective timestamp, in order. */
  private takeBatchAtCursor(): InputAction[] {
    const target = this.dueTime(this.cursor);
    const start = this.cursor;
    let end = start;
    while (end < this.actions.length && this.dueTime(end) === target) end++;
    this.cursor = end;
    // Slice is one small allocation per batch (a few notes), not per frame.
    return this.actions.slice(start, end);
  }

  private onArmedFired(epoch: number, batchIndex: number): void {
    if (epoch !== this.epoch) return; // stale timer from before a stop/pause
    if (!this.running || this.paused) return;
    if (batchIndex < 0 || batchIndex >= this.actions.length) return;
    if (batchIndex !== this.cursor) return; // cursor moved (catch-up won the race)

    const target = this.dueTime(batchIndex);
    const predictedHost = this.hooks.hostTimeFor(target);
    // A temporarily unavailable clock must not turn NaN into an early press.
    // The next animation frame will retry or catch up once the clock recovers.
    if (!Number.isFinite(predictedHost)) return;
    const remaining = predictedHost - this.now();

    // A timer can be the first callback after a main-thread stall, before the
    // next animation frame. Recover the backlog using the current clock rather
    // than blindly firing one obsolete batch from the old deadline.
    if (remaining < -8) {
      if (this.hooks.nowChart() >= target) this.tick(this.now());
      // If the site's frame-based clock has not caught up yet, let the next
      // animation frame resample it instead of spinning on an expired timer.
      return;
    }

    // Not due yet (clock model is conservative): re-arm for the remainder.
    if (remaining > this.opts.spinThreshold) {
      this.armBatch(batchIndex, predictedHost);
      return;
    }

    // Final approach: bounded busy-wait for sub-millisecond placement.
    //
    // Two independent budgets: an absolute deadline derived from the predicted
    // host time, and a hard iteration cap.
    //
    // The deadline must be computed from `predictedHost`, NOT as
    // `now() + remaining`. `remaining` is a snapshot; comparing it against a
    // re-read clock makes the loop condition dependent on both sides moving,
    // which cannot terminate if the clock is frozen or non-monotonic. An
    // absolute target with a re-read `now()` always terminates.
    if (remaining > 0) {
      const spinDeadline = Math.min(
        predictedHost,
        this.now() + Math.max(0, this.opts.spinThreshold),
      );
      let spins = 0;
      const spinCap = 200_000;
      while (this.now() < spinDeadline && spins++ < spinCap) {
        /* bounded spin */
      }
      if (spins >= spinCap) {
        this.hooks.log?.(`spin budget exhausted (predicted lead ${remaining.toFixed(2)}ms)`);
      }
    }

    const batch = this.takeBatchAtCursor();
    this.dispatch(batch, this.now(), this.hooks.nowChart(), false);
    if (epoch !== this.epoch || !this.running || this.paused || this.cursor >= this.actions.length) return;

    // A slow/missing animation frame must not delay the following notes when
    // the event loop is otherwise available. Only one timer is armed at once.
    this.armNext();
  }

  private dispatch(
    batch: InputAction[],
    hostNow: number,
    chartNow: number,
    isCatchUp: boolean,
  ): void {
    if (batch.length === 0) return;

    const target = batch[0].time;
    // Jitter = how far the chart clock had actually travelled past the target.
    const jitter = chartNow - target;
    this.lastJitter = jitter;
    this.jitterSum += jitter;
    this.jitterAbsSum += Math.abs(jitter);
    this.jitterCount++;
    this.firedCount += batch.length;

    if (isCatchUp && jitter > 50) {
      this.hooks.log?.(
        `catch-up fired ${batch.length} action(s) ${jitter.toFixed(1)}ms late`,
      );
    }

    try {
      this.hooks.fire(batch, hostNow, target);
    } catch (err) {
      // Never let an input failure kill the loop; the engine's guards handle
      // escalation and key release.
      console.error("[Autoplay] input dispatch failed", err);
      this.hooks.log?.(`dispatch failed: ${(err as Error)?.message ?? err}`);
    }
  }

  /** Release every resource. Safe to call more than once. */
  dispose(): void {
    this.stop();
    this.cancelFrame();
    this.fast.dispose();
  }
}
