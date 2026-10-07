import { SeededRandom } from "../util/rng";
import type { SiteHitObject } from "../types";

/**
 * Humanization: deliberate, reproducible timing variation.
 *
 * PURPOSE
 * -------
 * A machine plays a chart at exactly the right millisecond, every time. That is
 * useful for verifying a chart or watching it played, but it is not useful for
 * studying *timing* — you cannot see how much slack a pattern tolerates, or how
 * a rhythm feels when it is slightly early or slightly late, from a run that
 * never varies.
 *
 * This module adds controlled variation so a run behaves more like a player:
 * notes land a few milliseconds either side of perfect, with short-term wobble,
 * slow drift across the chart, and tightening inside dense patterns where a
 * real player locks into a rhythm.
 *
 * WHAT IT IS NOT
 * --------------
 * This is not detection evasion and cannot be. Every event dispatched by this
 * tool is `isTrusted === false`, which any site can check in one line. Nothing
 * here changes that: the timing becomes less machine-like, the events stay
 * exactly as synthetic as they were. It exists for practice and timing
 * experimentation. See docs/SAFETY.md.
 *
 * WHY TWO PASSES
 * --------------
 * A hold's release has to be clamped against the *next* press on that column,
 * and the next press's shifted time is not known until the note deltas exist. A
 * single streaming pass cannot do that — it would clamp against a ceiling that
 * has not been computed yet, and a late release would swallow the next note.
 *
 * So `prepare()` computes every note delta and every release ceiling first, and
 * `releaseExtra()` then reads a ceiling that is guaranteed to be final. Both are
 * called once per chart, before any action is emitted.
 *
 * ORDERING INVARIANTS
 * -------------------
 * Two must survive perturbation, because violating either silently breaks
 * playback rather than merely sounding wrong:
 *
 *   1. CHORDS STAY TOGETHER. Notes sharing a timestamp share one delta, or a
 *      chord smears into a rapid arpeggio.
 *   2. SAME-COLUMN ORDER IS PRESERVED. If a hold's release lands after the next
 *      press on that column, the press is lost: the site's `hit()` early-returns
 *      while the column is already down, so the note vanishes and the key stays
 *      pinned until the next event on that column.
 */

export interface HumanizationConfig {
  /** Master switch. Off by default: perfect timing is the honest baseline. */
  enabled: boolean;
  /** Seed for the PRNG. Same seed + same chart = identical timing. */
  seed: number;
  /** 0..1. Scales every variation component. */
  strength: number;
  /** Shape of the per-note random component. */
  distribution: "gaussian" | "uniform";
  /** 0..1. Weight of the fast mean-reverting wobble. */
  shortTermDrift: number;
  /** 0..1. Weight of the slow random walk across the whole chart. */
  longTermDrift: number;
  /** 0..1. How much dense patterns (jacks, streams) tighten up. */
  patternAware: number;
  /** 0..1. Extra variation on a hold's *release* edge only. */
  holdReleaseVariation: number;
  /** 0..1. How much a player "tires" over the length of the chart. */
  fatigue: number;
}

export const DEFAULT_HUMANIZATION: HumanizationConfig = {
  enabled: false,
  seed: 0,
  strength: 0.35,
  distribution: "gaussian",
  shortTermDrift: 0.4,
  longTermDrift: 0.25,
  patternAware: 0.6,
  holdReleaseVariation: 0.5,
  fatigue: 0.3,
};

export interface HumanizationStats {
  /** Notes that received a delta. */
  notes: number;
  /** Mean signed delta, ms. Positive = later than perfect. */
  meanMs: number;
  /** Standard deviation of the delta, ms. */
  sdMs: number;
  minMs: number;
  maxMs: number;
  /** Mean absolute delta, ms — the "how far off perfect" number users want. */
  meanAbsMs: number;
  /** How many deltas had to be clamped to preserve ordering. */
  clamped: number;
  /** How many hold releases were clamped for the same reason. */
  releaseClamped: number;
  /** Pattern classification, for the pattern-aware component and diagnostics. */
  patterns: {
    jacks: number;
    streams: number;
    longestStream: number;
    chordMembers: number;
    holds: number;
    isolated: number;
  };
}

const EMPTY_PATTERNS = {
  jacks: 0,
  streams: 0,
  longestStream: 0,
  chordMembers: 0,
  holds: 0,
  isolated: 0,
};

function emptyStats(): HumanizationStats {
  return {
    notes: 0,
    meanMs: 0,
    sdMs: 0,
    minMs: 0,
    maxMs: 0,
    meanAbsMs: 0,
    clamped: 0,
    releaseClamped: 0,
    patterns: { ...EMPTY_PATTERNS },
  };
}

/**
 * Per-note random standard deviation at `strength = 1`, in ms.
 *
 * Sized against osu!mania's judgement windows: the tightest is roughly ±22ms.
 * At the default strength of 0.35 this gives an sd of ~4ms, so the large
 * majority of notes still land in the best window while the run no longer looks
 * machine-perfect. Pushing strength to 1 makes timing genuinely sloppy, which is
 * the point — it lets you feel how much slack a pattern has.
 */
const BASE_SD_MS = 12;

/** Same-column repeat interval below which notes count as a jack. */
const JACK_THRESHOLD_MS = 110;
/** Interval below which a run of same-column notes counts as a stream. */
const STREAM_THRESHOLD_MS = 160;
/** Safety margin added to the minimum same-column separation. */
const ORDER_MARGIN_MS = 1;

/**
 * What a note is, rhythmically, relative to what came before it on its column.
 *
 * Chords are deliberately absent: a chord is a property of a *group* of notes,
 * not of one note's local context, and it is handled by delta sharing rather
 * than by scaling. `chordMembers` in the stats counts the extra notes at a
 * shared timestamp.
 */
type Pattern = "jack" | "stream" | "hold" | "isolated";

export interface HumanizerOptions {
  config: HumanizationConfig;
  /**
   * How long a tap's release is deferred after its press. The next same-column
   * press must not land inside that window, so the clamp needs the value. Must
   * match the InputManager's, or the two disagree about what is safe.
   */
  minTapHoldMs: number;
}

export class Humanizer {
  private readonly config: HumanizationConfig;
  private readonly rng: SeededRandom;
  private readonly minTapHoldMs: number;

  /** Chart start and span, for normalising fatigue. Derived in `prepare()`. */
  private startMs = 0;
  private durationMs = 0;

  /** Per-note results, filled by `prepare()`. */
  private deltas: number[] = [];
  /** Per-note ceiling on the release edge, filled by `prepare()`. */
  private releaseCeilings: number[] = [];
  /** Per-note extra release variation, filled by `prepare()`. */
  private releaseExtras: number[] = [];
  /** Per-note pattern, for diagnostics. */
  private patternOf: Pattern[] = [];

  private prepared = false;
  private clampedCount = 0;
  private releaseClampedCount = 0;
  private statsCache: HumanizationStats = emptyStats();

  constructor(options: HumanizerOptions) {
    this.config = options.config;
    this.minTapHoldMs = Math.max(0, options.minTapHoldMs);
    this.rng = new SeededRandom(options.config.seed);
  }

  get isEnabled(): boolean {
    return this.config.enabled && this.config.strength > 0;
  }

  /**
   * Compute every note delta and release ceiling for a chart.
   *
   * `notes` must be in ascending time order — the order the timeline emits them
   * in — because drift, fatigue and pattern classification are all defined
   * relative to what came before.
   */
  prepare(notes: readonly SiteHitObject[]): void {
    this.rng.reseed(this.config.seed);

    const count = notes.length;
    this.deltas = new Array(count).fill(0);
    this.releaseCeilings = new Array(count).fill(Number.POSITIVE_INFINITY);
    this.releaseExtras = new Array(count).fill(0);
    this.patternOf = new Array(count).fill("isolated");
    this.clampedCount = 0;
    this.releaseClampedCount = 0;

    if (count === 0) {
      this.prepared = true;
      this.statsCache = emptyStats();
      return;
    }

    // Chart span, for fatigue normalisation. Kept as an explicit start/span pair
    // rather than dividing by the end time, because the first note is not
    // usually at 0 — the site pads the start with `delay`.
    let minTime = Infinity;
    let maxTime = -Infinity;
    for (const note of notes) {
      if (note.time < minTime) minTime = note.time;
      const end = note.endTime > note.time ? note.endTime : note.time;
      if (end > maxTime) maxTime = end;
    }
    this.startMs = minTime === Infinity ? 0 : minTime;
    this.durationMs = Math.max(0, maxTime - minTime);

    if (!this.isEnabled) {
      // A disabled humanizer must not shift a chart or consume randomness, so an
      // unhumanised timeline is bit-identical to having no humanizer at all.
      this.prepared = true;
      this.statsCache = emptyStats();
      return;
    }

    // --- pass 1: per-note deltas -----------------------------------------
    const prevByColumn = new Map<number, { time: number; endTime: number; delta: number; index: number }>();
    const timestampCounts = new Map<number, number>();
    const deltaByTimestamp = new Map<number, number>();

    let ouState = 0;
    let walkState = 0;
    let currentStream = 0;
    const patterns = { ...EMPTY_PATTERNS };

    for (let i = 0; i < count; i++) {
      const note = notes[i];
      const seenAtTimestamp = timestampCounts.get(note.time) ?? 0;
      timestampCounts.set(note.time, seenAtTimestamp + 1);

      const pattern = this.classify(note, prevByColumn.get(note.column) ?? null);
      this.patternOf[i] = pattern;
      if (pattern === "jack" || pattern === "stream") {
        currentStream++;
        if (currentStream > patterns.longestStream) patterns.longestStream = currentStream;
        if (pattern === "jack") patterns.jacks++;
        else patterns.streams++;
      } else {
        currentStream = 0;
        if (pattern === "hold") patterns.holds++;
        else patterns.isolated++;
      }
      if (seenAtTimestamp > 0) patterns.chordMembers++;

      // Chord coherence: one delta per timestamp, shared by every note at it.
      let delta = deltaByTimestamp.get(note.time);
      if (delta === undefined) {
        delta = this.computeDelta(
          note,
          pattern,
          prevByColumn.get(note.column)?.delta ?? null,
          () => ouState,
          (v) => (ouState = v),
          () => walkState,
          (v) => (walkState = v),
        );
        deltaByTimestamp.set(note.time, delta);
      }

      // Clamp so this column's ordering survives.
      const prev = prevByColumn.get(note.column) ?? null;
      const clamped = this.clampForOrder(note, prev, delta);
      if (clamped !== delta) this.clampedCount++;
      this.deltas[i] = clamped;

      // This note's shifted press becomes the ceiling for the previous
      // same-column note's release.
      if (prev) {
        this.releaseCeilings[prev.index] = note.time + clamped;
      }

      prevByColumn.set(note.column, {
        time: note.time,
        endTime: note.endTime > note.time ? note.endTime : note.time,
        delta: clamped,
        index: i,
      });
    }

    // --- pass 2: release ceilings, then release variation ------------------
    //
    // A hold with no following note on its column gets `Infinity` from pass 1;
    // tighten that to its own shifted end, so a tail can never be pushed past
    // where the hold was meant to finish.
    for (let i = 0; i < count; i++) {
      if (!Number.isFinite(this.releaseCeilings[i])) {
        this.releaseCeilings[i] = notes[i].endTime + this.deltas[i];
      }
    }

    // Release variation is computed here rather than on demand so that the whole
    // result is a pure function of (chart, config): no call ordering can change
    // the output, and reading an edge twice cannot consume randomness twice.
    for (let i = 0; i < count; i++) {
      this.releaseExtras[i] = this.computeReleaseExtra(notes[i], i);
    }

    this.prepared = true;
    this.statsCache = this.computeStats(patterns);
  }

  /**
   * The delta for the note at index `i`. Must be called after `prepare()`.
   * Returns 0 when humanization is off.
   */
  deltaAt(index: number): number {
    if (!this.prepared || !this.isEnabled) return 0;
    return this.deltas[index] ?? 0;
  }

  /**
   * Extra variation for the note at index `i`'s release edge, clamped so the
   * release cannot pass the next press on that column.
   *
   * A hold's press is a normal hit, but letting go is a separate decision a
   * player makes while watching the tail — it varies more, and independently of
   * the head. For a tap this is always 0: a tap's down and up share an instant
   * in the site's own replay, and the InputManager defers the release itself.
   */
  releaseExtraAt(index: number, note: SiteHitObject): number {
    if (!this.prepared || !this.isEnabled) return 0;
    if (note.type !== "hold" || !(note.endTime > note.time)) return 0;
    return this.releaseExtras[index] ?? 0;
  }

  /**
   * Variation for one hold's release edge, clamped so the tail cannot pass the
   * next press on that column.
   *
   * Negative extra is allowed: letting go early is safe, letting go late is what
   * loses the next note — the site's `hit()` early-returns while the column is
   * still down, so the press would be dropped and the key left pinned.
   */
  private computeReleaseExtra(note: SiteHitObject, index: number): number {
    const cfg = this.config;
    if (cfg.holdReleaseVariation <= 0) return 0;
    if (note.type !== "hold" || !(note.endTime > note.time)) return 0;

    const sd = BASE_SD_MS * cfg.strength * cfg.holdReleaseVariation;
    // Release error is biased late: players hold until they are sure.
    const raw = this.sample(cfg.distribution, sd * 0.6, sd);

    const shiftedEnd = note.endTime + this.deltas[index];
    const ceiling = this.releaseCeilings[index];
    if (Number.isFinite(ceiling) && shiftedEnd + raw > ceiling) {
      this.releaseClampedCount++;
      return ceiling - shiftedEnd;
    }
    return raw;
  }

  get stats(): HumanizationStats {
    return this.statsCache;
  }

  /** The effective per-note sd at the current strength, for display. */
  get nominalSdMs(): number {
    if (!this.isEnabled) return 0;
    return BASE_SD_MS * this.config.strength;
  }

  /* ------------------------------ internals ----------------------------- */

  private classify(
    note: SiteHitObject,
    prev: { time: number; endTime: number } | null,
  ): Pattern {
    if (note.type === "hold" && note.endTime > note.time) return "hold";
    if (prev) {
      const gap = note.time - prev.time;
      if (gap < JACK_THRESHOLD_MS) return "jack";
      if (gap < STREAM_THRESHOLD_MS) return "stream";
    }
    return "isolated";
  }

  /**
   * The unclamped delta for one note. The caller caches this per timestamp so a
   * chord shares it, and clamps it per column afterwards.
   *
   * The drift state is passed in as accessors because both processes are
   * per-chart rather than per-note, and only the first note of a chord should
   * advance them.
   */
  private computeDelta(
    note: SiteHitObject,
    pattern: Pattern,
    prevDelta: number | null,
    getOu: () => number,
    setOu: (v: number) => void,
    getWalk: () => number,
    setWalk: (v: number) => void,
  ): number {
    const cfg = this.config;

    // --- random component -------------------------------------------------
    // Pattern-aware scaling: inside a jack or stream a player is following a
    // rhythm they have just established, so their error is smaller.
    const baseSd = BASE_SD_MS * cfg.strength * this.patternScale(pattern);
    let delta: number;

    if (pattern === "jack" && cfg.patternAware > 0 && prevDelta !== null) {
      // Rhythm lock. Reducing the sd alone is not enough: what a player keeps
      // consistent inside a jack is the *interval*, not the absolute offset. So
      // blend toward the previous note's delta — at patternAware = 1 a perfect
      // jack keeps its spacing almost exactly while the whole run still wanders.
      const independent = this.sample(cfg.distribution, 0, baseSd * (1 - cfg.patternAware));
      delta = prevDelta * cfg.patternAware + independent;
    } else {
      delta = this.sample(cfg.distribution, 0, baseSd);
    }

    // --- short-term drift -------------------------------------------------
    // Ornstein–Uhlenbeck: reverts to zero, so it wobbles locally without
    // accumulating into a permanent offset. Mean reversion bounds it only in
    // expectation, so it gets a hard clamp too — "the wobble cannot become an
    // accidental offset" is worth guaranteeing rather than assuming.
    if (cfg.shortTermDrift > 0) {
      const theta = 0.18; // pull back toward zero
      const sigma = BASE_SD_MS * cfg.strength * cfg.shortTermDrift * 0.5;
      let ou = getOu() * (1 - theta) + this.sample(cfg.distribution, 0, sigma);
      const ouLimit = BASE_SD_MS * cfg.strength * (1 + cfg.shortTermDrift * 3);
      if (ou > ouLimit) ou = ouLimit;
      else if (ou < -ouLimit) ou = -ouLimit;
      setOu(ou);
      delta += ou;
    }

    // --- long-term drift --------------------------------------------------
    // A slow bounded random walk: over a whole chart a player drifts early or
    // late relative to the music. Clamped so it cannot become a large offset —
    // that is what the Timing Offset control is for.
    if (cfg.longTermDrift > 0) {
      const step = BASE_SD_MS * cfg.strength * cfg.longTermDrift * 0.12;
      let walk = getWalk() + this.sample(cfg.distribution, 0, step);
      const limit = BASE_SD_MS * cfg.strength * cfg.longTermDrift * 3;
      if (walk > limit) walk = limit;
      else if (walk < -limit) walk = -limit;
      setWalk(walk);
      delta += walk;
    }

    // --- fatigue ----------------------------------------------------------
    // Later in a long chart a player is less consistent and tends to fall
    // slightly behind. Progress is normalised over the chart span, so a 30s map
    // and a 6min map both reach full fatigue at their own ends.
    if (cfg.fatigue > 0 && this.durationMs > 0) {
      const progress = Math.min(1, Math.max(0, (note.time - this.startMs) / this.durationMs));
      const amount = progress * cfg.fatigue;
      delta += this.sample(cfg.distribution, 0, BASE_SD_MS * cfg.strength * amount * 0.7);
      // And the mean shifts late, because reaction slows.
      delta += BASE_SD_MS * cfg.strength * amount * 0.35;
    }

    return delta;
  }

  private sample(distribution: "gaussian" | "uniform", mean: number, sd: number): number {
    if (sd <= 0) return mean;
    if (distribution === "uniform") {
      // Uniform with the same variance as the gaussian (sd^2), so switching
      // distribution changes the shape without changing the overall spread.
      const halfWidth = sd * Math.sqrt(3);
      return mean + this.rng.range(-halfWidth, halfWidth);
    }
    return this.rng.normal(mean, sd);
  }

  /** How much the random component is scaled for this pattern. */
  private patternScale(pattern: Pattern): number {
    const aware = this.config.patternAware;
    if (aware <= 0) return 1;
    switch (pattern) {
      // Tight patterns get tighter: a player locked into a rhythm is more
      // consistent relative to themselves than when sight-reading a lone note.
      case "jack":
        return 1 - 0.65 * aware;
      case "stream":
        return 1 - 0.45 * aware;
      case "hold":
        return 1 - 0.2 * aware;
      default:
        return 1;
    }
  }

  /**
   * Clamp a delta so that same-column ordering survives.
   *
   * The failure this prevents is specific and silent: the site's `hit()`
   * early-returns while a column is already pressed, so if a hold's release
   * shifts later than the next press on that column, the press is dropped and
   * the column stays pinned until something else touches it.
   */
  private clampForOrder(
    note: SiteHitObject,
    prev: { time: number; endTime: number; delta: number } | null,
    proposed: number,
  ): number {
    if (!prev) return Math.max(proposed, -note.time);

    const prevIsHold = prev.endTime > prev.time;
    const prevShiftedEnd = prevIsHold ? prev.endTime + prev.delta : prev.time + prev.delta;

    // Boundary case: this note starts exactly where the previous hold ends. Both
    // then land on one timestamp and construction order decides it (release
    // first), which is what the site's own replay does. Sharing the delta is
    // what keeps them on that timestamp.
    if (note.time === prev.endTime && prevIsHold) {
      return prev.delta;
    }

    const minSeparation = prevIsHold ? ORDER_MARGIN_MS : this.minTapHoldMs + ORDER_MARGIN_MS;
    const minShiftedTime = prevShiftedEnd + minSeparation;

    let delta = proposed;
    if (note.time + delta < minShiftedTime) {
      delta = minShiftedTime - note.time;
    }
    // Never shift a note before the chart starts.
    if (note.time + delta < 0) delta = -note.time;
    return delta;
  }

  private computeStats(patterns: typeof EMPTY_PATTERNS): HumanizationStats {
    const count = this.deltas.length;
    if (count === 0) return { ...emptyStats(), patterns: { ...patterns } };

    let sum = 0;
    let sumSq = 0;
    let sumAbs = 0;
    let min = Infinity;
    let max = -Infinity;
    for (const d of this.deltas) {
      sum += d;
      sumSq += d * d;
      sumAbs += Math.abs(d);
      if (d < min) min = d;
      if (d > max) max = d;
    }
    const mean = sum / count;
    const variance = Math.max(0, sumSq / count - mean * mean);

    return {
      notes: count,
      meanMs: mean,
      sdMs: Math.sqrt(variance),
      minMs: min === Infinity ? 0 : min,
      maxMs: max === -Infinity ? 0 : max,
      meanAbsMs: sumAbs / count,
      clamped: this.clampedCount,
      releaseClamped: this.releaseClampedCount,
      patterns: { ...patterns },
    };
  }
}

/**
 * Clamp and validate a raw config into a safe one. Mirrors the settings
 * manager's approach: never trust a persisted or user-supplied value.
 */
export function sanitizeHumanization(raw: unknown): HumanizationConfig {
  const out: HumanizationConfig = { ...DEFAULT_HUMANIZATION };
  if (!raw || typeof raw !== "object") return out;
  const value = raw as Partial<HumanizationConfig>;

  const unit = (v: unknown, fallback: number): number => {
    const n = Number(v);
    if (Number.isNaN(n)) return fallback;
    // Infinities clamp rather than fall back: `Infinity` clearly means "maximum"
    // and `-Infinity` clearly means "minimum", whereas NaN carries no intent.
    return Math.min(1, Math.max(0, n));
  };

  out.enabled = value.enabled === true;
  out.strength = unit(value.strength, DEFAULT_HUMANIZATION.strength);

  const seed = Number(value.seed);
  out.seed = Number.isFinite(seed) ? Math.abs(Math.trunc(seed)) >>> 0 : 0;

  out.distribution = value.distribution === "uniform" ? "uniform" : "gaussian";
  out.shortTermDrift = unit(value.shortTermDrift, DEFAULT_HUMANIZATION.shortTermDrift);
  out.longTermDrift = unit(value.longTermDrift, DEFAULT_HUMANIZATION.longTermDrift);
  out.patternAware = unit(value.patternAware, DEFAULT_HUMANIZATION.patternAware);
  out.holdReleaseVariation = unit(
    value.holdReleaseVariation,
    DEFAULT_HUMANIZATION.holdReleaseVariation,
  );
  out.fatigue = unit(value.fatigue, DEFAULT_HUMANIZATION.fatigue);

  return out;
}
