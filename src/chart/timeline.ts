import type { Humanizer } from "../humanize/humanizer";
import type { InputAction, KeyMapping, ParsedChart, SiteHitObject } from "../types";

/**
 * Chart -> ordered action timeline.
 *
 * Ordering is deliberately identical to the site's own `ReplayPlayer`, which
 * sorts `[column, time, isDown]` tuples by time alone and relies on a stable
 * sort to preserve construction order. Construction order there is, per hit
 * object: press then release. We reproduce that exactly, which gives us the
 * replay-compatibility guarantees the spec asks for:
 *
 *   - exact press ordering
 *   - same-frame simultaneous inputs kept in a deterministic order
 *   - hold durations preserved
 *   - a hold ending at the same instant the next note on that column starts
 *     releases *before* pressing (otherwise the press would be swallowed)
 */

export interface TimelineOptions {
  keyMapping: KeyMapping;
  /** Also emit actions for each column's secondary keybind. */
  useSecondaryKeybind?: boolean;
  secondaryCodes?: (string | null)[];
  /** Extra lead/lag in ms applied when the timeline is built. */
  offset?: number;
  /**
   * Optional per-note timing perturbation. Applied here rather than in the
   * scheduler because it is a property of the *chart interpretation*, not of
   * playback: it must be baked in before the ordering sort so that chords stay
   * together and same-column ordering survives. A humanizer with
   * `enabled: false` returns 0 for every note and consumes no randomness, so an
   * unhumanised timeline is bit-identical to no humanizer at all.
   */
  humanizer?: Humanizer | null;
}

export interface Timeline {
  actions: InputAction[];
  /** Index into `actions` of the first press for each note, for progress. */
  notePressTimes: number[];
  noteCount: number;
  keyCount: number;
  firstActionTime: number;
  lastActionTime: number;
  /** Diagnostics about the chart's density. */
  analysis: ChartAnalysis;
}

export interface ChartAnalysis {
  taps: number;
  holds: number;
  /** Notes sharing an identical timestamp with at least one other note. */
  chords: number;
  largestChord: number;
  /** Same-column consecutive notes below this gap, count of them. */
  jacks: number;
  /** Longest run of notes with no gap >= jackThreshold. */
  longestStream: number;
  /** Highest note density, notes per second, over a 1s sliding window. */
  peakNps: number;
  averageNps: number;
  /** Shortest same-column repeat interval, ms. */
  minJackInterval: number;
}

const JACK_THRESHOLD_MS = 110;

/**
 * Build the timeline. Pure and synchronous; called once per beatmap.
 */
export function buildTimeline(chart: ParsedChart, options: TimelineOptions): Timeline {
  const { keyMapping, useSecondaryKeybind = false, secondaryCodes, offset = 0, humanizer = null } = options;
  const keyCount = chart.keyCount;

  if (keyMapping.codes.length < keyCount) {
    throw new Error(
      `Key mapping covers ${keyMapping.codes.length} columns but the chart needs ${keyCount}.`,
    );
  }

  const actions: InputAction[] = [];
  const notePressTimes: number[] = [];

  const notes = chart.notes;
  let noteIndex = 0;

  // --- Pass 1: identify the head taps the site duplicates for every hold ----
  //
  // The site's parser pushes BOTH `{type:"tap", isHoldHead:true}` and
  // `{type:"hold"}` at the same (time, column, endTime) for each hold note.
  // Only the hold should drive the press, otherwise every hold fires twice.
  //
  // This must be a pre-pass rather than a "compare with the previous note"
  // check: the notes arrive sorted with holds *before* taps at equal
  // timestamps, so the head tap is seen second and a neighbour-based test
  // would miss it depending on sort order.
  const holdKeys = new Set<string>();
  for (let i = 0; i < notes.length; i++) {
    const note = notes[i];
    if (note.type === "hold" && note.endTime > note.time) {
      holdKeys.add(`${note.time}:${note.column}:${note.endTime}`);
    }
  }

  // --- Pass 2: select the notes that will actually be played ----------------
  //
  // The humanizer has to see exactly these notes, in this order, and nothing
  // else: a dropped hold head would otherwise be counted as a real note and
  // would shift every drift and fatigue sample after it.
  const playable: SiteHitObject[] = [];
  for (let i = 0; i < notes.length; i++) {
    const note = notes[i];
    const column = note.column;

    if (column < 0 || column >= keyCount) {
      // Out-of-range column: skip rather than throw, so one malformed note
      // cannot take down an otherwise playable chart.
      continue;
    }

    // A tap carrying a longer endTime is a hold head: the site sets a plain
    // tap's `endTime` equal to its `time`, and only hold heads get the hold's
    // end. The explicit `isHoldHead` flag is used when present.
    const isHold = note.type === "hold" && note.endTime > note.time;
    const explicitHead = (note as { isHoldHead?: boolean }).isHoldHead === true;
    const isHoldHead =
      !isHold &&
      (explicitHead ||
        (note.endTime > note.time && holdKeys.has(`${note.time}:${column}:${note.endTime}`)));
    if (isHoldHead) continue;

    playable.push(note);
  }

  // One preparation pass over the playable notes, before any action is emitted.
  // A hold's release has to be clamped against the *next* press on its column,
  // and that press's shifted time is not known until every note delta exists —
  // so this cannot be done in a single streaming pass.
  if (humanizer) humanizer.prepare(playable);

  // --- Pass 3: emit actions -------------------------------------------------
  for (let i = 0; i < playable.length; i++) {
    const note: SiteHitObject = playable[i];
    const column = note.column;
    const isHold = note.type === "hold" && note.endTime > note.time;

    // Humanization delta for this note. Zero when disabled. Reused for both of a
    // hold's edges so the head and the tail move together and the duration is
    // preserved; only the release gets its own extra variation on top.
    const delta = humanizer ? humanizer.deltaAt(i) : 0;
    const pressTime = note.time + offset + delta;

    notePressTimes.push(pressTime);
    noteIndex++;

    const holdDuration = isHold ? note.endTime - note.time : 0;
    pushAction(actions, pressTime, "down", column, keyMapping, useSecondaryKeybind, secondaryCodes, holdDuration);

    if (isHold) {
      // Release at the hold's end, plus the note's own delta so the duration is
      // preserved, plus an independent release delta: letting go of a hold is a
      // separate decision from hitting its head, and players vary it more. The
      // humanizer clamps it so the tail cannot pass the next press on this
      // column, which would silently lose that note.
      const releaseExtra = humanizer ? humanizer.releaseExtraAt(i, note) : 0;
      pushAction(
        actions,
        note.endTime + offset + delta + releaseExtra,
        "up",
        column,
        keyMapping,
        useSecondaryKeybind,
        secondaryCodes,
        holdDuration,
      );
    } else {
      // Taps: press and release at the same instant, matching the site's own
      // autoplay replay, which emits `[column, time, true]` and
      // `[column, endTime, false]` with `endTime === time` for a tap.
      pushAction(actions, pressTime, "up", column, keyMapping, useSecondaryKeybind, secondaryCodes, 0);
    }
  }

  // Stable sort by time only. Do NOT add type tiebreakers: the site's ordering
  // (press before release at equal times) must be preserved for replay parity.
  const decorated = actions.map((action, index) => ({ action, index }));
  decorated.sort((a, b) => a.action.time - b.action.time || a.index - b.index);

  const sorted: InputAction[] = new Array(decorated.length);
  for (let i = 0; i < decorated.length; i++) {
    const action = decorated[i].action;
    action.seq = i;
    // Flag actions that share a timestamp with a neighbour, for diagnostics
    // and for batching them into a single timer.
    const prev = i > 0 ? sorted[i - 1] : null;
    const next = decorated[i + 1]?.action ?? null;
    action.simultaneous = (prev !== null && prev.time === action.time) || (next !== null && next.time === action.time);
    sorted[i] = action;
  }

  notePressTimes.sort((a, b) => a - b);

  const analysis = analyseChart(chart.notes, sorted);

  return {
    actions: sorted,
    notePressTimes,
    noteCount: noteIndex || chart.noteCount,
    keyCount,
    firstActionTime: sorted.length > 0 ? sorted[0].time : 0,
    lastActionTime: sorted.length > 0 ? sorted[sorted.length - 1].time : 0,
    analysis,
  };
}

function pushAction(
  actions: InputAction[],
  time: number,
  type: "down" | "up",
  column: number,
  keyMapping: KeyMapping,
  useSecondary: boolean,
  secondaryCodes: (string | null)[] | undefined,
  holdDuration: number,
): void {
  actions.push({
    seq: actions.length,
    time,
    type,
    column,
    code: keyMapping.codes[column],
    simultaneous: false,
    holdDuration,
  });

  if (useSecondary && secondaryCodes) {
    const secondary = secondaryCodes[column];
    if (secondary && secondary !== keyMapping.codes[column]) {
      actions.push({
        seq: actions.length,
        time,
        type,
        column,
        code: secondary,
        simultaneous: true,
        holdDuration,
      });
    }
  }
}

/** Density/pattern analysis, computed once per chart (never per frame). */
export function analyseChart(notes: SiteHitObject[], actions: InputAction[]): ChartAnalysis {
  let jacks = 0;
  let minJackInterval = Infinity;
  let holds = 0;
  let taps = 0;

  // Per-column previous note time, for jack detection.
  const prevByColumn = new Map<number, number>();

  // Chord detection: count notes per timestamp.
  const timeCounts = new Map<number, number>();
  let largestChord = 0;

  // Count each *logical* note once: the site stores a hold as both a head tap
  // and a hold object at the same (time, column), so skip the head tap.
  let totalNotes = 0;

  for (let i = 0; i < notes.length; i++) {
    const note = notes[i];
    const next = notes[i + 1];

    const isHoldHead =
      note.type === "tap" &&
      !!next &&
      next.type === "hold" &&
      next.column === note.column &&
      next.time === note.time &&
      next.endTime === note.endTime;

    if (isHoldHead) continue;

    totalNotes++;
    if (note.type === "hold" && note.endTime > note.time) holds++;
    else taps++;

    const count = (timeCounts.get(note.time) ?? 0) + 1;
    timeCounts.set(note.time, count);
    if (count > largestChord) largestChord = count;

    const prev = prevByColumn.get(note.column);
    if (prev !== undefined) {
      const gap = note.time - prev;
      if (gap < minJackInterval) minJackInterval = gap;
      if (gap < JACK_THRESHOLD_MS) jacks++;
    }
    prevByColumn.set(note.column, note.time);
  }

  let chords = 0;
  for (const count of timeCounts.values()) {
    if (count > 1) chords += count;
  }

  // Stream length + peak NPS over the press actions only.
  const presses = actions.filter((a) => a.type === "down").map((a) => a.time);
  let longestStream = 0;
  let currentStream = 0;
  let peakNps = 0;

  for (let i = 0; i < presses.length; i++) {
    if (i > 0 && presses[i] - presses[i - 1] < JACK_THRESHOLD_MS) {
      currentStream++;
    } else {
      currentStream = 1;
    }
    if (currentStream > longestStream) longestStream = currentStream;
  }

  // Sliding 1s window peak.
  if (presses.length > 0) {
    let left = 0;
    for (let right = 0; right < presses.length; right++) {
      while (presses[right] - presses[left] > 1000) left++;
      const nps = right - left + 1;
      if (nps > peakNps) peakNps = nps;
    }
  }

  const spanSeconds = presses.length > 1
    ? Math.max((presses[presses.length - 1] - presses[0]) / 1000, 1e-6)
    : 1;

  return {
    taps,
    holds,
    chords,
    largestChord,
    jacks,
    longestStream,
    peakNps,
    averageNps: totalNotes / spanSeconds,
    minJackInterval: Number.isFinite(minJackInterval) ? minJackInterval : 0,
  };
}
