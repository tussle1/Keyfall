import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { analyseChart, buildTimeline } from "../src/chart/timeline";
import type { KeyMapping, ParsedChart, SiteHitObject } from "../src/types";

function mapping(codes: string[]): KeyMapping {
  return { codes, keyCount: codes.length, source: "site" };
}

function chart(notes: SiteHitObject[], keyCount: number): ParsedChart {
  const times = notes.map((n) => n.time);
  const ends = notes.map((n) => n.endTime);
  return {
    keyCount,
    notes: [...notes].sort((a, b) => a.time - b.time || a.column - b.column),
    noteCount: notes.length,
    startTime: Math.min(...times),
    endTime: Math.max(...ends),
    signature: "test",
  };
}

const tap = (column: number, time: number): SiteHitObject => ({
  type: "tap",
  column,
  time,
  endTime: time,
});
const hold = (column: number, time: number, endTime: number): SiteHitObject => ({
  type: "hold",
  column,
  time,
  endTime,
});

describe("timeline", () => {
  it("emits a press and a release for each tap", () => {
    const t = buildTimeline(chart([tap(0, 1000), tap(1, 1100)], 4), {
      keyMapping: mapping(["KeyD", "KeyF", "KeyJ", "KeyK"]),
    });
    assert.equal(t.actions.length, 4);
    assert.deepEqual(
      t.actions.map((a) => [a.time, a.type, a.column]),
      [
        [1000, "down", 0],
        [1000, "up", 0],
        [1100, "down", 1],
        [1100, "up", 1],
      ],
    );
  });

  it("presses at the hold start and releases at the hold end", () => {
    const t = buildTimeline(chart([hold(2, 1000, 1750)], 4), {
      keyMapping: mapping(["KeyD", "KeyF", "KeyJ", "KeyK"]),
    });
    assert.deepEqual(
      t.actions.map((a) => [a.time, a.type, a.column, a.holdDuration]),
      [
        [1000, "down", 2, 750],
        [1750, "up", 2, 750],
      ],
    );
  });

  it("releases a hold BEFORE pressing a same-instant note on that column", () => {
    // This is the ordering that prevents a swallowed press: if the down came
    // first, the site's `hit()` would see the column already pressed and no-op,
    // then the up would release it immediately.
    const t = buildTimeline(chart([hold(1, 1000, 1500), tap(1, 1500)], 4), {
      keyMapping: mapping(["KeyD", "KeyF", "KeyJ", "KeyK"]),
    });
    const atBoundary = t.actions.filter((a) => a.time === 1500);
    // Three, not two: the tap contributes its own release at the same instant
    // (matching the site's autoplay replay, which emits both at `time`).
    assert.equal(atBoundary.length, 3);
    assert.deepEqual(
      atBoundary.map((a) => a.type),
      ["up", "down", "up"],
      "the hold must release before the tap presses, or the press is swallowed",
    );
    assert.deepEqual(
      atBoundary.map((a) => a.column),
      [1, 1, 1],
    );
  });

  it("preserves site ordering (press before release) for a tap at equal times", () => {
    const t = buildTimeline(chart([tap(0, 1000)], 4), {
      keyMapping: mapping(["KeyD", "KeyF", "KeyJ", "KeyK"]),
    });
    assert.equal(t.actions[0].type, "down");
    assert.equal(t.actions[1].type, "up");
  });

  it("suppresses the duplicated hold-head tap the site stores", () => {
    // The site pushes BOTH {tap, isHoldHead:true} and {hold} for one hold note.
    const notes: SiteHitObject[] = [
      { type: "tap", column: 3, time: 1000, endTime: 1600 }, // head tap
      { type: "hold", column: 3, time: 1000, endTime: 1600 }, // the hold
    ];
    const t = buildTimeline(chart(notes, 4), {
      keyMapping: mapping(["KeyD", "KeyF", "KeyJ", "KeyK"]),
    });
    assert.deepEqual(
      t.actions.map((a) => [a.time, a.type]),
      [
        [1000, "down"],
        [1600, "up"],
      ],
    );
    assert.equal(t.noteCount, 1);
  });

  it("handles simultaneous chords in column order", () => {
    const t = buildTimeline(
      chart([tap(0, 1000), tap(1, 1000), tap(2, 1000), tap(3, 1000)], 4),
      { keyMapping: mapping(["KeyD", "KeyF", "KeyJ", "KeyK"]) },
    );
    const downs = t.actions.filter((a) => a.type === "down");
    assert.deepEqual(
      downs.map((a) => a.column),
      [0, 1, 2, 3],
    );
    assert.ok(downs.every((a) => a.simultaneous), "chord actions must be flagged simultaneous");
  });

  it("keeps overlapping holds independent in the timeline", () => {
    // Column 1 hold 1000-2000, a tap on column 3 at 1200, column 4 hold
    // 1000-1800. The two holds must not interfere with each other or with the
    // tap in between.
    const notes: SiteHitObject[] = [
      hold(0, 1000, 2000),
      tap(2, 1200),
      hold(3, 1000, 1800),
    ];
    const t = buildTimeline(chart(notes, 4), {
      keyMapping: mapping(["KeyD", "KeyF", "KeyJ", "KeyK"]),
    });

    assert.deepEqual(
      t.actions.map((a) => [a.time, a.type, a.column]),
      [
        [1000, "down", 0],
        [1000, "down", 3],
        [1200, "down", 2],
        [1200, "up", 2], // tap release; InputManager defers it by minTapHoldMs
        [1800, "up", 3],
        [2000, "up", 0],
      ],
    );
  });

  it("never releases a hold before its own end time", () => {
    const notes: SiteHitObject[] = [
      hold(0, 1000, 3000),
      hold(1, 1200, 1500),
      hold(2, 1300, 2800),
      tap(3, 1400),
    ];
    const t = buildTimeline(chart(notes, 4), {
      keyMapping: mapping(["KeyD", "KeyF", "KeyJ", "KeyK"]),
    });

    for (const column of [0, 1, 2]) {
      const down = t.actions.find((a) => a.type === "down" && a.column === column);
      const up = t.actions.find((a) => a.type === "up" && a.column === column);
      assert.ok(down && up, `column ${column} needs a press and a release`);
      const source = notes.find((n) => n.column === column && n.type === "hold")!;
      assert.equal(down.time, source.time);
      assert.equal(up.time, source.endTime);
      assert.equal(up.holdDuration, source.endTime - source.time);
    }
  });

  it("handles jacks (rapid same-column repeats)", () => {
    const t = buildTimeline(
      chart([tap(1, 1000), tap(1, 1050), tap(1, 1100), tap(1, 1150)], 4),
      { keyMapping: mapping(["KeyD", "KeyF", "KeyJ", "KeyK"]) },
    );
    assert.equal(t.actions.length, 8);
    assert.equal(t.analysis.jacks, 3);
    assert.equal(t.analysis.minJackInterval, 50);
  });

  it("assigns monotonic seq numbers after sorting", () => {
    const t = buildTimeline(
      chart([tap(0, 1000), tap(1, 1000), tap(2, 900)], 4),
      { keyMapping: mapping(["KeyD", "KeyF", "KeyJ", "KeyK"]) },
    );
    assert.deepEqual(
      t.actions.map((a) => a.seq),
      t.actions.map((_, i) => i),
    );
    assert.equal(t.actions[0].time, 900);
  });

  it("applies a timing offset to every action", () => {
    const t = buildTimeline(chart([tap(0, 1000), hold(1, 1200, 1800)], 4), {
      keyMapping: mapping(["KeyD", "KeyF", "KeyJ", "KeyK"]),
      offset: -15,
    });
    assert.deepEqual(
      t.actions.map((a) => a.time),
      [985, 985, 1185, 1785],
    );
  });

  it("emits actions for secondary keybinds when enabled", () => {
    const t = buildTimeline(chart([tap(0, 1000)], 4), {
      keyMapping: mapping(["KeyD", "KeyF", "KeyJ", "KeyK"]),
      useSecondaryKeybind: true,
      secondaryCodes: ["KeyS", null, null, null],
    });
    const downs = t.actions.filter((a) => a.type === "down");
    assert.deepEqual(
      downs.map((a) => a.code).sort(),
      ["KeyD", "KeyS"],
    );
  });

  it("skips notes whose column is out of range instead of throwing", () => {
    const t = buildTimeline(chart([tap(0, 1000), tap(9, 1100)], 4), {
      keyMapping: mapping(["KeyD", "KeyF", "KeyJ", "KeyK"]),
    });
    assert.equal(t.actions.some((a) => a.column === 9), false);
    assert.equal(t.actions.length, 2); // only column 0's press+release
  });

  it("throws when the mapping is too short for the chart", () => {
    assert.throws(
      () => buildTimeline(chart([tap(0, 1000)], 7), { keyMapping: mapping(["KeyD", "KeyF"]) }),
      /covers 2 columns but the chart needs 7/,
    );
  });

  it("sorts notePressTimes for binary-search progress", () => {
    const t = buildTimeline(
      chart([tap(0, 1500), tap(1, 1000), tap(2, 1200)], 4),
      { keyMapping: mapping(["KeyD", "KeyF", "KeyJ", "KeyK"]) },
    );
    assert.deepEqual(t.notePressTimes, [1000, 1200, 1500]);
  });
});

describe("analyseChart", () => {
  it("counts taps and holds once each", () => {
    const notes = [tap(0, 1000), tap(1, 1100), hold(2, 1200, 1600)];
    const analysis = analyseChart(notes, []);
    assert.equal(analysis.taps, 2);
    assert.equal(analysis.holds, 1);
  });

  it("detects chords and the largest chord size", () => {
    const notes = [tap(0, 1000), tap(1, 1000), tap(2, 1000), tap(3, 1200)];
    const analysis = analyseChart(notes, []);
    assert.equal(analysis.largestChord, 3);
    assert.equal(analysis.chords, 3);
  });

  it("measures peak NPS over a one second window", () => {
    // 10 notes inside 500ms, then a gap.
    const notes = Array.from({ length: 10 }, (_, i) => tap(i % 4, 1000 + i * 50));
    notes.push(tap(0, 5000));
    const presses = notes.map((n, i) => ({
      seq: i,
      time: n.time,
      type: "down" as const,
      column: n.column,
      code: "KeyD",
      simultaneous: false,
      holdDuration: 0,
    }));
    const analysis = analyseChart(notes, presses);
    assert.equal(analysis.peakNps, 10);
  });

  it("measures the longest stream", () => {
    const notes = Array.from({ length: 8 }, (_, i) => tap(i % 4, 1000 + i * 40));
    const presses = notes.map((n, i) => ({
      seq: i,
      time: n.time,
      type: "down" as const,
      column: n.column,
      code: "KeyD",
      simultaneous: false,
      holdDuration: 0,
    }));
    const analysis = analyseChart(notes, presses);
    assert.equal(analysis.longestStream, 8);
  });

  it("does not divide by zero on a single-note chart", () => {
    const analysis = analyseChart([tap(0, 1000)], []);
    assert.ok(Number.isFinite(analysis.averageNps));
    assert.equal(analysis.minJackInterval, 0);
  });
});
