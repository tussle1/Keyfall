import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildTimeline } from "../src/chart/timeline";
import { SeededRandom } from "../src/util/rng";
import {
  DEFAULT_HUMANIZATION,
  Humanizer,
  sanitizeHumanization,
  type HumanizationConfig,
} from "../src/humanize/humanizer";
import type { KeyMapping, ParsedChart, SiteHitObject } from "../src/types";

/* ------------------------------- helpers ------------------------------- */

const MIN_TAP_HOLD_MS = 12;

function mapping(codes: string[]): KeyMapping {
  return { codes, keyCount: codes.length, source: "site" };
}

function config(overrides: Partial<HumanizationConfig> = {}): HumanizationConfig {
  return { ...DEFAULT_HUMANIZATION, enabled: true, seed: 1234, strength: 0.35, ...overrides };
}

/** Build a humanizer and run its preparation pass over `notes`. */
function prepared(notes: SiteHitObject[], overrides: Partial<HumanizationConfig> = {}): Humanizer {
  const h = new Humanizer({ config: config(overrides), minTapHoldMs: MIN_TAP_HOLD_MS });
  h.prepare(notes);
  return h;
}

const tap = (column: number, time: number): SiteHitObject => ({ type: "tap", column, time, endTime: time });
const hold = (column: number, time: number, endTime: number): SiteHitObject => ({
  type: "hold",
  column,
  time,
  endTime,
});

/** A hold exactly as the site stores it: head tap (with the hold's end) + hold. */
const holdAsSite = (column: number, time: number, endTime: number): SiteHitObject[] => [
  { type: "tap", column, time, endTime, isHoldHead: true },
  hold(column, time, endTime),
];

/**
 * Build a ParsedChart WITHOUT reordering.
 *
 * `buildTimeline` consumes `chart.notes` in the order given and the humanizer is
 * driven from that same order, so a helper that sorted here would silently
 * change which note the humanizer sees first — and classification (jack vs
 * isolated) depends entirely on that order. The real site stores hitObjects
 * already sorted by time, so tests should pass them that way explicitly.
 */
function chartOf(notes: SiteHitObject[], keyCount = 4): ParsedChart {
  const times = notes.map((n) => n.time);
  const ends = notes.map((n) => n.endTime);
  return {
    keyCount,
    notes: [...notes],
    noteCount: notes.length,
    startTime: Math.min(...times),
    endTime: Math.max(...ends),
    signature: "test",
  };
}

/** Order notes the way the site stores them: ascending time, then column. */
function sortByTime(notes: SiteHitObject[]): SiteHitObject[] {
  return [...notes].sort((a, b) => a.time - b.time || a.column - b.column);
}

/** Prepare a note list and collect the resulting deltas. */
function deltas(notes: SiteHitObject[], overrides: Partial<HumanizationConfig> = {}): number[] {
  const h = prepared(notes, overrides);
  return notes.map((_, i) => h.deltaAt(i));
}

/** A chart long enough for fatigue and drift to be meaningful. */
function longChart(count: number, gapMs = 200, keyCount = 4): SiteHitObject[] {
  const notes: SiteHitObject[] = [];
  for (let i = 0; i < count; i++) {
    notes.push(tap(i % keyCount, 1000 + i * gapMs));
  }
  return notes;
}

/* -------------------------------- tests -------------------------------- */

describe("humanizer", () => {
  it("does not shift anything when disabled", () => {
    const notes = longChart(200);
    const off = deltas(notes, { enabled: false });
    assert.ok(off.every((d) => d === 0), "every delta must be exactly 0");
  });

  it("does not shift anything at strength 0", () => {
    const off = deltas(longChart(200), { strength: 0 });
    assert.ok(off.every((d) => d === 0));
  });

  it("reseed() clears the cached Gaussian sample", () => {
    // Regression: the Marsaglia polar method caches one normal sample per pair.
    // Rewinding only the generator state left that spare behind, so an odd number
    // of gaussian() calls made consecutive runs *alternate* between two
    // sequences instead of repeating one. It surfaced as fatigue-dependent
    // non-reproducibility, because fatigue is the component that happens to draw
    // an odd number of samples for many chart lengths.
    const rng = new SeededRandom(1234);
    const first = [rng.gaussian(), rng.gaussian(), rng.gaussian()]; // odd count
    rng.reseed(1234);
    const second = [rng.gaussian(), rng.gaussian(), rng.gaussian()];
    assert.deepEqual(second, first, "reseed must rewind the Gaussian pair cache too");

    // And it must hold for any parity, not just the odd case.
    for (const draws of [1, 2, 3, 4, 5, 8, 13]) {
      const r = new SeededRandom(99);
      const runA: number[] = [];
      for (let i = 0; i < draws + 3; i++) runA.push(r.gaussian());
      r.reseed(99);
      const runB: number[] = [];
      for (let i = 0; i < draws + 3; i++) runB.push(r.gaussian());
      const r2 = new SeededRandom(99);
      const reference: number[] = [];
      for (let i = 0; i < draws + 3; i++) reference.push(r2.gaussian());
      assert.deepEqual(runB, reference, `not reproducible after ${draws} draws`);
      assert.deepEqual(runA, reference);
    }
  });

  it("is deterministic for a given seed and chart", () => {
    const notes = longChart(300);
    assert.deepEqual(deltas(notes, { seed: 777 }), deltas(notes, { seed: 777 }));
  });

  it("differs between seeds", () => {
    const notes = longChart(300);
    const a = deltas(notes, { seed: 1 });
    const b = deltas(notes, { seed: 2 });
    assert.notDeepEqual(a, b);
  });

  it("produces variation in both directions", () => {
    const d = deltas(longChart(400));
    assert.ok(d.some((v) => v > 0), "some notes late");
    assert.ok(d.some((v) => v < 0), "some notes early");
  });

  it("scales the spread with strength", () => {
    const notes = longChart(1200);
    const sdOf = (strength: number) => {
      const d = deltas(notes, { strength });
      const mean = d.reduce((a, b) => a + b, 0) / d.length;
      return Math.sqrt(d.reduce((a, b) => a + (b - mean) ** 2, 0) / d.length);
    };
    const low = sdOf(0.1);
    const high = sdOf(0.9);
    assert.ok(high > low * 3, `strength should scale spread (low ${low}, high ${high})`);
  });

  it("reports statistics matching the deltas it produced", () => {
    const notes = longChart(400);
    const h = prepared(notes);
    const d = notes.map((_, i) => h.deltaAt(i));
    const stats = h.stats;

    assert.equal(stats.notes, d.length);
    const mean = d.reduce((a, b) => a + b, 0) / d.length;
    assert.ok(Math.abs(stats.meanMs - mean) < 1e-9, `mean ${stats.meanMs} vs ${mean}`);
    assert.equal(stats.minMs, Math.min(...d));
    assert.equal(stats.maxMs, Math.max(...d));
    const meanAbs = d.reduce((a, b) => a + Math.abs(b), 0) / d.length;
    assert.ok(Math.abs(stats.meanAbsMs - meanAbs) < 1e-9);
  });

  it("reports empty statistics before preparation", () => {
    const stats = new Humanizer({ config: config(), minTapHoldMs: MIN_TAP_HOLD_MS }).stats;
    assert.equal(stats.notes, 0);
    assert.equal(stats.meanMs, 0);
    assert.equal(stats.sdMs, 0);
    assert.equal(stats.clamped, 0);
    assert.equal(stats.releaseClamped, 0);
  });

  it("reports empty statistics for an empty chart", () => {
    const h = prepared([]);
    assert.equal(h.stats.notes, 0);
    assert.equal(h.deltaAt(0), 0, "reading past the end must not throw");
    assert.equal(h.releaseExtraAt(0, tap(0, 0)), 0);
  });

  it("is reproducible when prepared again on the same chart", () => {
    // A timeline is rebuilt whenever a humanization setting changes mid-run, so
    // re-preparing must rewind the RNG. Without that, "same seed + same chart =
    // identical timing" would only hold for the first build.
    const notes = longChart(150);
    const h = prepared(notes);
    const first = notes.map((_, i) => h.deltaAt(i));
    const firstStats = h.stats;
    assert.ok(firstStats.notes > 0);
    assert.ok(first.some((d) => d !== 0), "the run should actually be perturbed");

    h.prepare(notes);
    const second = notes.map((_, i) => h.deltaAt(i));
    assert.deepEqual(second, first, "re-preparing must reproduce the same deltas");
    assert.deepEqual(h.stats.patterns, firstStats.patterns);
    assert.equal(h.stats.notes, firstStats.notes);
  });

  it("does not carry drift state over from a previous chart", () => {
    // Reusing one humanizer for a different chart must give the same result as a
    // fresh one: the OU and walk processes, the per-column history and the
    // stream run length all have to start clean.
    const a = longChart(120, 200);
    const b: SiteHitObject[] = [];
    for (let i = 0; i < 120; i++) b.push(tap(0, 1000 + i * 70)); // a long jack run

    const shared = prepared(a);
    shared.prepare(b);
    const reused = b.map((_, i) => shared.deltaAt(i));

    const fresh = prepared(b);
    const clean = b.map((_, i) => fresh.deltaAt(i));

    assert.deepEqual(reused, clean, "a reused humanizer kept state from the previous chart");
  });
});

describe("humanizer: chord coherence", () => {
  it("gives every note of a chord the same delta", () => {
    // Three columns at one instant, plus surrounding context so drift is active.
    const notes: SiteHitObject[] = [
      tap(0, 1000),
      tap(1, 1400),
      tap(0, 2000), tap(1, 2000), tap(2, 2000), tap(3, 2000),
      tap(2, 2600),
      tap(3, 3200),
    ];
    const d = deltas(notes, { strength: 1 });
    const chord = [d[2], d[3], d[4], d[5]];
    assert.ok(chord[0] !== 0, "the chord should actually be shifted");
    assert.ok(
      chord.every((v) => v === chord[0]),
      `chord smeared into an arpeggio: ${chord.join(", ")}`,
    );
  });

  it("keeps a chord coherent regardless of how many columns it spans", () => {
    for (const size of [2, 3, 5, 7, 10]) {
      const notes: SiteHitObject[] = [tap(0, 800)];
      for (let c = 0; c < size; c++) notes.push(tap(c, 1600));
      notes.push(tap(1, 2400));
      const d = deltas(notes, { strength: 1, patternAware: 0 });
      const chord = d.slice(1, 1 + size);
      assert.ok(chord.every((v) => v === chord[0]), `${size}-note chord not coherent`);
    }
  });
});

describe("humanizer: ordering invariants", () => {
  it("never lets a hold's release pass the next press on that column", () => {
    // The failure this guards is silent: the site's hit() early-returns while a
    // column is already down, so an inverted pair loses the note and pins the key.
    const notes: SiteHitObject[] = [
      hold(0, 1000, 2000),
      tap(0, 2200),
      hold(0, 2400, 3400),
      tap(0, 3600),
      hold(1, 1000, 3000),
      tap(1, 3100),
    ];
    for (const strength of [0.2, 0.5, 1]) {
      for (const seed of [1, 2, 3, 99]) {
        const h = prepared(notes, { strength, seed, fatigue: 1, longTermDrift: 1 });
        const shifted = notes.map((n, i) => ({ note: n, delta: h.deltaAt(i) }));

        for (const column of [0, 1]) {
          const inColumn = shifted.filter((s) => s.note.column === column);
          for (let i = 1; i < inColumn.length; i++) {
            const prev = inColumn[i - 1];
            const curr = inColumn[i];
            const prevEnd =
              (prev.note.type === "hold" ? prev.note.endTime : prev.note.time) + prev.delta;
            const currStart = curr.note.time + curr.delta;
            assert.ok(
              currStart > prevEnd,
              `inverted on column ${column} at strength ${strength} seed ${seed}: ` +
                `prev end ${prevEnd}, next start ${currStart}`,
            );
          }
        }
      }
    }
  });

  it("keeps a note starting exactly where a hold ends glued to that hold", () => {
    // Boundary case: identical timestamps, so the pair must share one delta and
    // rely on construction order (release before press) rather than on time.
    const notes: SiteHitObject[] = [hold(2, 1000, 2000), tap(2, 2000), tap(0, 2600)];
    for (const seed of [1, 5, 42]) {
      const h = prepared(notes, { strength: 1, seed });
      const d = notes.map((_, i) => h.deltaAt(i));
      assert.equal(d[1], d[0], `boundary note must inherit the hold's delta (seed ${seed})`);
    }
  });

  it("keeps dense jacks separated by at least the tap-hold deferral", () => {
    const notes: SiteHitObject[] = [];
    for (let i = 0; i < 60; i++) notes.push(tap(1, 1000 + i * 20));
    for (const seed of [1, 2, 3]) {
      const h = prepared(notes, { strength: 1, seed, patternAware: 0 });
      const d = notes.map((_, i) => h.deltaAt(i));
      for (let i = 1; i < notes.length; i++) {
        const prevPress = notes[i - 1].time + d[i - 1];
        const currPress = notes[i].time + d[i];
        assert.ok(
          currPress >= prevPress + MIN_TAP_HOLD_MS,
          `jack collapsed at ${i} (seed ${seed}): ${prevPress} -> ${currPress}`,
        );
      }
    }
  });

  it("never shifts a note before the chart starts", () => {
    const notes: SiteHitObject[] = [tap(0, 5), tap(1, 10), tap(2, 15), tap(3, 20)];
    const d = deltas(notes, { strength: 1, seed: 9 });
    notes.forEach((note, i) => {
      assert.ok(note.time + d[i] >= 0, `note shifted to a negative time: ${note.time + d[i]}`);
    });
  });

  it("counts how many deltas had to be clamped", () => {
    // Impossibly tight jacks force clamping.
    const notes: SiteHitObject[] = [];
    for (let i = 0; i < 40; i++) notes.push(tap(0, 1000 + i * 5));
    const h = prepared(notes, { strength: 1, seed: 3, patternAware: 0 });
    assert.ok(h.stats.clamped > 0, "a 5ms jack at full strength must clamp");
  });
});

describe("humanizer: hold handling", () => {
  it("moves a hold's head and tail together by default", () => {
    // The note delta applies to both edges, so duration is preserved unless the
    // separate release variation is switched on.
    const notes = [hold(0, 1000, 1800), tap(1, 2400)];
    const h = prepared(notes, { holdReleaseVariation: 0, strength: 1 });
    const d = h.deltaAt(0);
    assert.equal(h.releaseExtraAt(0, notes[0]), 0, "release variation is off");
    assert.ok(Number.isFinite(d));
  });

  it("adds independent variation to a hold's release when enabled", () => {
    const notes = [hold(0, 1000, 1800), hold(1, 2000, 2900), hold(2, 3000, 3600)];
    const h = prepared(notes, { holdReleaseVariation: 1, strength: 0.8 });
    const releases = notes.map((n, i) => h.releaseExtraAt(i, n));
    assert.ok(releases.some((r) => r !== 0), "release edges should vary");
    assert.ok(
      new Set(releases.map((r) => r.toFixed(3))).size > 1,
      "release deltas should not all be identical",
    );
  });

  it("returns no release variation for taps", () => {
    const notes = [tap(0, 1000), tap(1, 1400)];
    const h = prepared(notes, { holdReleaseVariation: 1 });
    assert.equal(h.releaseExtraAt(0, notes[0]), 0);
    assert.equal(h.releaseExtraAt(1, notes[1]), 0);
  });

  it("returns no release variation for a zero-length hold", () => {
    const notes = [hold(0, 1000, 1000)];
    const h = prepared(notes, { holdReleaseVariation: 1 });
    assert.equal(h.releaseExtraAt(0, notes[0]), 0);
  });
});

describe("humanizer: drift and fatigue", () => {
  it("short-term drift mean-reverts instead of accumulating", () => {
    // An Ornstein-Uhlenbeck process should keep returning toward zero, so the
    // running mean of the deltas must stay small relative to the spread.
    const notes = longChart(1500, 120);
    const d = deltas(notes, { strength: 1, shortTermDrift: 1, longTermDrift: 0, fatigue: 0, patternAware: 0 });
    const mean = d.reduce((a, b) => a + b, 0) / d.length;
    const sd = Math.sqrt(d.reduce((a, b) => a + (b - mean) ** 2, 0) / d.length);
    assert.ok(sd > 0, "there should be spread");
    assert.ok(Math.abs(mean) < sd * 0.6, `mean ${mean} drifted too far for sd ${sd}`);
  });

  it("long-term drift moves further than short-term drift alone", () => {
    const notes = longChart(1500, 120);
    const spreadOf = (overrides: Partial<HumanizationConfig>) => {
      const d = deltas(notes, { strength: 1, fatigue: 0, patternAware: 0, ...overrides });
      const sorted = [...d].sort((a, b) => a - b);
      // Compare the tails: drift shows up as extreme values, not as sd.
      return Math.max(Math.abs(sorted[0]), Math.abs(sorted[sorted.length - 1]));
    };
    const shortOnly = spreadOf({ shortTermDrift: 1, longTermDrift: 0 });
    const both = spreadOf({ shortTermDrift: 1, longTermDrift: 1 });
    assert.ok(both >= shortOnly * 0.9, `long drift should widen the tails (${shortOnly} vs ${both})`);
  });

  it("long-term drift stays bounded", () => {
    // It must not be able to become a large accidental offset — that is what the
    // Timing Offset control is for. Bound the walk component specifically; the
    // random component is unbounded by nature.
    const notes = longChart(4000, 60);
    const d = deltas(notes, {
      strength: 1,
      longTermDrift: 1,
      shortTermDrift: 0,
      fatigue: 0,
      patternAware: 0,
      distribution: "uniform", // bounded, so the sum is bounded too
    });
    const walkLimit = 12 * 1 * 1 * 3; // BASE_SD_MS * strength * longTermDrift * 3
    const randomLimit = 12 * 1 * Math.sqrt(3); // uniform half-width
    for (const v of d) {
      assert.ok(
        Math.abs(v) <= walkLimit + randomLimit + 1e-6,
        `drift escaped its bound: ${v}`,
      );
    }
  });

  it("bounds the short-term drift process too", () => {
    // Mean reversion only bounds an OU process in expectation, so it is clamped
    // explicitly. Without that, a long chart could accumulate a wobble large
    // enough to act as an unintended offset.
    const notes = longChart(4000, 60);
    const d = deltas(notes, {
      strength: 1,
      shortTermDrift: 1,
      longTermDrift: 0,
      fatigue: 0,
      patternAware: 0,
      distribution: "uniform",
    });
    const ouLimit = 12 * 1 * (1 + 1 * 3);
    const stepLimit = 12 * 1 * 1 * 0.5 * Math.sqrt(3);
    const randomLimit = 12 * 1 * Math.sqrt(3);
    for (const v of d) {
      assert.ok(
        Math.abs(v) <= ouLimit + stepLimit + randomLimit + 1e-6,
        `short-term drift escaped its bound: ${v}`,
      );
    }
  });

  it("fatigue shifts the second half of a chart later than the first", () => {
    const notes = longChart(1000, 150);
    const d = deltas(notes, { strength: 0.8, fatigue: 1, shortTermDrift: 0, longTermDrift: 0, patternAware: 0 });
    const half = Math.floor(d.length / 2);
    const firstMean = d.slice(0, half).reduce((a, b) => a + b, 0) / half;
    const secondMean = d.slice(half).reduce((a, b) => a + b, 0) / (d.length - half);
    assert.ok(secondMean > firstMean, `fatigue should bias late (${firstMean} -> ${secondMean})`);
  });

  it("fatigue increases inconsistency later in the chart", () => {
    const notes = longChart(1000, 150);
    const d = deltas(notes, { strength: 0.8, fatigue: 1, shortTermDrift: 0, longTermDrift: 0, patternAware: 0 });
    const half = Math.floor(d.length / 2);
    const sdOf = (slice: number[]) => {
      const m = slice.reduce((a, b) => a + b, 0) / slice.length;
      return Math.sqrt(slice.reduce((a, b) => a + (b - m) ** 2, 0) / slice.length);
    };
    assert.ok(sdOf(d.slice(half)) > sdOf(d.slice(0, half)), "spread should grow with fatigue");
  });

  it("produces no fatigue bias when fatigue is 0", () => {
    const notes = longChart(800, 150);
    const d = deltas(notes, { strength: 0.8, fatigue: 0, shortTermDrift: 0, longTermDrift: 0, patternAware: 0 });
    const half = Math.floor(d.length / 2);
    const firstMean = d.slice(0, half).reduce((a, b) => a + b, 0) / half;
    const secondMean = d.slice(half).reduce((a, b) => a + b, 0) / (d.length - half);
    assert.ok(Math.abs(secondMean - firstMean) < 1.5, `unexpected bias (${firstMean} -> ${secondMean})`);
  });
});

describe("humanizer: pattern awareness", () => {
  it("classifies jacks, streams, chords, holds and isolated notes", () => {
    // Written in ascending time order, which is the order the humanizer is fed
    // in. Classification is relative to the previous note on the same column.
    const notes: SiteHitObject[] = [
      tap(0, 1000), // isolated (no previous note on column 0)
      tap(1, 2000), // isolated
      tap(0, 3000), // isolated (1000ms after the previous column-0 note)
      tap(0, 3050), // jack (50ms later on the same column)
      tap(0, 3190), // stream (140ms later — inside the 160ms threshold)
      tap(1, 4000), tap(2, 4000), // chord (two columns, one instant)
      hold(3, 5000, 5600), // hold
    ];
    // A chord is a property of a group, not of one note's local context, so it
    // is handled by delta sharing and counted separately as `chordMembers`.
    const h = prepared(notes, { strength: 0.5 });
    const p = h.stats.patterns;
    // Five isolated: tap(0,1000), tap(1,2000), tap(0,3000) (2000ms after the
    // previous column-0 note), and BOTH notes of the 4000 pair — classification
    // looks backwards only, so tap(1,4000) and tap(2,4000) each have no recent
    // same-column history. A chord is a group property, which is why it is
    // counted separately as chordMembers and handled by delta sharing.
    assert.equal(p.isolated, 5, `isolated ${p.isolated}`);
    assert.equal(p.jacks, 1, `jacks ${p.jacks}`);
    assert.equal(p.streams, 1, `streams ${p.streams}`);
    assert.equal(p.chordMembers, 1, `one extra note shares a timestamp: ${p.chordMembers}`);
    assert.equal(
      p.isolated + p.jacks + p.streams + p.holds,
      notes.length,
      "every note is classified exactly once",
    );
    assert.equal(p.holds, 1, `holds ${p.holds}`);
    assert.equal(p.longestStream, 2, `jack + stream form a run of 2, got ${p.longestStream}`);
  });

  it("varies a tight jack less than an isolated note", () => {
    // A player locked into a rhythm is more consistent relative to themselves.
    // Same column, 60ms apart: a genuine jack run.
    const jack: SiteHitObject[] = [];
    for (let i = 0; i < 300; i++) jack.push(tap(0, 1000 + i * 60));
    // A different column each time, 900ms apart: never a jack or a stream.
    const isolated: SiteHitObject[] = [];
    for (let i = 0; i < 300; i++) isolated.push(tap(i % 4, 1000 + i * 900));

    const sdOf = (notes: SiteHitObject[], aware: number) => {
      const d = deltas(notes, { strength: 1, patternAware: aware, shortTermDrift: 0, longTermDrift: 0, fatigue: 0 });
      const m = d.reduce((a, b) => a + b, 0) / d.length;
      return Math.sqrt(d.reduce((a, b) => a + (b - m) ** 2, 0) / d.length);
    };

    const tightAware = sdOf(jack, 1);
    const tightUnaware = sdOf(jack, 0);
    const looseAware = sdOf(isolated, 1);
    assert.ok(tightAware < tightUnaware, `pattern awareness should tighten jacks (${tightAware} vs ${tightUnaware})`);
    assert.ok(
      Math.abs(looseAware - sdOf(isolated, 0)) < 1e-9,
      "isolated notes should be unaffected by pattern awareness",
    );
  });

  it("keeps relative timing tight inside a repeated jack", () => {
    // What matters rhythmically is the interval between successive hits, not the
    // absolute offset. With full pattern awareness a perfect jack should stay
    // close to perfectly spaced.
    const notes: SiteHitObject[] = [];
    for (let i = 0; i < 200; i++) notes.push(tap(0, 1000 + i * 60));
    const d = deltas(notes, { strength: 1, patternAware: 1, shortTermDrift: 0, longTermDrift: 0, fatigue: 0 });
    const intervals = d.slice(1).map((v, i) => 60 + (v - d[i]));
    const mean = intervals.reduce((a, b) => a + b, 0) / intervals.length;
    const sd = Math.sqrt(intervals.reduce((a, b) => a + (b - mean) ** 2, 0) / intervals.length);
    const absoluteSd = Math.sqrt(d.reduce((a, b) => a + b * b, 0) / d.length);
    assert.ok(sd < absoluteSd, `interval sd ${sd} should be below absolute sd ${absoluteSd}`);
  });
});

describe("humanizer: distributions", () => {
  it("gaussian and uniform have comparable spread", () => {
    const notes = longChart(3000, 100);
    const sdOf = (distribution: "gaussian" | "uniform") => {
      const d = deltas(notes, { strength: 0.6, distribution, shortTermDrift: 0, longTermDrift: 0, fatigue: 0, patternAware: 0 });
      const m = d.reduce((a, b) => a + b, 0) / d.length;
      return Math.sqrt(d.reduce((a, b) => a + (b - m) ** 2, 0) / d.length);
    };
    const g = sdOf("gaussian");
    const u = sdOf("uniform");
    // Same variance by construction (uniform is scaled to sd*sqrt(3) half-width).
    assert.ok(Math.abs(g - u) / g < 0.2, `gaussian sd ${g} vs uniform sd ${u}`);
  });

  it("uniform never exceeds its bounds", () => {
    const notes = longChart(2000, 100);
    const d = deltas(notes, { strength: 0.6, distribution: "uniform", shortTermDrift: 0, longTermDrift: 0, fatigue: 0, patternAware: 0 });
    const bound = 12 * 0.6 * Math.sqrt(3);
    for (const v of d) assert.ok(Math.abs(v) <= bound + 1e-9, `uniform escaped its bound: ${v}`);
  });

  it("gaussian occasionally exceeds one sd, as it should", () => {
    const notes = longChart(3000, 100);
    const d = deltas(notes, { strength: 0.6, distribution: "gaussian", shortTermDrift: 0, longTermDrift: 0, fatigue: 0, patternAware: 0 });
    const sd = 12 * 0.6;
    assert.ok(d.some((v) => Math.abs(v) > sd), "a gaussian should have tails beyond 1 sd");
  });
});

describe("sanitizeHumanization", () => {
  it("returns defaults for garbage input", () => {
    for (const bad of [undefined, null, 42, "nope", []]) {
      const out = sanitizeHumanization(bad);
      assert.deepEqual(out, DEFAULT_HUMANIZATION);
    }
  });

  it("clamps every weight into [0, 1]", () => {
    const out = sanitizeHumanization({
      enabled: true,
      strength: 99,
      shortTermDrift: -5,
      longTermDrift: Number.NaN,
      patternAware: Infinity,
      holdReleaseVariation: 2,
      fatigue: 0.4,
    });
    assert.equal(out.strength, 1);
    assert.equal(out.shortTermDrift, 0);
    assert.equal(out.longTermDrift, DEFAULT_HUMANIZATION.longTermDrift, "NaN falls back to the default");
    assert.equal(out.patternAware, 1);
    assert.equal(out.holdReleaseVariation, 1);
    assert.equal(out.fatigue, 0.4);
  });

  it("normalises the seed to a non-negative 32-bit integer", () => {
    assert.equal(sanitizeHumanization({ seed: -7 }).seed, 7);
    assert.equal(sanitizeHumanization({ seed: 1.9 }).seed, 1);
    assert.equal(sanitizeHumanization({ seed: Number.NaN }).seed, 0);
    assert.ok(sanitizeHumanization({ seed: 2 ** 40 }).seed >= 0);
  });

  it("rejects an unknown distribution", () => {
    assert.equal(sanitizeHumanization({ distribution: "poisson" }).distribution, "gaussian");
    assert.equal(sanitizeHumanization({ distribution: "uniform" }).distribution, "uniform");
  });

  it("only enables on an explicit true", () => {
    assert.equal(sanitizeHumanization({ enabled: "yes" }).enabled, false);
    assert.equal(sanitizeHumanization({ enabled: 1 }).enabled, false);
    assert.equal(sanitizeHumanization({ enabled: true }).enabled, true);
  });
});

describe("humanizer: timeline integration", () => {
  it("produces a byte-identical timeline when disabled", () => {
    const notes: SiteHitObject[] = sortByTime([tap(0, 1000), tap(1, 1200), ...holdAsSite(2, 1400, 2000)]);
    const chart = chartOf(notes);
    const plain = buildTimeline(chart, { keyMapping: mapping(["KeyD", "KeyF", "KeyJ", "KeyK"]) });
    const off = buildTimeline(chart, {
      keyMapping: mapping(["KeyD", "KeyF", "KeyJ", "KeyK"]),
      humanizer: new Humanizer({ config: config({ enabled: false }), minTapHoldMs: MIN_TAP_HOLD_MS }),
    });
    assert.deepEqual(
      off.actions.map((a) => [a.time, a.type, a.column, a.code, a.simultaneous]),
      plain.actions.map((a) => [a.time, a.type, a.column, a.code, a.simultaneous]),
    );
  });

  it("keeps a chord on one timestamp after perturbation", () => {
    const notes: SiteHitObject[] = sortByTime([
      tap(0, 1000),
      tap(0, 2000), tap(1, 2000), tap(2, 2000), tap(3, 2000),
      tap(1, 3000),
    ]);
    const timeline = buildTimeline(chartOf(notes), {
      keyMapping: mapping(["KeyD", "KeyF", "KeyJ", "KeyK"]),
      humanizer: prepared(notes, { strength: 1 }),
    });
    const downs = timeline.actions.filter((a) => a.type === "down");
    const chordTimes = downs.slice(1, 5).map((a) => a.time);
    assert.equal(new Set(chordTimes).size, 1, `chord spread across ${new Set(chordTimes).size} timestamps`);
  });

  it("emits a hold's release before the next press on that column", () => {
    const notes: SiteHitObject[] = sortByTime([
      hold(0, 1000, 2000),
      tap(0, 2000),
      tap(1, 2500),
      hold(0, 3000, 4000),
      tap(0, 4200),
    ]);
    for (const seed of [1, 2, 7, 55]) {
      const timeline = buildTimeline(chartOf(notes), {
        keyMapping: mapping(["KeyD", "KeyF", "KeyJ", "KeyK"]),
        humanizer: prepared(notes, { strength: 1, seed, holdReleaseVariation: 1 }),
      });
      const column0 = timeline.actions.filter((a) => a.column === 0);

      // Actions must never go backwards in time.
      for (let i = 1; i < column0.length; i++) {
        assert.ok(
          column0[i].time >= column0[i - 1].time,
          `column 0 went backwards at seed ${seed}: ` +
            `${column0[i - 1].type}@${column0[i - 1].time} then ${column0[i].type}@${column0[i].time}`,
        );
      }

      // The invariant that actually matters: a column must never be pressed
      // twice without a release in between. Two downs in a row means the press
      // landed while the site still held the column, so the site drops it and
      // the key stays pinned.
      //
      // Note what is NOT asserted: a tap's own down and up legitimately share a
      // timestamp (that is what the site's replay does, and the InputManager
      // defers the release), so `down` immediately followed by `up` at the same
      // instant is correct, not an ordering violation.
      let held = false;
      for (const action of column0) {
        if (action.type === "down") {
          assert.ok(!held, `double press on column 0 at seed ${seed}, at ${action.time}`);
          held = true;
        } else {
          assert.ok(held, `release with no press on column 0 at seed ${seed}, at ${action.time}`);
          held = false;
        }
      }
      assert.ok(!held, `column 0 left pressed at seed ${seed}`);

      // And a hold's tail must not pass the press that follows it.
      for (let i = 1; i < column0.length; i++) {
        if (column0[i - 1].type === "up" && column0[i].type === "down") {
          assert.ok(
            column0[i].time >= column0[i - 1].time,
            `hold tail passed the next press at seed ${seed}`,
          );
        }
      }
    }
  });

  it("keeps actions sorted and renumbers seq after perturbation", () => {
    const notes = longChart(400, 90);
    const timeline = buildTimeline(chartOf(notes), {
      keyMapping: mapping(["KeyD", "KeyF", "KeyJ", "KeyK"]),
      humanizer: prepared(notes, { strength: 1 }),
    });
    for (let i = 1; i < timeline.actions.length; i++) {
      assert.ok(timeline.actions[i].time >= timeline.actions[i - 1].time, "actions out of order");
      assert.equal(timeline.actions[i].seq, i, "seq must be renumbered after the sort");
    }
  });

  it("flags simultaneous actions correctly after perturbation", () => {
    const notes: SiteHitObject[] = [tap(0, 1000), tap(1, 1000), tap(2, 2000)];
    const timeline = buildTimeline(chartOf(notes), {
      keyMapping: mapping(["KeyD", "KeyF", "KeyJ", "KeyK"]),
      humanizer: prepared(notes, { strength: 1 }),
    });
    const at1000 = timeline.actions.filter((a) => a.column <= 1 && a.type === "down");
    assert.ok(at1000.every((a) => a.simultaneous), "a perturbed chord is still simultaneous");
    // An isolated tap's own down and up share a timestamp by design — that is
    // exactly what the site's replay does, and `simultaneous` means "shares a
    // timestamp with a neighbour so it must be batched", not "part of a chord".
    // What must NOT happen is the lone note joining the chord's timestamp.
    const loneDown = timeline.actions.find((a) => a.column === 2 && a.type === "down");
    const chordTime = at1000[0].time;
    assert.notEqual(loneDown?.time, chordTime, "the isolated note must not join the chord");
    assert.equal(
      timeline.actions.filter((a) => a.time === loneDown?.time).length,
      2,
      "only its own down and up share the isolated note's timestamp",
    );
  });

  it("does not shift the first action before time zero", () => {
    const notes: SiteHitObject[] = [tap(0, 2), tap(1, 6), tap(2, 10)];
    const timeline = buildTimeline(chartOf(notes), {
      keyMapping: mapping(["KeyD", "KeyF", "KeyJ", "KeyK"]),
      humanizer: prepared(notes, { strength: 1 }),
    });
    assert.ok(timeline.actions.every((a) => a.time >= 0), "an action landed before the chart start");
  });
});
