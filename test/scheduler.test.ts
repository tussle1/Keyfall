import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ClockMapper } from "../src/timing/clock";
import { Scheduler, createFastTask } from "../src/timing/scheduler";
import type { InputAction } from "../src/types";

/** A fully controllable clock + task queue, so timing is exact not flaky. */
function harness(options: { lookahead?: number; spinThreshold?: number; ignoreCancel?: boolean } = {}) {
  let now = 0;
  let chart = 0;
  let slope = 1; // chart ms per host ms
  let predictionAvailable = true;

  interface Task {
    at: number;
    fn: () => void;
    id: number;
  }
  const tasks: Task[] = [];
  let nextTaskId = 1;
  const frames: Array<(t: number) => void> = [];

  const fired: Array<{ actions: InputAction[]; hostNow: number; target: number }> = [];
  const samples: Array<{ host: number; chart: number }> = [];
  // A real clock model, wired exactly as the engine wires it: it decides
  // whether a jump was a seek, and the scheduler acts on that decision.
  const clock = new ClockMapper();
  const overruns: Array<{ dropped: number; at: number; skipped: InputAction[] }> = [];
  let completed = 0;

  const actions: InputAction[] = [];

  const scheduler = new Scheduler(
    {
      nowChart: () => chart,
      hostTimeFor: (chartTime) => predictionAvailable ? (chartTime - chart) / slope + now : Number.NaN,
      fire: (batch, hostNow, target) => fired.push({ actions: batch, hostNow, target }),
      sample: (host, chartTime) => {
        samples.push({ host, chart: chartTime });
        if (clock.sample(host, chartTime)) return chartTime;
      },
      onOverrun: (dropped, at, skipped) => overruns.push({ dropped, at, skipped: [...skipped] }),
      onComplete: () => completed++,
    },
    {
      lookahead: options.lookahead ?? 120,
      // Zero by default: the spin-wait is a real-time refinement that has no
      // meaning against a synthetic clock, and the harness drives time itself.
      spinThreshold: options.spinThreshold ?? 0,
      now: () => now,
      // A synchronous runner. Injecting it also keeps the Scheduler off its
      // default `createFastTask()`, whose MessageChannel port would otherwise
      // hold the Node event loop open after the tests finish.
      scheduleTask: (fn, delay) => {
        const id = nextTaskId++;
        tasks.push({ at: now + Math.max(0, delay), fn, id });
        return id;
      },
      cancelTask: (id) => {
        const index = tasks.findIndex((t) => t.id === id);
        if (index >= 0 && !options.ignoreCancel) tasks.splice(index, 1);
      },
      requestFrame: (cb) => {
        frames.push(cb);
        return frames.length;
      },
      cancelFrame: (handle) => {
        frames.splice(handle - 1, 1);
      },
    },
  );

  /** Anchor points for the linear chart clock: chart = chartBase + (now-hostBase)*slope. */
  let hostBase = 0;
  let chartBase = 0;

  function syncChart(): void {
    chart = chartBase + (now - hostBase) * slope;
  }

  /**
   * Advance host time to an ABSOLUTE deadline, running due tasks and animation
   * frames at the right moments.
   *
   * The deadline must be absolute. A relative one (`now + step`) never
   * converges here, because the scheduler deliberately arms timers *ahead* of
   * the playhead: a task firing beyond the step boundary pushes `now` forward,
   * which pushes the next relative target forward with it, and the loop runs
   * away.
   */
  function advance(ms: number, step = 4): void {
    const end = now + ms;
    let guard = 0;
    const guardLimit = Math.ceil(ms / Math.max(0.5, step)) * 400 + 2000;

    while (now < end && guard++ < guardLimit) {
      const target = Math.min(now + step, end);

      // Fire every task that comes due at or before `target`, in time order.
      for (;;) {
        let bestIndex = -1;
        let bestAt = Infinity;
        for (let i = 0; i < tasks.length; i++) {
          if (tasks[i].at <= target && tasks[i].at < bestAt) {
            bestAt = tasks[i].at;
            bestIndex = i;
          }
        }
        if (bestIndex < 0) break;

        const task = tasks.splice(bestIndex, 1)[0];
        now = Math.max(now, Math.min(task.at, end));
        syncChart();
        task.fn();
      }

      now = target;
      syncChart();

      // One frame per step, matching a display refresh driving the scheduler.
      const frame = frames.shift();
      if (frame) frame(now);
    }
  }

  /** Run browser timers while animation frames are delayed or absent. */
  function advanceTimersOnly(ms: number): void {
    const end = now + ms;
    let guard = 0;
    for (;;) {
      if (++guard > 10_000) throw new Error("timer-only scheduler loop did not converge");
      let index = -1;
      let at = Infinity;
      for (let i = 0; i < tasks.length; i++) {
        if (tasks[i].at <= end && tasks[i].at < at) { at = tasks[i].at; index = i; }
      }
      if (index < 0) break;
      const task = tasks.splice(index, 1)[0];
      now = Math.max(now, at);
      syncChart();
      task.fn();
    }
    now = end;
    syncChart();
  }

  /** A genuinely blocked main thread: wall time and audio advance, no callbacks run. */
  function stall(ms: number): void {
    now += ms;
    syncChart();
  }

  function runFrame(): void {
    const frame = frames.shift();
    if (frame) frame(now);
  }

  function runDueTask(): void {
    const index = tasks.findIndex((task) => task.at <= now);
    if (index < 0) return;
    const task = tasks.splice(index, 1)[0];
    task.fn();
  }

  /** Re-anchor the chart clock at the current host time (a seek). */
  function setChart(value: number): void {
    chartBase = value;
    hostBase = now;
    chart = value;
    clock.reset();
  }

  /** Simulate dragging the playhead: the chart clock moves, the host clock does not. */
  function seek(value: number): void {
    chartBase = value;
    hostBase = now;
    chart = value;
  }

  return {
    scheduler,
    actions,
    fired,
    samples,
    overruns,
    get completed() {
      return completed;
    },
    advance,
    advanceTimersOnly,
    stall,
    runFrame,
    runDueTask,
    seek,
    setChart,
    get now() {
      return now;
    },
    get chart() {
      return chart;
    },
    set slope(value: number) {
      // Rate changes preserve song position, just like the site's Music.rampTo.
      syncChart();
      chartBase = chart;
      hostBase = now;
      slope = value;
    },
    set predictionAvailable(value: boolean) {
      predictionAvailable = value;
    },
    get pendingTasks() {
      return tasks.length;
    },
    get pendingFrames() {
      return frames.length;
    },
  };
}

function act(seq: number, time: number, type: "down" | "up", column = 0): InputAction {
  return { seq, time, type, column, code: "KeyD", simultaneous: false, holdDuration: 0 };
}

describe("Scheduler", () => {
  it("fires every action in order", () => {
    const h = harness();
    const timeline = [act(0, 100, "down"), act(1, 100, "up"), act(2, 200, "down"), act(3, 200, "up")];
    h.scheduler.load(timeline, 0);
    h.setChart(0);
    h.scheduler.start();
    h.advance(400, 4);

    const flat = h.fired.flatMap((f) => f.actions.map((a) => a.seq));
    assert.deepEqual(flat, [0, 1, 2, 3]);
  });

  it("batches same-timestamp actions into one fire call", () => {
    const h = harness();
    h.scheduler.load([act(0, 100, "down", 0), act(1, 100, "down", 1), act(2, 100, "down", 2)], 0);
    h.setChart(0);
    h.scheduler.start();
    h.advance(300, 4);

    const chordFire = h.fired.find((f) => f.actions.length === 3);
    assert.ok(chordFire, "expected one fire call carrying all three chord actions");
    assert.deepEqual(
      chordFire.actions.map((a) => a.column),
      [0, 1, 2],
    );
  });

  it("does not use one timer per note", () => {
    const h = harness();
    const timeline: InputAction[] = [];
    for (let i = 0; i < 2000; i++) timeline.push(act(i, 1000 + i * 10, "down"));
    h.scheduler.load(timeline, 0);
    h.setChart(0);
    h.scheduler.start();
    h.advance(2000, 8);

    // At most a handful of timers armed at any moment, not 2000.
    assert.ok(h.pendingTasks < 8, `expected few pending tasks, got ${h.pendingTasks}`);
    assert.ok(h.fired.length > 0, "should have fired actions");
  });

  it("keeps precise timers moving when animation frames stall but the event loop is free", () => {
    const h = harness();
    h.scheduler.load([
      act(0, 100, "down"), act(1, 120, "down"), act(2, 140, "down"),
      act(3, 1000, "down"), act(4, 1300, "down"),
    ], 0);
    h.setChart(0); h.scheduler.start();
    h.advance(16, 16); // the last animation frame before a long rendering stall
    h.advanceTimersOnly(1400);
    assert.deepEqual(h.fired.flatMap((batch) => batch.actions.map((action) => action.seq)), [0, 1, 2, 3, 4]);
    for (const batch of h.fired) assert.ok(Math.abs(batch.hostNow - batch.target) < 1, `late batch at ${batch.hostNow}`);
    h.runFrame();
    assert.equal(h.completed, 1);
  });

  it("arms the initial note even if the first animation frame is delayed", () => {
    const h = harness();
    h.scheduler.load([act(0, 200, "down"), act(1, 400, "down")], 0);
    h.setChart(0); h.scheduler.start();
    h.advanceTimersOnly(500);
    assert.deepEqual(h.fired.flatMap((batch) => batch.actions.map((action) => action.seq)), [0, 1]);
    assert.ok(h.fired.every((batch) => Math.abs(batch.hostNow - batch.target) < 1));
  });

  it("fires nothing before the action time", () => {
    const h = harness();
    h.scheduler.load([act(0, 1000, "down")], 0);
    h.setChart(0);
    h.scheduler.start();
    h.advance(900, 5);
    assert.equal(h.fired.length, 0);
    h.advance(200, 5);
    assert.equal(h.fired.length, 1);
  });

  it("reports scheduling jitter relative to the target", () => {
    const h = harness();
    h.scheduler.load([act(0, 500, "down")], 0);
    h.setChart(0);
    h.scheduler.start();
    h.advance(700, 5);
    const jitter = h.scheduler.getJitter();
    assert.ok(jitter.samples > 0);
    // With a 5ms step the action can be at most one step late.
    assert.ok(Math.abs(jitter.avg) <= 6, `avg jitter ${jitter.avg}`);
  });

  it("starts mid-chart from the given position without dumping past notes", () => {
    const h = harness();
    const timeline = [act(0, 100, "down"), act(1, 200, "down"), act(2, 300, "down"), act(3, 400, "down")];
    // Position the playhead FIRST. Setting it after the scheduler has sampled
    // chart time 0 looks exactly like a forward seek, and the clock mapper
    // would (correctly) rebase the cursor back to the start.
    h.setChart(250);
    h.scheduler.load(timeline, 250);
    h.scheduler.start();
    // 250 -> 350 puts only the note at 300 in range; 400 stays ahead.
    h.advance(100, 5);

    const seqs = h.fired.flatMap((f) => f.actions.map((a) => a.seq));
    assert.deepEqual(seqs, [2], "only actions at/after the playhead should fire");
    assert.equal(h.scheduler.remaining, 1, "the note at 400 is still queued");

    h.advance(100, 5);
    assert.deepEqual(
      h.fired.flatMap((f) => f.actions.map((a) => a.seq)),
      [2, 3],
    );
  });

  it("pause stops firing and resume continues from the live position", () => {
    const h = harness();
    h.scheduler.load([act(0, 100, "down"), act(1, 200, "down"), act(2, 900, "down")], 0);
    h.setChart(0);
    h.scheduler.start();
    h.advance(150, 5);
    assert.equal(h.fired.length, 1);

    h.scheduler.pause();
    assert.equal(h.scheduler.isPaused, true);
    const firedAtPause = h.fired.length;
    h.advance(500, 5);
    assert.equal(h.fired.length, firedAtPause, "nothing fires while paused");

    h.scheduler.resume();
    h.advance(600, 5);
    assert.ok(h.fired.length > firedAtPause, "firing resumes");
    const seqs = h.fired.flatMap((f) => f.actions.map((a) => a.seq));
    assert.ok(seqs.includes(2), "the note after the pause still fires");
  });

  it("rearms on resume even when the next animation frame is delayed", () => {
    const h = harness();
    h.scheduler.load([act(0, 100, "down"), act(1, 900, "down")], 0);
    h.setChart(0); h.scheduler.start(); h.advance(150, 5);
    h.scheduler.pause(); h.advanceTimersOnly(500);
    assert.deepEqual(h.fired.flatMap((batch) => batch.actions.map((action) => action.seq)), [0]);
    h.scheduler.resume(); h.advanceTimersOnly(400);
    assert.deepEqual(h.fired.flatMap((batch) => batch.actions.map((action) => action.seq)), [0, 1]);
    assert.equal(h.fired[1].hostNow, 900);
  });

  it("catches up on overdue actions after a stall", () => {
    const h = harness();
    h.scheduler.load([act(0, 100, "down"), act(1, 120, "down"), act(2, 140, "down")], 0);
    h.setChart(0);
    h.scheduler.start();
    // One big jump: the playhead passes all three at once.
    h.advance(400, 400);
    const seqs = h.fired.flatMap((f) => f.actions.map((a) => a.seq));
    assert.deepEqual(seqs, [0, 1, 2]);
  });

  it("drops rather than jams when an absurd number of actions is overdue", () => {
    const h = harness();
    const timeline: InputAction[] = [];
    for (let i = 0; i < 900; i++) timeline.push(act(i, 10 + i, "down"));
    h.scheduler.load(timeline, 0);
    h.setChart(0);
    h.scheduler.start();
    h.stall(5000);
    h.runFrame();

    assert.ok(h.overruns.length > 0, "should report an overrun");
    assert.ok(h.scheduler.droppedCount > 0, "should count dropped actions");
  });

  for (const first of ["frame", "timer"] as const) {
    it(`continues future notes after a blocked-thread backlog (${first} wakes first)`, () => {
      const h = harness();
      const timeline: InputAction[] = [];
      for (let i = 0; i < 900; i++) timeline.push(act(i, 50 + i, "down"));
      timeline.push(act(900, 2600, "down"), act(901, 2800, "down"));
      h.scheduler.load(timeline, 0);
      h.setChart(0);
      h.scheduler.start();
      h.advance(16, 16); // establish a clock sample and arm the first action
      h.stall(2000); // audio advances but neither timer nor animation callback executes
      if (first === "frame") h.runFrame();
      else h.runDueTask();
      assert.ok(h.scheduler.isRunning, "a lag spike must not complete the chart");
      h.advance(900, 8);
      const seqs = h.fired.flatMap((batch) => batch.actions.map((action) => action.seq));
      assert.ok(seqs.includes(900) && seqs.includes(901), "future actions must remain queued");
      assert.ok(h.overruns.length > 0);
      assert.equal(h.overruns[0].skipped.length, h.overruns[0].dropped);
      assert.ok(h.overruns[0].skipped.every((action) => action.time <= 2016));
      assert.equal(h.scheduler.droppedCount, h.overruns.reduce((n, overrun) => n + overrun.dropped, 0));
      assert.equal(h.completed, 1);
    });
  }

  for (const offset of [-120, 100]) {
    it(`preserves future deadlines with a ${offset}ms offset after a blocked-thread overrun`, () => {
      const h = harness();
      const timeline = Array.from({ length: 900 }, (_, i) => act(i, 150 + i, "down"));
      timeline.push(act(900, 2600, "down"));
      h.scheduler.setActionOffset(offset);
      h.scheduler.load(timeline, 0); h.setChart(0); h.scheduler.start();
      h.advance(16, 16); h.stall(2000); h.runDueTask();
      assert.ok(h.overruns[0].skipped.every((action) => action.time + offset <= h.chart));
      h.advance(900, 8);
      const future = h.fired.find((batch) => batch.actions.some((action) => action.seq === 900));
      assert.ok(future);
      assert.ok(Math.abs(future.hostNow - (2600 + offset)) < 1, `future action at ${future.hostNow}`);
    });
  }

  it("does not fire a queued timer after stop during a blocked-thread stall", () => {
    const h = harness({ ignoreCancel: true });
    h.scheduler.load([act(0, 100, "down"), act(1, 500, "down")], 0);
    h.setChart(0); h.scheduler.start(); h.advance(16, 16);
    h.stall(2000); h.scheduler.stop(); h.runDueTask(); h.runFrame();
    assert.deepEqual(h.fired, []);
    assert.equal(h.scheduler.isRunning, false);
  });

  it("never splits an oversized overdue chord or loses future actions", () => {
    const h = harness();
    const timeline = Array.from({ length: 300 }, (_, i) => act(i, 100, "down", i));
    timeline.push(act(300, 1000, "down"));
    h.scheduler.load(timeline, 0); h.setChart(0); h.scheduler.start();
    h.advance(16, 16); h.stall(200); h.runFrame();
    assert.equal(h.overruns[0]?.dropped, 300);
    assert.equal(h.fired.length, 0, "the oversized chord is skipped as a whole");
    h.advance(900, 8);
    assert.deepEqual(h.fired.flatMap((batch) => batch.actions.map((action) => action.seq)), [300]);
  });

  it("cancels an armed batch when the live timeline is replaced", () => {
    const h = harness();
    h.scheduler.load([act(0, 1000, "down")], 0);
    h.setChart(0);
    h.scheduler.start();
    h.advance(900, 5);
    assert.equal(h.pendingTasks, 1, "the old note is armed");

    h.scheduler.load([act(1, 950, "down")], h.chart);
    assert.equal(h.pendingTasks, 0, "the old timer was canceled");
    h.advance(75, 5);
    assert.deepEqual(h.fired.flatMap((batch) => batch.actions.map((action) => action.seq)), [1]);
    assert.ok(h.fired[0].hostNow <= 955, "the new earlier note was not delayed by the old timer");
    h.scheduler.dispose();
  });

  it("moves an armed deadline earlier when the chart accelerates", () => {
    const h = harness();
    h.scheduler.load([act(0, 1000, "down"), act(1, 1050, "up"), act(2, 1100, "down")], 0);
    h.setChart(0);
    h.scheduler.start();
    h.advance(900, 5);
    assert.equal(h.pendingTasks, 1);
    h.slope = 4;
    h.advance(100, 5);

    assert.deepEqual(h.fired.flatMap((b) => b.actions.map((a) => a.seq)), [0, 1, 2]);
    assert.ok(Math.abs(h.fired[0].hostNow - 925) <= 1, `first note at ${h.fired[0].hostNow}`);
    assert.ok(Math.abs(h.fired[1].hostNow - 937.5) <= 1, `second note at ${h.fired[1].hostNow}`);
    assert.equal(h.scheduler.droppedCount, 0);
  });

  it("rechecks an armed deadline when the chart slows down", () => {
    const h = harness();
    h.scheduler.load([act(0, 1000, "down")], 0);
    h.setChart(0);
    h.scheduler.start();
    h.advance(900, 5);
    h.slope = 0.5;
    h.advance(150, 5);
    assert.equal(h.fired.length, 0, "the original timer must not fire early");
    h.advance(75, 5);
    assert.equal(h.fired.length, 1);
    assert.ok(Math.abs(h.fired[0].hostNow - 1100) <= 1);
  });

  it("does not fire early if an armed deadline loses its clock prediction", () => {
    const h = harness();
    h.scheduler.load([act(0, 1000, "down")], 0);
    h.setChart(0);
    h.scheduler.start();
    h.advance(900, 5);
    assert.equal(h.pendingTasks, 1);
    h.slope = 0.5;
    h.predictionAvailable = false;
    h.advance(110, 5); // old timer wakes at 1000, but chart is only at 950
    assert.equal(h.fired.length, 0);
    h.predictionAvailable = true;
    h.advance(120, 5);
    assert.equal(h.fired.length, 1);
    assert.ok(Math.abs(h.fired[0].hostNow - 1100) <= 1);
  });

  it("cancels an obsolete armed timer when catch-up advances to another note", () => {
    const h = harness();
    h.scheduler.load([act(0, 1000, "down"), act(1, 1010, "up"), act(2, 1020, "down")], 0);
    h.setChart(0);
    h.scheduler.start();
    h.advance(900, 5);
    h.seek(995); // a modest clock jump that is not classified as a seek
    h.advance(30, 10);
    assert.deepEqual(h.fired.flatMap((b) => b.actions.map((a) => a.seq)), [0, 1, 2]);
    assert.ok(h.fired[1].hostNow <= 916, `next note was delayed until ${h.fired[1].hostNow}`);
  });

  it("ignores canceled callbacks that have already entered the browser queue", () => {
    const h = harness({ ignoreCancel: true });
    h.scheduler.load([act(0, 1000, "down"), act(1, 1300, "up")], 0);
    h.setChart(0);
    h.scheduler.start();
    h.advance(900, 5);
    h.slope = 4;
    h.advance(200, 5);
    assert.deepEqual(h.fired.flatMap((b) => b.actions.map((a) => a.seq)), [0, 1]);
    assert.ok(Math.abs(h.fired[1].hostNow - 1000) <= 1, "stale callback must not clear the new timer");
    assert.equal(h.completed, 1);
  });

  it("stop clears the timeline and cancels timers", () => {
    const h = harness();
    h.scheduler.load([act(0, 100, "down"), act(1, 200, "down")], 0);
    h.setChart(0);
    h.scheduler.start();
    h.advance(50, 5);
    h.scheduler.stop();

    assert.equal(h.pendingTasks, 0);
    assert.equal(h.scheduler.total, 0);
    assert.equal(h.scheduler.remaining, 0);
    assert.equal(h.scheduler.isRunning, false);
    h.advance(500, 5);
    assert.equal(h.fired.length, 0, "nothing fires after stop");
  });

  it("halt keeps the timeline but stops firing", () => {
    const h = harness();
    h.scheduler.load([act(0, 100, "down"), act(1, 200, "down")], 0);
    h.setChart(0);
    h.scheduler.start();
    h.scheduler.halt();
    assert.equal(h.scheduler.total, 2);
    assert.equal(h.pendingTasks, 0);
    h.advance(500, 5);
    assert.equal(h.fired.length, 0);
  });

  it("reports completion after the last action", () => {
    const h = harness();
    h.scheduler.load([act(0, 100, "down")], 0);
    h.setChart(0);
    h.scheduler.start();
    h.advance(300, 5);
    assert.equal(h.completed, 1);
    assert.equal(h.scheduler.isRunning, false);
  });

  it("treats a sudden forward chart jump as a seek and rebases", () => {
    const h = harness();
    h.scheduler.load([act(0, 100, "down"), act(1, 200, "down"), act(2, 900, "down")], 0);
    h.setChart(0);
    h.scheduler.start();
    h.advance(60, 5);
    assert.equal(h.fired.length, 0, "nothing due yet");

    // The playhead leaps forward without host time passing: a seek.
    h.seek(850);
    h.advance(120, 5);

    const seqs = h.fired.flatMap((f) => f.actions.map((a) => a.seq));
    assert.ok(!seqs.includes(0), "the note at 100 must not fire after a seek past it");
    assert.ok(!seqs.includes(1), "the note at 200 must not fire after a seek past it");
    assert.ok(seqs.includes(2), "the note at 900 still fires");
  });

  it("rebase moves the cursor to a chart time", () => {
    const h = harness();
    const timeline = [act(0, 100, "down"), act(1, 500, "down"), act(2, 900, "down")];
    h.scheduler.load(timeline, 0);
    assert.equal(h.scheduler.cursorIndex, 0);
    h.scheduler.rebase(600);
    assert.equal(h.scheduler.cursorIndex, 2);
    h.scheduler.rebase(0);
    assert.equal(h.scheduler.cursorIndex, 0);
  });

  it("samples the clock every frame", () => {
    const h = harness();
    h.scheduler.load([act(0, 1000, "down")], 0);
    h.setChart(0);
    h.scheduler.start();
    h.advance(200, 16);
    assert.ok(h.samples.length > 5, `expected regular samples, got ${h.samples.length}`);
    // Samples must be monotonic in host time.
    for (let i = 1; i < h.samples.length; i++) {
      assert.ok(h.samples[i].host >= h.samples[i - 1].host);
    }
  });

  it("invalidates timers armed before a stop", () => {
    const h = harness();
    h.scheduler.load([act(0, 100, "down")], 0);
    h.setChart(0);
    h.scheduler.start();
    h.advance(50, 5); // arms a timer
    const tasksBefore = h.pendingTasks;
    h.scheduler.stop();
    assert.ok(tasksBefore >= 0);
    assert.equal(h.pendingTasks, 0);
  });

  it("tracks remaining and total", () => {
    const h = harness();
    h.scheduler.load([act(0, 100, "down"), act(1, 200, "down"), act(2, 300, "down")], 0);
    assert.equal(h.scheduler.total, 3);
    assert.equal(h.scheduler.remaining, 3);
    h.setChart(0);
    h.scheduler.start();
    h.advance(150, 5);
    assert.equal(h.scheduler.remaining, 2);
  });

  it("dispose is safe to call twice", () => {
    const h = harness();
    h.scheduler.load([act(0, 100, "down")], 0);
    h.scheduler.start();
    h.scheduler.dispose();
    h.scheduler.dispose();
    assert.equal(h.pendingTasks, 0);
  });
});

describe("createFastTask", () => {
  it("runs a delayed task and honours cancellation", async () => {
    const fast = createFastTask();
    const order: string[] = [];

    fast.schedule(() => order.push("a"), 5);
    const cancelled = fast.schedule(() => order.push("b"), 5);
    fast.schedule(() => order.push("c"), 1);
    fast.cancel(cancelled);

    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.deepEqual(order.sort(), ["a", "c"]);
    fast.dispose();
  });

  it("runs a zero-delay task without a timer", async () => {
    const fast = createFastTask();
    let ran = 0;
    fast.schedule(() => ran++, 0);
    // MessageChannel delivery is asynchronous, so yield to the event loop.
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(ran, 1);
    fast.dispose();
  });

  it("uses an asynchronous, cancelable timer when MessageChannel is unavailable", async () => {
    const original = globalThis.MessageChannel;
    try {
      (globalThis as any).MessageChannel = undefined;
      const fast = createFastTask();
      let ran = 0;
      const canceled = fast.schedule(() => ran += 10, 0);
      fast.cancel(canceled);
      fast.schedule(() => ran++, 0);
      assert.equal(ran, 0, "zero-delay fallback must not run synchronously");
      await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(ran, 1);
      fast.dispose();
    } finally {
      globalThis.MessageChannel = original;
    }
  });

  it("keeps running after a task throws", async () => {
    const fast = createFastTask();
    let second = 0;
    fast.schedule(() => {
      throw new Error("boom");
    }, 0);
    fast.schedule(() => second++, 0);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(second, 1, "a throwing task must not wedge the queue");
    fast.dispose();
  });

  it("cancel after delivery is a no-op", async () => {
    const fast = createFastTask();
    let ran = 0;
    const id = fast.schedule(() => ran++, 0);
    await new Promise((resolve) => setTimeout(resolve, 10));
    fast.cancel(id);
    assert.equal(ran, 1);
    fast.dispose();
  });
});
