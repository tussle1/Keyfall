import { buildTimeline, type ChartAnalysis, type Timeline } from "../chart/timeline";
import { DETECT_POLL_INTERVAL } from "../constants";
import {
  acquireGame,
} from "../detect/pixiHook";
import {
  buildContextFromGame,
  buildKeyMapping,
  buildSecondaryMapping,
} from "../detect/buildContext";
import { detectSite, NOT_DETECTED_MESSAGE, type SiteCheck } from "../detect/siteDetection";
import { getLatestChart } from "../detect/chartSource";
import { Guards, verifyInputState } from "./guards";
import { collectStats, notesRemainingAt } from "./stats";
import { ClockMapper } from "../timing/clock";
import { Scheduler } from "../timing/scheduler";
import { DEFAULT_MIN_TAP_HOLD_MS, InputManager } from "../input/InputManager";
import { Humanizer } from "../humanize/humanizer";
import type { HumanizationStats } from "../humanize/humanizer";
import type { SettingsManager } from "../core/settings";
import type {
  DetectionResult,
  EnginePhase,
  EngineStats,
  GameLike,
  InputAction,
  KeyMapping,
  ParsedChart,
  Settings,
} from "../types";
import { Emitter } from "../util/emitter";
import { lowerBound, round } from "../util/helpers";

/**
 * The autoplay engine.
 *
 * Lifecycle:
 *
 *   IDLE -> DETECTING -> READY -> RUNNING <-> PAUSED -> STOPPING -> READY
 *                        |                                    |
 *                        +--------------------------------> ERROR
 *
 * Detection keeps polling on a slow timer (this is the ONLY polling in the
 * tool, and it is for "did a game start/stop", never for notes). Once a game
 * is found, everything is event- and timer-driven.
 */

type PendingStart = "manual" | "automatic" | null;

export interface EngineEvents {
  phase: { phase: EnginePhase; reason?: string };
  pendingStart: { pending: PendingStart };
  detected: { chart: ParsedChart; keyMapping: KeyMapping; analysis: ChartAnalysis; via: string };
  /**
   * The action timeline was rebuilt without a new beatmap being detected —
   * because secondary keybinds or humanization settings changed. Carries the
   * fresh analysis so the UI can update pattern counts mid-run.
   */
  timeline: { analysis: ChartAnalysis; humanization: HumanizationStats | null };
  lost: { reason: string };
  stats: EngineStats;
  keyState: { heldColumns: number[]; keyCount: number; codes: string[] };
  log: { level: "info" | "warn" | "error"; message: string; data?: unknown };
  site: SiteCheck;
}

export interface EngineOptions {
  settings: SettingsManager;
  win?: Window;
}

const SAFE_STOP_MESSAGE = "Autoplay stopped safely.";

/**
 * A comparable fingerprint of the humanization settings.
 *
 * `applySettings` runs on every settings write, and rebuilding the timeline
 * reshuffles every action, so the rebuild must only happen when something that
 * actually affects timing changed. Comparing objects field by field would be
 * easy to get out of sync with the config; a serialised fingerprint cannot.
 */
function humanizationSignature(settings: Settings): string {
  const h = settings.humanization;
  if (!h.enabled) return "off";
  return [
    "on",
    h.seed >>> 0,
    h.strength,
    h.distribution,
    h.shortTermDrift,
    h.longTermDrift,
    h.patternAware,
    h.holdReleaseVariation,
    h.fatigue,
  ].join("|");
}

export class Engine {
  private settingsManager: SettingsManager;
  private win: Window;

  private emitter = new Emitter<EngineEvents>();

  private phase: EnginePhase = "IDLE";
  private siteCheck: SiteCheck | null = null;

  private game: GameLike | null = null;
  private detectedVia = "";
  private chart: ParsedChart | null = null;
  private keyMapping: KeyMapping | null = null;
  private secondaryCodes: (string | null)[] = [];
  private timeline: Timeline | null = null;

  private clock = new ClockMapper();
  private scheduler: Scheduler;
  private input: InputManager;
  private guards: Guards;

  private detectHandle: number | null = null;
  private statsHandle: number | null = null;
  private monitorHandle: number | null = null;
  /** Rebuilt with the timeline; null while humanization is off. */
  private humanizer: Humanizer | null = null;
  /** What the live timeline was built from, so rebuilds are only done when needed. */
  private lastTimelineSecondary = false;
  private lastTimelineHumanization = "";
  private disposed = false;

  /** Consecutive failed input-state verifications. */
  private desyncCount = 0;
  /** Only a pause caused by the game should auto-resume with the game. */
  private pausedBySite = false;
  /** Start requested before the live game reaches PLAY, or by opt-in auto-start. */
  private pendingStart: PendingStart = null;
  private lastAutoStart: boolean;
  private static readonly DESYNC_LIMIT = 6;

  private lastError = "";
  private lastChartSignature = "";
  private lastChartRevision: string | null = null;

  constructor(options: EngineOptions) {
    this.settingsManager = options.settings;
    this.win = options.win ?? window;

    const settings = this.settingsManager.all;
    this.lastAutoStart = settings.general.autoStart;

    this.input = new InputManager({
      target: this.win.document,
      now: () => performance.now(),
      onError: (err) => this.log("error", `input failure: ${String(err)}`),
      onEvent: () => this.emitKeyState(),
    });

    this.scheduler = new Scheduler(
      {
        nowChart: () => this.chartTime(),
        hostTimeFor: (chartTime) => this.hostTimeForChart(chartTime),
        fire: (actions, hostNow, targetChart) => this.onFire(actions, hostNow, targetChart),
        sample: (host, chart) => this.onClockSample(host, chart),
        log: (message) => this.log("info", message),
        onOverrun: (dropped, at, skipped) => this.onOverrun(dropped, at, skipped),
        onComplete: () => this.onChartComplete(),
      },
      {
        lookahead: settings.timing.lookahead,
        spinThreshold: settings.timing.spinThreshold,
        now: () => performance.now(),
        requestFrame: (cb) => this.win.requestAnimationFrame(cb),
        cancelFrame: (h) => this.win.cancelAnimationFrame(h),
      },
    );

    this.guards = new Guards(
      {
        releaseAll: () => this.input.releaseAll(),
        onPanic: (reason) => this.safeStop(reason),
        // No game during song select is normal; only an active run needs the
        // liveness watchdog to panic when gameplay disappears.
        isGameAlive: () => (this.phase !== "RUNNING" && this.phase !== "PAUSED") || this.isGameAlive(),
        chartTime: () => (Number.isFinite(this.chartTime()) ? this.chartTime() : null),
        heldColumns: () => this.input.heldColumns,
        heldSince: () => this.heldSinceChart(),
        pendingReleaseAt: (column) =>
          this.input.pendingTapReleaseAt(column) ?? this.scheduler.nextReleaseAt(column),
        log: (message) => this.log("info", message),
      },
      { win: this.win },
    );
  }

  /* ------------------------------ public ------------------------------ */

  on<K extends keyof EngineEvents>(
    type: K,
    handler: (payload: EngineEvents[K]) => void,
  ): () => void {
    return this.emitter.on(type, handler);
  }

  get currentPhase(): EnginePhase {
    return this.phase;
  }

  get currentChart(): ParsedChart | null {
    return this.chart;
  }

  get currentMapping(): KeyMapping | null {
    return this.keyMapping;
  }

  get currentAnalysis(): ChartAnalysis | null {
    return this.timeline?.analysis ?? null;
  }

  get currentGame(): GameLike | null {
    return this.game;
  }

  get currentSiteCheck(): SiteCheck | null {
    return this.siteCheck;
  }

  get lastErrorMessage(): string {
    return this.lastError;
  }

  /** Boot: check the site, install guards, start detection. */
  init(): void {
    if (this.disposed) return;

    this.siteCheck = detectSite(this.win);
    this.emitter.emit("site", this.siteCheck);

    if (this.siteCheck.verdict === "unknown") {
      this.log("warn", NOT_DETECTED_MESSAGE);
      this.setPhase("IDLE");
      // Keep a very slow poll so navigating to the site in the same tab works.
      this.startDetectionLoop(DETECT_POLL_INTERVAL * 4);
      return;
    }

    this.guards.install();
    this.startDetectionLoop(DETECT_POLL_INTERVAL);
    this.tryDetect();
    this.setPhase(this.phase === "IDLE" ? "DETECTING" : this.phase);
    this.log("info", `${this.siteCheck.message} — detection active`);
  }

  /** Start autoplay on the detected chart. */
  start(): void {
    if (this.disposed) return;
    if (!this.settingsManager.all.general.enabled) {
      this.log("warn", "Autoplay is disabled. Enable it in the Keyfall panel first.");
      return;
    }

    if (this.phase === "RUNNING") return;
    if (this.phase === "PAUSED") {
      this.resume();
      return;
    }

    const detection = this.ensureDetected();
    if (!detection?.ok) {
      if (this.phase !== "ERROR") {
        this.setPendingStart("manual");
        this.setPhase("DETECTING");
        this.log("info", "Autoplay armed — waiting for a playable chart");
      } else {
        this.log("warn", detection?.reason ?? this.lastError);
      }
      return;
    }
    // Detection can itself start an already-armed session.
    if (this.scheduler.isRunning) return;
    if (this.game?.state !== "PLAY") {
      // Emergency stop can leave an already-detected chart in IDLE; restore
      // READY so the state monitor can start it when playback becomes possible.
      this.setPhase("READY");
      // An explicit Start remains armed even if the auto-start option is later disabled.
      this.setPendingStart("manual");
      this.log("info", "Autoplay armed — waiting for gameplay to start or resume");
      return;
    }
    this.setPendingStart(null);

    try {
      this.buildTimeline();
    } catch (err) {
      this.fail(`Could not build the note timeline: ${(err as Error).message}`);
      return;
    }

    if (!this.timeline || this.timeline.actions.length === 0) {
      this.fail("The chart contains no playable notes.");
      return;
    }

    const settings = this.settingsManager.all;
    this.input.setMapping(this.keyMapping!, this.secondaryCodes);
    this.clock.hardReset();

    // Begin from wherever the playhead already is, so starting mid-song does
    // not fire every note that has already scrolled past.
    const now = this.chartTime();
    this.scheduler.setOptions(settings.timing.lookahead, settings.timing.spinThreshold);
    this.scheduler.setActionOffset(this.effectiveOffset(settings));
    // Ashtonk's lead-in can put its judgement clock below zero. Preserve it:
    // a negative offset may make the opening note due before chart time zero.
    this.scheduler.load(this.timeline.actions, now);
    this.scheduler.start();

    this.startStatsLoop();
    this.startStateMonitor();
    this.setPhase("RUNNING");
    this.log(
      "info",
      `started — ${this.timeline.actions.length} actions, ${this.timeline.noteCount} notes, ${this.chart!.keyCount}K`,
    );
  }

  /** Pause: stop scheduling, release keys, keep chart position. */
  pause(): void {
    if (this.disposed || this.phase !== "RUNNING") return;

    this.pausedBySite = false;
    this.scheduler.pause();
    // Release held keys so nothing sticks while paused. Chart position is
    // preserved: `resume()` rebases the cursor against the live clock.
    const released = this.input.releaseAll();
    this.setPhase("PAUSED");
    this.log("info", `paused (released ${released} held key(s); position preserved)`);
  }

  /** Resume from the correct timing position. */
  resume(): void {
    if (this.disposed || this.phase !== "PAUSED" || !this.settingsManager.all.general.enabled) return;

    if (!this.isGameAlive()) {
      this.safeStop("Gameplay ended while paused");
      return;
    }
    if (this.chartChanged()) {
      // Rebind before honoring a resume if the site's chart was replaced.
      this.pausedBySite = true;
      this.tryDetect();
      return;
    }
    if (this.game?.state !== "PLAY") {
      // WAIT, PAUSE and UNPAUSE cannot accept lane input. Resume only after
      // the loader or the site's pause countdown reaches playable state.
      this.pausedBySite = true;
      this.log("info", "waiting for the game to resume");
      return;
    }
    this.pausedBySite = false;

    // The site may have been paused too; re-read the clock before rebasing.
    this.clock.reset();
    const now = this.chartTime();
    this.scheduler.rebase(now);
    this.scheduler.resume();
    this.setPhase("RUNNING");
    this.log("info", `resumed at ${now.toFixed(1)}ms`);
  }

  /** Normal stop: release everything, clear the queue, stay detected. */
  stop(): void {
    if (this.disposed) return;
    this.setPendingStart(null);
    this.teardownRun("stopped");
    this.setPhase(this.chart ? "READY" : "DETECTING");
    this.log("info", "stopped");
  }

  /**
   * Emergency stop. Immediate, unconditional, and total: stop scheduling,
   * release every key, clear the queue, reset engine state.
   */
  emergencyStop(reason = "EMERGENCY STOP"): void {
    if (this.disposed) return;
    this.setPendingStart(null);
    this.scheduler.stop();
    this.input.releaseAll();
    this.stopStatsLoop();
    this.stopStateMonitor();
    this.clock.hardReset();
    this.desyncCount = 0;
    this.timeline = null;
    this.pausedBySite = false;
    this.setPhase("IDLE");
    this.lastError = "";
    this.emitter.emit("phase", { phase: "IDLE", reason });
    this.log("warn", `${reason} — ${SAFE_STOP_MESSAGE}`);
    // Re-arm detection so the tool is usable again without a reload.
    this.startDetectionLoop(DETECT_POLL_INTERVAL);
  }

  /**
   * Combined timing shift, in ms.
   *
   * `offset` is the user's musical correction (negative = fire earlier).
   * `inputDelayCompensation` is subtracted for the same reason: a positive
   * compensation means "my input arrives late", so the action must be scheduled
   * earlier.
   */
  private effectiveOffset(settings: Settings): number {
    return settings.timing.offset - settings.timing.inputDelayCompensation;
  }

  /** Apply a settings change to the live engine. */
  applySettings(settings: Settings): void {
    const autoStartChanged = settings.general.autoStart !== this.lastAutoStart;
    this.lastAutoStart = settings.general.autoStart;
    if (!settings.general.enabled || (autoStartChanged && !settings.general.autoStart && this.pendingStart === "automatic")) {
      this.setPendingStart(null);
    }
    // The master switch is a real safety control, not just a cosmetic toggle.
    // Disabling it during a run must immediately stop and release every key.
    if (!settings.general.enabled && (this.phase === "RUNNING" || this.phase === "PAUSED")) {
      this.stop();
      this.log("info", "autoplay disabled — keys released");
    }
    this.scheduler.setOptions(settings.timing.lookahead, settings.timing.spinThreshold);
    // Applied whether or not a run is active, so a mid-run slider drag takes
    // effect on the next note rather than the next session.
    const offset = this.effectiveOffset(settings);
    const offsetChanged = offset !== this.scheduler.actionTimeOffset;
    this.scheduler.setActionOffset(offset);
    let timelineReloaded = false;
    if (this.keyMapping) {
      this.input.setMapping(this.keyMapping, this.secondaryCodes);
    }
    // Secondary keybinds change the action set, and humanization changes every
    // action's timestamp, so either requires a rebuild. Compare against the
    // signature of what the current timeline was built with rather than
    // rebuilding on every settings write — a slider drag elsewhere would
    // otherwise reshuffle the whole chart mid-run.
    const needsRebuild =
      (settings.input.useSecondaryKeybind && this.lastTimelineSecondary !== true) ||
      (!settings.input.useSecondaryKeybind && this.lastTimelineSecondary === true) ||
      humanizationSignature(settings) !== this.lastTimelineHumanization;

    if (needsRebuild && this.chart && this.keyMapping) {
      this.lastTimelineSecondary = settings.input.useSecondaryKeybind;
      this.lastTimelineHumanization = humanizationSignature(settings);
      try {
        this.buildTimeline();
        if ((this.phase === "RUNNING" || this.phase === "PAUSED") && this.timeline) {
          // Reload from the current playhead so upcoming notes pick up the new
          // settings, including changes made while manually paused.
          this.scheduler.load(this.timeline.actions, this.chartTime());
          timelineReloaded = true;
        }
        const rebuilt = this.timeline!;
        this.emitter.emit("timeline", {
          analysis: rebuilt.analysis,
          humanization: this.humanizationStats,
        });
      } catch (err) {
        this.log("error", `timeline rebuild failed: ${(err as Error).message}`);
      }
    }
    if (this.phase === "RUNNING" && this.timeline && (offsetChanged || timelineReloaded)) {
      const released = this.input.reconcileHeld(this.timeline.actions, this.chartTime(), offset);
      if (released) this.log("info", `released ${released} key(s) whose release moved behind the playhead`);
    }
    if (autoStartChanged && settings.general.autoStart && settings.general.enabled && this.phase === "READY") {
      if (!this.pendingStart) this.setPendingStart("automatic");
      this.maybeStartPending();
    }
  }

  /** Apply a mapping edit immediately, even when the chart itself is unchanged. */
  refreshMapping(): void {
    if (this.disposed) return;
    if (!this.game || !this.chart || !this.isGameAlive()) {
      this.tryDetect();
      return;
    }
    // Never swap key identities underneath an active hold.
    if (this.phase === "RUNNING" || this.phase === "PAUSED") this.stop();
    this.keyMapping = buildKeyMapping(this.game, this.chart.keyCount, this.settingsManager.all);
    this.secondaryCodes = buildSecondaryMapping(this.game, this.chart.keyCount);
    this.input.setMapping(this.keyMapping, this.secondaryCodes);
    try {
      this.buildTimeline();
      this.emitter.emit("detected", {
        chart: this.chart,
        keyMapping: this.keyMapping,
        analysis: this.timeline!.analysis,
        via: this.detectedVia,
      });
    } catch (err) {
      this.fail(`Mapping update failed: ${(err as Error).message}`);
    }
  }

  /** Full teardown: every listener, timer and held key. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.teardownRun("disposed");
    this.guards.dispose();
    this.stopDetectionLoop();
    this.stopStateMonitor();
    this.input.dispose();
    this.scheduler.dispose();
    this.emitter.dispose();
    this.settingsManager.dispose();
  }

  /* ----------------------------- detection ---------------------------- */

  private startDetectionLoop(interval: number): void {
    this.stopDetectionLoop();
    this.detectHandle = setInterval(() => this.tryDetect(), interval) as unknown as number;
  }

  private stopDetectionLoop(): void {
    if (this.detectHandle !== null) {
      clearInterval(this.detectHandle);
      this.detectHandle = null;
    }
  }

  /** Number of live timers, for diagnostics and teardown verification. */
  get activeTimerCount(): number {
    return (
      (this.detectHandle !== null ? 1 : 0) +
      (this.statsHandle !== null ? 1 : 0) +
      (this.monitorHandle !== null ? 1 : 0)
    );
  }

  private tryDetect(): void {
    if (this.disposed) return;

    // Re-check the site occasionally: SPA navigation can change the verdict.
    if (!this.siteCheck || this.siteCheck.verdict === "unknown") {
      this.siteCheck = detectSite(this.win);
      this.emitter.emit("site", this.siteCheck);
      if (this.siteCheck.verdict === "unknown") return;
      this.guards.install();
    }

    const acquired = acquireGame(this.win);

    if (!acquired) {
      // Game closed / results screen / song select.
      if (this.game) {
        const reason = "Gameplay closed";
        // A manual start for a prepared chart must not transfer to an
        // unrelated chart if the user backs out before playback begins.
        this.setPendingStart(null);
        this.teardownRun(reason);
        this.game = null;
        this.chart = null;
        this.timeline = null;
        this.keyMapping = null;
        this.lastChartSignature = "";
        this.lastChartRevision = null;
        this.setPhase("DETECTING");
        this.emitter.emit("lost", { reason });
        this.log("info", reason);
      }
      return;
    }

    const isNewInstance = acquired.game !== this.game;
    const settings = this.settingsManager.all;
    // Detection runs every 700ms. Adapters with a cheap revision and full
    // signature can verify an unchanged chart without converting and sorting
    // it again. Generic sites must still rebuild their fallback fingerprint.
    if (!isNewInstance && this.lastChartRevision !== null && this.chart && this.keyMapping &&
        this.phase !== "DETECTING" && this.isGameAlive()) {
      const revision = acquired.game.chartRevision;
      const signature = acquired.game.chartSignature;
      if (revision === this.lastChartRevision && typeof signature === "string" &&
          signature.length > 0 && signature === this.lastChartSignature) {
        if (this.phase === "ERROR") this.setPhase("READY");
        return;
      }
    }
    const result: DetectionResult = buildContextFromGame(acquired.game, settings, acquired.via);

    if (!result.ok) {
      // Do not carry an armed start past a refused/broken chart. An opt-in
      // automatic start will be armed again for the next valid chart.
      this.setPendingStart(null);
      if (this.phase === "RUNNING" || this.phase === "PAUSED") {
        this.safeStop(result.reason ?? "Detection lost");
      } else {
        this.game = acquired.game;
        this.detectedVia = acquired.via;
        this.lastError = result.reason ?? "";
        // Stale chart/mapping must not survive an unsupported or broken session.
        // Otherwise `ensureDetected()` could start a run that just failed.
        this.chart = null;
        this.timeline = null;
        this.keyMapping = null;
        this.lastChartSignature = "";
        this.lastChartRevision = null;
        this.setPhase("ERROR", result.reason ?? "Detection incomplete");
      }
      this.log("warn", result.reason ?? "Detection incomplete");
      return;
    }

    const chart = result.chart!;
    const mapping = result.keyMapping!;
    const signatureChanged = chart.signature !== this.lastChartSignature;
    const revision = acquired.game.chartRevision;
    const revisionChanged = this.lastChartRevision !== null && typeof revision === "string" &&
      revision !== this.lastChartRevision;

    if (!isNewInstance && !signatureChanged && !revisionChanged && this.phase !== "DETECTING") {
      // Same game, same chart: nothing to do. This is the cheap path that runs
      // on every poll, so it must not re-parse anything.
      this.game = acquired.game;
      if (this.phase === "ERROR") this.setPhase("READY");
      return;
    }

    // --- New beatmap (or first detection) ------------------------------
    // A manual start already tied to a prepared chart must not transfer to a
    // different chart if the site replaces it without an intervening close.
    if (signatureChanged && this.lastChartSignature && this.phase === "READY" && this.pendingStart === "manual") {
      this.setPendingStart(null);
    }
    const manuallyPaused = this.phase === "PAUSED" && !this.pausedBySite;
    const continueRunning = this.phase === "RUNNING" || (this.phase === "PAUSED" && this.pausedBySite);
    if (continueRunning || this.phase === "PAUSED") {
      // A retry or practice seek can replace the live game/engine even when
      // the chart looks identical. Release the old run before rebinding.
      this.log("info", "Gameplay chart changed — rebuilding autoplay session");
      this.teardownRun("beatmap changed");
    }

    this.game = acquired.game;
    this.detectedVia = acquired.via;
    this.chart = chart;
    this.keyMapping = mapping;
    this.secondaryCodes = buildSecondaryMapping(acquired.game, chart.keyCount);
    this.lastChartSignature = chart.signature;
    this.lastChartRevision = typeof revision === "string" && revision.length > 0 ? revision : null;
    this.lastError = "";
    this.clock.hardReset();

    // Build the timeline once here so START is instant and so we can report
    // the analysis in the UI. Rebuilding is cheap but we still avoid doing it
    // more than once per beatmap.
    try {
      this.buildTimeline();
    } catch (err) {
      this.fail(`Timeline build failed: ${(err as Error).message}`);
      return;
    }

    this.input.setMapping(mapping, this.secondaryCodes);
    this.startStateMonitor();
    this.setPhase("READY");
    this.emitter.emit("detected", {
      chart,
      keyMapping: mapping,
      analysis: this.timeline!.analysis,
      via: acquired.via,
    });
    this.log(
      "info",
      `chart detected via ${acquired.via}: ${chart.keyCount}K, ${chart.noteCount} notes, ${this.timeline!.actions.length} actions`,
    );
    // Keep an explicitly started run going across an in-game retry/seek. An
    // explicitly paused session stays paused; auto-start is separately opt-in.
    if (continueRunning) this.setPendingStart("manual");
    else if (settings.general.enabled && settings.general.autoStart && !manuallyPaused && !this.pendingStart) {
      this.setPendingStart("automatic");
    }
    this.maybeStartPending();
  }

  private maybeStartPending(): void {
    if (!this.pendingStart || !this.settingsManager.all.general.enabled ||
        this.phase !== "READY" || this.game?.state !== "PLAY") return;
    this.start();
  }

  private ensureDetected(): DetectionResult | null {
    if (this.game && this.chart && this.keyMapping && this.isGameAlive()) {
      return { ok: true, via: this.detectedVia, game: this.game, chart: this.chart, keyMapping: this.keyMapping };
    }
    this.tryDetect();
    if (
      !this.game ||
      !this.chart ||
      !this.keyMapping ||
      !this.isGameAlive() ||
      this.phase === "ERROR"
    ) {
      // Last resort: a chart captured from the network but no live game. We can
      // describe it but cannot time against it, so report honestly.
      const fallback = getLatestChart();
      if (fallback && !this.chart) {
        this.log("warn", "A beatmap was seen on the network but gameplay is not live yet.");
      }
      return null;
    }
    return { ok: true, via: this.detectedVia, game: this.game, chart: this.chart, keyMapping: this.keyMapping };
  }

  private buildTimeline(): void {
    if (!this.chart || !this.keyMapping) {
      throw new Error("no chart or key mapping available");
    }
    const settings = this.settingsManager.all;

    // Humanization is baked into the timeline rather than applied at fire time,
    // because it has to survive the ordering sort: chords must stay together and
    // same-column order must not invert. That means a change to any of its
    // settings requires a rebuild — see `applySettings`.
    this.humanizer = settings.humanization.enabled
      ? new Humanizer({
          config: settings.humanization,
          // Must match the InputManager's deferral: the humanizer clamps the
          // next same-column press against it, so a disagreement between the two
          // would let a release and a press swap places.
          minTapHoldMs: DEFAULT_MIN_TAP_HOLD_MS,
        })
      : null;

    this.timeline = buildTimeline(this.chart, {
      keyMapping: this.keyMapping,
      useSecondaryKeybind: settings.input.useSecondaryKeybind,
      secondaryCodes: this.secondaryCodes,
      humanizer: this.humanizer,
      // Offset is applied at *schedule* time rather than baked into the
      // timeline, so changing it mid-run takes effect immediately without a
      // rebuild. Kept at 0 here on purpose.
      offset: 0,
    });

    this.lastTimelineSecondary = settings.input.useSecondaryKeybind;
    this.lastTimelineHumanization = humanizationSignature(settings);

    if (this.humanizer) {
      const stats = this.humanizer.stats;
      this.log(
        "info",
        `humanization on · seed ${settings.humanization.seed} · strength ${settings.humanization.strength} · ` +
          `mean ${stats.meanMs.toFixed(2)}ms · sd ${stats.sdMs.toFixed(2)}ms · clamped ${stats.clamped}`,
      );
    }
  }

  /** Humanization statistics for the current timeline, or null when off. */
  get humanizationStats(): HumanizationStats | null {
    return this.humanizer?.stats ?? null;
  }

  /* ------------------------------- clock ------------------------------ */

  /**
   * Current chart time in ms.
   *
   * Reads the site's own playhead. Falls back to the fitted clock model when
   * the property is momentarily unreadable, and to 0 before a game exists.
   */
  private chartTime(): number {
    const game = this.game;
    if (game) {
      const direct = game.timeElapsed;
      if (typeof direct === "number" && Number.isFinite(direct)) return direct;

      const seek = game.song?.seek?.();
      if (typeof seek === "number" && Number.isFinite(seek)) return seek * 1000;
    }
    return this.clock.chartAt(performance.now());
  }

  /**
   * Predict the host time at which a chart time occurs.
   *
   * The timing offset is deliberately NOT applied here: the scheduler applies
   * it to the action's effective due time instead, so that the armed-timer
   * path and the catch-up path agree. Applying it in both places would double
   * it; applying it only here would make the offset silently vanish whenever a
   * note is fired by catch-up.
   */
  private hostTimeForChart(chartTime: number): number {
    const now = performance.now();
    // Some sites expose the same read-only clock they use to judge an input at
    // an arbitrary event timestamp. Its instantaneous slope responds to speed
    // changes immediately; a regression over older frames would lag behind.
    try {
      const clockAt = this.game?.chartTimeAtHost;
      if (clockAt) {
        const current = clockAt.call(this.game, now);
        const ahead = clockAt.call(this.game, now + 100);
        if (current !== null && ahead !== null) {
          const slope = (ahead - current) / 100;
          if (Number.isFinite(current) && Number.isFinite(slope) && slope >= 0.05 && slope <= 8) {
            return now + (chartTime - current) / slope;
          }
        }
      }
    } catch {
      // A changing/older site API must not prevent the fitted-clock fallback.
    }

    const predicted = this.clock.hostAt(chartTime);
    // Before the model is fitted, `hostAt` can return nonsense (it is anchored
    // on a single sample). Clamp the result so we never arm a timer in the far
    // past or far future.
    const state = this.clock.getState();
    if (!state.confident) {
      const lookahead = this.settingsManager.all.timing.lookahead;
      return Math.min(Math.max(predicted, now), now + lookahead * 2);
    }
    return predicted;
  }

  /**
   * Feed the clock model and tell the scheduler where to be.
   *
   * Returning a chart time asks the scheduler to resync its cursor to it. Only
   * the clock model can distinguish a seek from a frame stall (it sees both
   * samples), so the decision is made here and the *action* is taken by the
   * scheduler, which owns the cursor.
   */
  private onClockSample(host: number, chart: number): number | void {
    const discontinuity = this.clock.sample(host, chart);
    if (!discontinuity) return;

    this.log("info", `clock discontinuity at ${chart.toFixed(1)}ms — resyncing`);
    if (this.phase === "RUNNING" && this.timeline) {
      // A seek can jump past the tail of a held key. Releasing only keys whose
      // next action is no longer their tail prevents both stuck keys and a
      // suppressed press on the same column, while preserving ongoing holds.
      const released = this.input.reconcileHeld(this.timeline.actions, chart, this.scheduler.actionTimeOffset);
      if (released) this.log("info", `released ${released} key(s) after clock resync`);
    }
    // Resync even while paused, so a seek during pause leaves the cursor in the
    // right place for the eventual resume.
    return chart;
  }

  /* ------------------------------- firing ----------------------------- */

  private onFire(actions: InputAction[], _hostNow: number, targetChartTime: number): void {
    if (this.phase !== "RUNNING") return;
    if (!this.settingsManager.all.general.enabled) {
      this.stop();
      return;
    }
    if (!this.isGameAlive()) {
      const policy = this.game?.unsupportedReason;
      this.safeStop(
        typeof policy === "string" && policy.length > 0 ? policy : "Gameplay ended",
      );
      return;
    }

    const game = this.game;
    // An adapter can notice a replaced engine between detection polls. Never
    // send an old chart's batch into the replacement; the monitor will rebind.
    if (this.chartChanged(true)) {
      this.pauseForSite();
      return;
    }
    // Only drive input while the site is actually playing. During WAIT the
    // site ignores column hits; during PAUSE/FAIL firing would be wrong.
    if (game && game.state !== "PLAY") {
      if (game.state === "WAIT" || game.state === "PAUSE" || game.state === "UNPAUSE") {
        this.pauseForSite();
      } else if (game.state === "FAIL") {
        // The play failed, typically with a hold still down. Release and stop
        // here rather than waiting for the watchdog: this runs on the firing
        // path, so it reacts within a frame instead of after several hundred
        // milliseconds of a key being pinned.
        this.input.releaseAll();
        this.scheduler.stop();
        this.stopStatsLoop();
        this.setPhase("ERROR", "Play failed");
        this.log("warn", "Play failed — keys released. Autoplay stopped safely.");
      }
      return;
    }

    try {
      this.input.applyActions(actions, targetChartTime);
    } catch (err) {
      this.input.releaseAll();
      this.fail(`Input failure: ${(err as Error).message}`);
      return;
    }

    this.verifyAgainstSite();
    this.maybeEmitStats();
  }

  /**
   * Cross-check our held state against the site's own `pressedColumns`.
   * A persistent mismatch means our keybinds no longer match the site's, so we
   * stop rather than play garbage.
   */
  private verifyAgainstSite(): void {
    const held = new Set(this.input.heldColumns);
    const result = verifyInputState(this.game, held);

    if (result.ok) {
      this.desyncCount = 0;
      return;
    }

    // A column the site thinks is down but we don't is expected transiently for
    // taps (we defer the release by a few ms), so only escalate on repeats.
    this.desyncCount++;
    if (this.desyncCount >= Engine.DESYNC_LIMIT) {
      this.desyncCount = 0;
      this.input.releaseAll();
      this.fail(
        `Input state desynced from the game (site holds columns [${result.stuckInSite.join(", ")}]). ` +
          `Keybinds may have changed — reconfigure the mapping and restart.`,
      );
    }
  }

  private onOverrun(dropped: number, atChartTime: number, skipped: readonly InputAction[]): void {
    const released = this.input.releaseSkipped(skipped, atChartTime);
    this.log(
      "warn",
      `skipped ${dropped} overdue action(s) after a stall at ${atChartTime.toFixed(0)}ms; ` +
        `released ${released} key(s) and continued with the remaining chart`,
    );
    this.maybeEmitStats();
  }

  private onChartComplete(): void {
    this.input.releaseAll();
    this.stopStatsLoop();
    // The state monitor deliberately keeps running: the play can still fail or
    // be closed after the last action, and the site moves to its results
    // screen asynchronously.
    this.emitStats(true);
    this.setPhase("READY");
    this.log("info", "chart complete — all actions fired");
  }

  /* --------------------------- state monitor --------------------------- */

  /**
   * Fast, always-on check that the site is still in a state where driving input
   * is correct.
   *
   * This cannot live only on the firing path: if the play fails or the game is
   * closed at a moment when no action is due, nothing would fire and the
   * condition would go unnoticed while a key stays pinned. The guards watchdog
   * does catch it, but only after several probes — too slow for a stuck key.
   */
  private startStateMonitor(): void {
    this.stopStateMonitor();
    this.monitorHandle = setInterval(() => this.checkSiteState(), 100) as unknown as number;
  }

  private stopStateMonitor(): void {
    if (this.monitorHandle !== null) {
      clearInterval(this.monitorHandle);
      this.monitorHandle = null;
    }
  }

  private checkSiteState(): void {
    if (this.disposed) return;
    if (this.phase !== "RUNNING" && this.phase !== "PAUSED" && this.phase !== "READY") {
      return;
    }

    if (!this.isGameAlive()) {
      // A pending start belongs to the current prepared session; a failed,
      // closed or incompatible session must not leave it armed for another.
      this.setPendingStart(null);
      const policy = this.game?.unsupportedReason;
      if (typeof policy === "string" && policy.length > 0) {
        this.lastError = policy;
        this.input.releaseAll();
        this.scheduler.stop();
        this.stopStatsLoop();
        this.setPhase("ERROR", policy);
        this.log("warn", policy);
        return;
      }
      const state = this.game?.state;
      if (state === "FAIL") {
        this.input.releaseAll();
        this.scheduler.stop();
        this.stopStatsLoop();
        this.setPhase("ERROR", "Play failed");
        this.log("warn", "Play failed — keys released. Autoplay stopped safely.");
      } else if (this.phase === "READY") {
        // Not an error: the user finished the map or backed out to song
        // selection. Drop the stale game so the next one is detected fresh.
        this.input.releaseAll();
        this.game = null;
        this.chart = null;
        this.timeline = null;
        this.keyMapping = null;
        this.lastChartSignature = "";
        this.lastChartRevision = null;
        this.setPhase("DETECTING");
        this.emitter.emit("lost", { reason: "Gameplay closed" });
      } else {
        this.safeStop("Gameplay ended");
      }
      return;
    }

    // The adapter supplies an identity that changes on a retry/seek, even if
    // the surrounding game object is reused. Check before resuming or firing
    // against a newly prepared chart rather than waiting for the slower poll.
    if (this.chartChanged()) {
      this.tryDetect();
      return;
    }
    const state = this.game?.state;
    if (state === "PLAY" && this.phase === "READY" && this.pendingStart) {
      this.maybeStartPending();
      return;
    }
    if (state === "WAIT" || state === "PAUSE" || state === "UNPAUSE") {
      if (this.phase === "RUNNING") this.pauseForSite();
    } else if (state === "PLAY" && this.phase === "PAUSED" && this.pausedBySite && this.game) {
      // The site resumed on its own (e.g. the user unpaused in-game).
      this.resume();
    }
  }

  /* ------------------------------- stats ------------------------------ */

  private startStatsLoop(): void {
    this.stopStatsLoop();
    // Slow, fixed-rate readout. The UI also refreshes on key state changes.
    this.statsHandle = setInterval(() => this.emitStats(false), 100) as unknown as number;
  }

  private stopStatsLoop(): void {
    if (this.statsHandle !== null) {
      clearInterval(this.statsHandle);
      this.statsHandle = null;
    }
  }

  private statsDirty = false;
  private maybeEmitStats(): void {
    this.statsDirty = true;
  }

  private emitStats(_force: boolean): void {
    this.statsDirty = false;
    if (!this.chart || !this.timeline) return;

    const chartTime = this.chartTime();
    const jitter = this.scheduler.getJitter();
    const remaining = notesRemainingAt(this.timeline.notePressTimes, chartTime);

    const stats = collectStats({
      game: this.game,
      notesTotal: this.timeline.noteCount,
      notesRemaining: remaining,
      actionsFired: this.scheduler.firedCount,
      pressesDown: this.input.dispatchedDown,
      releasesUp: this.input.dispatchedUp,
      timeElapsed: chartTime,
      lastJitter: jitter.last,
      avgJitter: jitter.avg,
    });

    this.emitter.emit("stats", stats);
  }

  getStats(): EngineStats | null {
    if (!this.chart || !this.timeline) return null;
    const chartTime = this.chartTime();
    const jitter = this.scheduler.getJitter();
    return collectStats({
      game: this.game,
      notesTotal: this.timeline.noteCount,
      notesRemaining: notesRemainingAt(this.timeline.notePressTimes, chartTime),
      actionsFired: this.scheduler.firedCount,
      pressesDown: this.input.dispatchedDown,
      releasesUp: this.input.dispatchedUp,
      timeElapsed: chartTime,
      lastJitter: jitter.last,
      avgJitter: jitter.avg,
    });
  }

  /** Chart time of the next un-fired action, for the debug readout. */
  getNextAction(): InputAction | null {
    if (!this.timeline) return null;
    const index = this.scheduler.cursorIndex;
    return this.timeline.actions[index] ?? null;
  }

  /** Index of the action at/after a chart time (binary search). */
  actionIndexAt(chartTime: number): number {
    if (!this.timeline) return 0;
    return lowerBound(this.timeline.actions, chartTime, (a) => a.time);
  }

  /* ------------------------------ teardown ---------------------------- */

  private isGameAlive(): boolean {
    const game = this.game;
    if (!game) return false;

    // The site nulls `__PIXI_APP__` on dispose and destroys the canvas with
    // `removeView: true`, so a detached canvas is a reliable death signal.
    const pixiApp = (this.win as any).__PIXI_APP__;
    if (pixiApp) {
      const canvas = pixiApp.canvas ?? pixiApp.view;
      if (canvas instanceof Element && !canvas.isConnected) return false;
    }

    // A site adapter's input conflict (e.g. a replay or Auto feed) is
    // terminal for this live session.
    const unsupported = game.unsupportedReason;
    if (typeof unsupported === "string" && unsupported.length > 0) return false;

    // FAIL is a real end-of-play state; treat the run as over.
    if (game.state === "FAIL") return false;

    // Some adapters would allocate a whole converted chart on each getter read.
    // Prefer their cheap presence probe, retaining the generic site's fallback.
    const present = game.hasHitObjects;
    if (typeof present === "boolean") return present;
    const objects = game.hitObjects;
    return Array.isArray(objects) && objects.length > 0;
  }

  /**
   * Check cheap replacement identity on the firing path; the 100ms monitor
   * also checks the full fingerprint for in-place mutations. Adapters without
   * a revision keep the original full-signature behavior.
   */
  private chartChanged(fast = false): boolean {
    const game = this.game;
    if (!game || !this.lastChartSignature) return false;
    const revision = game.chartRevision;
    if (typeof revision === "string" && revision.length > 0 && this.lastChartRevision !== null) {
      if (revision !== this.lastChartRevision) return true;
      if (fast) return false;
    }
    const signature = game.chartSignature;
    return typeof signature === "string" && signature.length > 0 && signature !== this.lastChartSignature;
  }

  /** Suspend scheduling and release keys while the site cannot accept input. */
  private pauseForSite(): void {
    if (this.phase !== "RUNNING") return;
    this.input.releaseAll();
    this.scheduler.pause();
    this.pausedBySite = true;
    this.setPhase("PAUSED");
    this.log("info", "site not playable or chart changed — autoplay paused");
  }

  /** Chart time at which each currently-held column was pressed. */
  private heldSinceChart(): Map<number, number> {
    // Delegated to InputManager, which owns the real press timestamps.
    return this.input.heldSinceChart();
  }

  private teardownRun(reason: string): void {
    this.scheduler.halt();
    this.input.releaseAll();
    this.stopStatsLoop();
    this.stopStateMonitor();
    this.desyncCount = 0;
    this.pausedBySite = false;
    this.log("info", `run torn down: ${reason}`);
  }

  private setPhase(phase: EnginePhase, reason?: string): void {
    if (this.phase === phase) return;
    this.phase = phase;
    this.emitter.emit("phase", { phase, reason });
  }

  private setPendingStart(pending: PendingStart): void {
    if (this.pendingStart === pending) return;
    this.pendingStart = pending;
    // Stop/emergency shut down the monitor. Re-arming an already prepared
    // chart must restart it, or the transition from WAIT to PLAY is missed.
    if (pending && this.game && this.chart) this.startStateMonitor();
    this.emitter.emit("pendingStart", { pending });
  }

  private fail(message: string): void {
    this.setPendingStart(null);
    this.lastError = message;
    this.teardownRun(message);
    this.setPhase("ERROR", message);
    this.log("error", `${message} ${SAFE_STOP_MESSAGE}`);
  }

  /** Unconditional safe shutdown, used by every guard. */
  private safeStop(reason: string): void {
    this.setPendingStart(null);
    this.lastError = reason;
    this.scheduler.stop();
    this.input.releaseAll();
    this.stopStatsLoop();
    this.stopStateMonitor();
    this.desyncCount = 0;
    this.setPhase("ERROR", reason);
    this.log("warn", `${reason}. ${SAFE_STOP_MESSAGE}`);
  }

  private emitKeyState(): void {
    if (!this.keyMapping) return;
    this.emitter.emit("keyState", {
      heldColumns: this.input.heldColumns,
      keyCount: this.keyMapping.keyCount,
      codes: this.keyMapping.codes,
    });
  }

  private log(level: "info" | "warn" | "error", message: string, data?: unknown): void {
    this.emitter.emit("log", { level, message, data });
  }

  /** Diagnostics snapshot for the debug panel. */
  getDiagnostics(): Record<string, unknown> {
    const clockState = this.clock.getState();
    return {
      phase: this.phase,
      pendingStart: this.pendingStart,
      via: this.detectedVia,
      site: this.siteCheck?.verdict ?? "unknown",
      siteFamily: this.siteCheck?.family ?? "unknown",
      chart: this.chart
        ? {
            keyCount: this.chart.keyCount,
            notes: this.chart.noteCount,
            actions: this.timeline?.actions.length ?? 0,
            signature: this.chart.signature,
            label: this.chart.label,
            startTime: this.chart.startTime,
            endTime: this.chart.endTime,
          }
        : null,
      mapping: this.keyMapping
        ? { source: this.keyMapping.source, codes: this.keyMapping.codes }
        : null,
      clock: {
        slope: Number(clockState.slope.toFixed(6)),
        errorMs: Number.isFinite(clockState.error) ? Number(clockState.error.toFixed(2)) : null,
        samples: clockState.samples,
        confident: clockState.confident,
        discontinuities: this.clock.discontinuityCount,
        epoch: this.clock.epoch,
      },
      scheduler: {
        running: this.scheduler.isRunning,
        paused: this.scheduler.isPaused,
        cursor: this.scheduler.cursorIndex,
        total: this.scheduler.total,
        remaining: this.scheduler.remaining,
        armed: this.scheduler.armedCount,
        fired: this.scheduler.firedCount,
        dropped: this.scheduler.droppedCount,
        jitter: this.scheduler.getJitter(),
      },
      input: {
        held: this.input.heldCount,
        heldColumns: this.input.heldColumns,
        down: this.input.dispatchedDown,
        up: this.input.dispatchedUp,
        duplicatesSuppressed: this.input.suppressedDuplicate,
        failures: this.input.failures,
      },
      siteState: this.game?.state ?? null,
      timeElapsed: Number.isFinite(this.chartTime()) ? this.chartTime() : null,
      humanization: this.humanizationStats
        ? {
            enabled: true,
            seed: this.settingsManager.all.humanization.seed,
            strength: this.settingsManager.all.humanization.strength,
            distribution: this.settingsManager.all.humanization.distribution,
            nominalSdMs: round(this.humanizer?.nominalSdMs ?? 0, 2),
            meanMs: round(this.humanizationStats.meanMs, 2),
            sdMs: round(this.humanizationStats.sdMs, 2),
            minMs: round(this.humanizationStats.minMs, 2),
            maxMs: round(this.humanizationStats.maxMs, 2),
            meanAbsMs: round(this.humanizationStats.meanAbsMs, 2),
            clamped: this.humanizationStats.clamped,
            patterns: this.humanizationStats.patterns,
          }
        : { enabled: false },
      lastError: this.lastError || null,
    };
  }
}

export { SAFE_STOP_MESSAGE };
