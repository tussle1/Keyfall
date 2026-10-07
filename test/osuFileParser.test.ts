import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { countUniqueNotes, parseOsuFile } from "../src/detect/osuFileParser";
import type { HoldNote } from "../src/types";

/** Build a minimal but valid mania `.osu` file. */
function osu(options: {
  keyCount?: number;
  mode?: number;
  hitObjects?: string[];
  title?: string;
  version?: string;
}): string {
  const { keyCount = 4, mode = 3, hitObjects = [], title = "Test Song", version = "Insane" } = options;
  return [
    "osu file format v14",
    "",
    "[General]",
    "AudioFilename: audio.mp3",
    `Mode: ${mode}`,
    "",
    "[Metadata]",
    `Title:${title}`,
    `TitleUnicode:${title}`,
    "Artist:Test Artist",
    "ArtistUnicode:Test Artist",
    "Creator:Someone",
    `Version:${version}`,
    "",
    "[Difficulty]",
    "HPDrainRate:7",
    `CircleSize:${keyCount}`,
    "OverallDifficulty:7",
    "",
    "[TimingPoints]",
    "0,300,4,1,0,100,1,0",
    "",
    "[HitObjects]",
    ...hitObjects,
    "",
  ].join("\n");
}

/** `x,y,time,type,hitSound,sampleSet` */
const tap = (column: number, time: number, keyCount = 4): string => {
  const x = Math.floor(((column + 0.5) * 512) / keyCount);
  return `${x},0,${time},1,0,0:0:0:0:`;
};
const hold = (column: number, time: number, endTime: number, keyCount = 4): string => {
  const x = Math.floor(((column + 0.5) * 512) / keyCount);
  return `${x},0,${time},128,0,${endTime}:0:0:0:0:`;
};

describe("osuFileParser", () => {
  it("parses key count, notes and columns", () => {
    // No mods, first note at >= 1000ms so delay is 0 and times stay put.
    const chart = parseOsuFile(
      osu({ keyCount: 4, hitObjects: [tap(0, 1000), tap(1, 1200), tap(2, 1400), tap(3, 1600)] }),
    );
    assert.ok(chart, "chart should parse");
    assert.equal(chart.keyCount, 4);
    assert.equal(chart.noteCount, 4);
    assert.deepEqual(
      chart.notes.map((n) => n.column),
      [0, 1, 2, 3],
    );
    assert.deepEqual(
      chart.notes.map((n) => n.time),
      [1000, 1200, 1400, 1600],
    );
  });

  it("computes the column from x the same way the site does", () => {
    // x = 0 must land in column 0 even for wide key counts.
    const chart = parseOsuFile(osu({ keyCount: 7, hitObjects: ["0,0,1000,1,0,0:0:0:0:"] }));
    assert.ok(chart);
    assert.equal(chart.notes[0].column, 0);

    // x = 511 must land in the last column.
    const last = parseOsuFile(osu({ keyCount: 7, hitObjects: ["511,0,1000,1,0,0:0:0:0:"] }));
    assert.ok(last);
    assert.equal(last.notes[0].column, 6);
  });

  it("clamps out-of-range x instead of producing a bad column", () => {
    const chart = parseOsuFile(
      osu({ keyCount: 4, hitObjects: ["9999,0,1000,1,0,0:0:0:0:", "-50,0,1100,1,0,0:0:0:0:"] }),
    );
    assert.ok(chart);
    assert.equal(chart.notes[0].column, 3);
    assert.equal(chart.notes[1].column, 0);
  });

  it("parses hold notes with their duration", () => {
    const chart = parseOsuFile(
      osu({ keyCount: 4, hitObjects: [hold(1, 1000, 1800)] }),
    );
    assert.ok(chart);
    const holds = chart.notes.filter((n) => n.type === "hold") as HoldNote[];
    assert.equal(holds.length, 1);
    assert.equal(holds[0].column, 1);
    assert.equal(holds[0].time, 1000);
    assert.equal(holds[0].endTime, 1800);
  });

  it("emits a head tap AND a hold for every hold, matching the site", () => {
    const chart = parseOsuFile(osu({ keyCount: 4, hitObjects: [hold(2, 1000, 1500)] }));
    assert.ok(chart);
    // The site's parser pushes both objects; noteCount must still report 1.
    assert.equal(chart.notes.length, 2);
    assert.equal(chart.noteCount, 1);
    assert.equal(countUniqueNotes(chart.notes), 1);
  });

  it("counts a hold head once whichever way the pair is ordered", () => {
    // The head and its hold share a timestamp, so a comparator that breaks ties
    // on the type string puts "hold" first. An earlier implementation compared
    // each tap against the *next* element and silently over-counted in that
    // order. This must be order-independent.
    const head = { type: "tap", column: 0, time: 1000, endTime: 2000 } as const;
    const body = { type: "hold", column: 0, time: 1000, endTime: 2000 } as const;

    assert.equal(countUniqueNotes([head, body]), 1, "head first");
    assert.equal(countUniqueNotes([body, head]), 1, "hold first");
    assert.equal(countUniqueNotes([{ ...head, isHoldHead: true }, body]), 1, "explicit flag, head first");
    assert.equal(countUniqueNotes([body, { ...head, isHoldHead: true }]), 1, "explicit flag, hold first");
  });

  it("still counts a genuine tap whose endTime happens to exceed its time", () => {
    // endTime > time alone must not be enough to discard a note: it is only a
    // head if a matching hold actually exists.
    const orphan = { type: "tap", column: 1, time: 1000, endTime: 2000 } as const;
    assert.equal(countUniqueNotes([orphan]), 1, "no matching hold -> counted");
    assert.equal(
      countUniqueNotes([orphan, { type: "hold", column: 2, time: 1000, endTime: 2000 } as const]),
      2,
      "a hold on a different column does not claim it",
    );
    assert.equal(
      countUniqueNotes([orphan, { type: "hold", column: 1, time: 1000, endTime: 2500 } as const]),
      2,
      "a hold with a different end time does not claim it",
    );
  });

  it("collapses holds into taps under holdOff", () => {
    const chart = parseOsuFile(osu({ keyCount: 4, hitObjects: [hold(2, 1000, 1500)] }), {
      mods: { holdOff: true },
    });
    assert.ok(chart);
    assert.equal(chart.notes.length, 1);
    assert.equal(chart.notes[0].type, "tap");
    assert.equal(chart.noteCount, 1);
  });

  it("applies mirror by flipping columns", () => {
    const chart = parseOsuFile(
      osu({ keyCount: 4, hitObjects: [tap(0, 1000), tap(3, 1100)] }),
      { mods: { mirror: true } },
    );
    assert.ok(chart);
    assert.deepEqual(
      chart.notes.map((n) => n.column),
      [3, 0],
    );
  });

  it("flags random as unreliable rather than guessing a permutation", () => {
    const chart = parseOsuFile(osu({ keyCount: 4, hitObjects: [tap(0, 1000)] }), {
      mods: { random: true },
    });
    assert.ok(chart);
    assert.equal(chart.unreliable, true);
    assert.match(chart.unreliableReason ?? "", /Random mod/i);
  });

  it("applies the delay rule: at least one second before the first note", () => {
    // First note at 400ms, rate 1 -> delay = 1000 - 400 = 600.
    const chart = parseOsuFile(osu({ keyCount: 4, hitObjects: [tap(0, 400), tap(1, 600)] }));
    assert.ok(chart);
    assert.equal(chart.notes[0].time, 1000);
    assert.equal(chart.notes[1].time, 1200);
    assert.equal(chart.startTime, 1000);
  });

  it("scales the delay with playback rate, like the site", () => {
    // delay = max(1000 - 400/2, 0) * 2 = 800 * 2 = 1600
    const chart = parseOsuFile(osu({ keyCount: 4, hitObjects: [tap(0, 400)] }), {
      mods: { playbackRate: 2 },
    });
    assert.ok(chart);
    assert.equal(chart.notes[0].time, 400 + 1600);
  });

  it("does NOT divide note times by playback rate (the site applies rate to audio)", () => {
    const normal = parseOsuFile(osu({ keyCount: 4, hitObjects: [tap(0, 2000)] }));
    const fast = parseOsuFile(osu({ keyCount: 4, hitObjects: [tap(0, 2000)] }), {
      mods: { playbackRate: 1.5 },
    });
    assert.ok(normal && fast);
    assert.equal(normal.notes[0].time, fast.notes[0].time);
  });

  it("shifts notes by the audio offset with the correct sign", () => {
    // time += delay - audioOffset, so a positive offset moves notes earlier.
    const chart = parseOsuFile(osu({ keyCount: 4, hitObjects: [tap(0, 1000)] }), {
      audioOffset: 50,
    });
    assert.ok(chart);
    assert.equal(chart.notes[0].time, 950);

    const negative = parseOsuFile(osu({ keyCount: 4, hitObjects: [tap(0, 1000)] }), {
      audioOffset: -30,
    });
    assert.ok(negative);
    assert.equal(negative.notes[0].time, 1030);
  });

  it("supports key counts from 1K to 18K", () => {
    for (const keyCount of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 14, 16, 18]) {
      const objects = Array.from({ length: keyCount }, (_, c) => tap(c, 1000 + c * 100, keyCount));
      const chart = parseOsuFile(osu({ keyCount, hitObjects: objects }));
      assert.ok(chart, `${keyCount}K should parse`);
      assert.equal(chart.keyCount, keyCount, `${keyCount}K key count`);
      assert.equal(chart.noteCount, keyCount, `${keyCount}K note count`);
      // Every column 0..keyCount-1 must be represented exactly once.
      assert.deepEqual(
        chart.notes.map((n) => n.column).sort((a, b) => a - b),
        Array.from({ length: keyCount }, (_, i) => i),
      );
    }
  });

  it("rejects non-mania charts", () => {
    assert.equal(parseOsuFile(osu({ mode: 0, hitObjects: [tap(0, 1000)] })), null);
    assert.equal(parseOsuFile(osu({ mode: 1, hitObjects: [tap(0, 1000)] })), null);
    assert.equal(parseOsuFile(osu({ mode: 2, hitObjects: [tap(0, 1000)] })), null);
  });

  it("rejects charts with no hit objects", () => {
    assert.equal(parseOsuFile(osu({ hitObjects: [] })), null);
  });

  it("rejects an invalid key count", () => {
    assert.equal(parseOsuFile(osu({ keyCount: 0, hitObjects: [tap(0, 1000)] })), null);
    assert.equal(parseOsuFile(osu({ keyCount: 99, hitObjects: [tap(0, 1000)] })), null);
  });

  it("rejects non-chart text without throwing", () => {
    assert.equal(parseOsuFile(""), null);
    assert.equal(parseOsuFile("hello world"), null);
    assert.equal(parseOsuFile("[General]\nMode: 3\n"), null);
  });

  it("tolerates malformed hit object lines", () => {
    const chart = parseOsuFile(
      osu({
        keyCount: 4,
        hitObjects: [tap(0, 1000), "garbage", "1,2", "x,y,z,w,v,s", tap(1, 1100)],
      }),
    );
    assert.ok(chart);
    assert.equal(chart.noteCount, 2);
  });

  it("sorts notes by time", () => {
    const chart = parseOsuFile(
      osu({ keyCount: 4, hitObjects: [tap(3, 1600), tap(0, 1000), tap(1, 1300)] }),
    );
    assert.ok(chart);
    assert.deepEqual(
      chart.notes.map((n) => n.time),
      [1000, 1300, 1600],
    );
  });

  it("produces a stable signature for identical charts", () => {
    const text = osu({ keyCount: 4, hitObjects: [tap(0, 1000), tap(1, 1100)] });
    const a = parseOsuFile(text);
    const b = parseOsuFile(text);
    assert.ok(a && b);
    assert.equal(a.signature, b.signature);
  });

  it("produces different signatures for different charts", () => {
    const a = parseOsuFile(osu({ keyCount: 4, hitObjects: [tap(0, 1000)] }));
    const b = parseOsuFile(osu({ keyCount: 7, hitObjects: [tap(0, 1000)] }));
    assert.ok(a && b);
    assert.notEqual(a.signature, b.signature);
  });

  it("handles a dense chart without quadratic behaviour", () => {
    const objects: string[] = [];
    for (let i = 0; i < 6000; i++) objects.push(tap(i % 4, 1000 + i * 25));
    const start = performance.now();
    const chart = parseOsuFile(osu({ keyCount: 4, hitObjects: objects }));
    const elapsed = performance.now() - start;
    assert.ok(chart);
    assert.equal(chart.noteCount, 6000);
    assert.ok(elapsed < 2000, `parsing 6000 notes took ${elapsed.toFixed(0)}ms`);
  });
});
