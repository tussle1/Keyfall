import type { EngineStats, GameLike } from "../types";

/**
 * Statistics.
 *
 * The site already computes everything worth showing — score, combo, accuracy
 * and the per-judgement counts live on `game.scoreSystem`. Reading them is a
 * handful of property accesses and is exact, so we prefer that over
 * re-deriving accuracy ourselves or parsing the HUD text.
 *
 * What we add on top is automation-side telemetry the site does not have:
 * how many actions we fired, how many notes remain, and how accurate our
 * *scheduling* was (jitter), which is the number that tells you whether the
 * timing model is healthy.
 */

/** The site's `ScoreSystem` stores judgement counts under numeric keys. */
const JUDGEMENTS = [320, 300, 200, 100, 50, 0] as const;

export interface JudgementCounts {
  "320": number;
  "300": number;
  "200": number;
  "100": number;
  "50": number;
  "0": number;
  total: number;
}

export function readJudgements(game: GameLike | null): JudgementCounts {
  const counts: JudgementCounts = {
    "320": 0,
    "300": 0,
    "200": 0,
    "100": 0,
    "50": 0,
    "0": 0,
    total: 0,
  };
  const score = game?.scoreSystem as Record<string | number, unknown> | undefined;
  if (!score) return counts;

  let total = 0;
  for (const judgement of JUDGEMENTS) {
    const value = Number(score[judgement] ?? 0);
    if (Number.isFinite(value) && value > 0) {
      counts[String(judgement) as keyof JudgementCounts] = value;
      total += value;
    }
  }
  counts.total = total;
  return counts;
}

/** Number of notes the site has actually judged (any judgement, incl. miss). */
export function judgedCount(game: GameLike | null): number {
  return readJudgements(game).total;
}

/** Perfect-ish hits, i.e. everything the site counted that was not a miss. */
export function hitCount(game: GameLike | null): number {
  const counts = readJudgements(game);
  return counts.total - counts["0"];
}

/**
 * Accuracy as a 0..1 fraction, or null when the site has not scored anything
 * yet. We read the site's own value so the displayed number is always the one
 * the results screen will show.
 */
export function readAccuracy(game: GameLike | null): number | null {
  const raw = (game?.scoreSystem as any)?.accuracy;
  if (typeof raw !== "number" || !Number.isFinite(raw)) return null;
  // The site stores 1 for 100%; guard against a percentage-shaped value.
  return raw > 1.5 ? raw / 100 : raw;
}

export function readCombo(game: GameLike | null): number {
  const raw = (game?.scoreSystem as any)?.combo;
  return typeof raw === "number" && Number.isFinite(raw) ? raw : 0;
}

export function readScore(game: GameLike | null): number | null {
  const raw = (game?.scoreSystem as any)?.score;
  return typeof raw === "number" && Number.isFinite(raw) ? Math.round(raw) : null;
}

/**
 * Assemble the full stats snapshot shown in the overlay.
 *
 * Called on the UI refresh interval, not per frame, and allocates exactly one
 * object — the readout is the only place we build a fresh snapshot.
 */
export function collectStats(input: {
  game: GameLike | null;
  notesTotal: number;
  notesRemaining: number;
  actionsFired: number;
  pressesDown: number;
  releasesUp: number;
  timeElapsed: number;
  lastJitter: number;
  avgJitter: number;
}): EngineStats {
  const { game } = input;
  return {
    notesTotal: input.notesTotal,
    notesRemaining: input.notesRemaining,
    actionsFired: input.actionsFired,
    pressesDown: input.pressesDown,
    releasesUp: input.releasesUp,
    hits: hitCount(game),
    combo: readCombo(game),
    accuracy: readAccuracy(game),
    score: readScore(game),
    timeElapsed: input.timeElapsed,
    lastJitter: input.lastJitter,
    avgJitter: input.avgJitter,
  };
}

/**
 * Notes remaining, counted in *notes* rather than actions.
 * `notePressTimes` is sorted, so this is a binary search.
 */
export function notesRemainingAt(
  notePressTimes: number[],
  chartTime: number,
): number {
  let lo = 0;
  let hi = notePressTimes.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (notePressTimes[mid] < chartTime) lo = mid + 1;
    else hi = mid;
  }
  return notePressTimes.length - lo;
}
