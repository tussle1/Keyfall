import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { Engine } from "../src/engine/engine";
import { SettingsManager } from "../src/core/settings";
import { looksLikeGame } from "../src/detect/fiber";
import { detectSite, NOT_DETECTED_MESSAGE } from "../src/detect/siteDetection";
import { buildContextFromGame, buildKeyMapping, readKeyCount } from "../src/detect/buildContext";
import { installDom, StubElement, type StubEnvironment } from "./helpers/domStub";
import type { GameLike, SiteHitObject } from "../src/types";

let env: StubEnvironment;

beforeEach(() => {
  env = installDom({ start: 0 });
  env.globalsInstalled();
});

afterEach(() => {
  env.globalsRemoved();
});

/* ------------------------------------------------------------------------- */
/* A stand-in for the site's live Game instance                               */
/* ------------------------------------------------------------------------- */

interface FakeGameOptions {
  keyCount?: number;
  hitObjects?: SiteHitObject[];
  keybinds?: (string | null)[];
  autoplayMod?: boolean;
}

/**
 * Builds an object with the same *shape* the real `Game` exposes, plus a
 * miniature `InputSystem` that behaves like the site's: it listens on
 * `document`, maps `event.code` to a column, ignores repeats, and no-ops when
 * the column is already pressed.
 */
function createFakeGame(options: FakeGameOptions = {}) {
  const keyCount = options.keyCount ?? 4;
  const keybinds = options.keybinds ?? ["KeyD", "KeyF", "KeyJ", "KeyK"].slice(0, keyCount);
  while (keybinds.length < keyCount) keybinds.push("KeyX");

  const hitObjects = options.hitObjects ?? [];

  const codeToColumn = new Map(keybinds.map((code, column) => [code, column]));
  const pressedColumns = new Array(keyCount).fill(false);
  const judged: Array<{ column: number; type: "hit" | "release"; at: number }> = [];

  const onKeyDown = (event: any) => {
    if (event.repeat) return;
    const column = codeToColumn.get(event.code);
    if (column === undefined) return;
    if (pressedColumns[column]) return; // the real site no-ops here
    pressedColumns[column] = true;
    judged.push({ column, type: "hit", at: game.timeElapsed });
  };

  const onKeyUp = (event: any) => {
    const column = codeToColumn.get(event.code);
    if (column === undefined) return;
    if (!pressedColumns[column]) return;
    pressedColumns[column] = false;
    judged.push({ column, type: "release", at: game.timeElapsed });
  };

  env.document.addEventListener("keydown", onKeyDown);
  env.document.addEventListener("keyup", onKeyUp);

  const canvas = new StubElement("canvas");
  env.document.body.appendChild(canvas);

  const game: GameLike & { scoreSystem: Record<string, number> } = {
    state: "PLAY",
    timeElapsed: 0,
    startTime: hitObjects.length ? hitObjects[0].time : 0,
    endTime: hitObjects.length ? hitObjects[hitObjects.length - 1].endTime : 0,
    hitObjects,
    difficulty: { keyCount, od: 7, hp: 7 },
    columnKeybinds: keybinds.map((code) => [code, null]),
    settings: {
      keybinds: { keyModes: [], pause: "Escape", retry: null, toggleHud: null },
      mods: { autoplay: options.autoplayMod ?? false, playbackRate: 1 },
    },
    mods: { autoplay: options.autoplayMod ?? false, playbackRate: 1 },
    inputSystem: { pressedColumns, tappedColumns: new Array(keyCount).fill(false) },
    scoreSystem: { score: 0, combo: 0, maxCombo: 0, accuracy: 1, 320: 0, 300: 0, 200: 0, 100: 0, 50: 0, 0: 0 },
    app: { canvas },
  };

  // Wire the site's devtools global and a React-fiber-shaped pointer so the
  // real detection strategies can find it.
  (env.window as any).__PIXI_APP__ = { canvas };
  (canvas as any)["__reactFiber$test"] = {
    child: null,
    sibling: null,
    return: null,
    stateNode: canvas,
    memoizedProps: { game },
    memoizedState: { memoizedState: game, next: null },
  };

  function dispose() {
    env.document.removeEventListener("keydown", onKeyDown);
    env.document.removeEventListener("keyup", onKeyUp);
    canvas.isConnected = false;
    (env.window as any).__PIXI_APP__ = null;
  }

  return { game, canvas, pressedColumns, judged, dispose, keybinds };
}

/* ------------------------------------------------------------------------- */

const tap = (column: number, time: number): SiteHitObject => ({ type: "tap", column, time, endTime: time });
const hold = (column: number, time: number, endTime: number): SiteHitObject => ({
  type: "hold",
  column,
  time,
  endTime,
});

/**
 * A hold exactly as the site stores it: TWO objects. The head is a `tap` whose
 * `endTime` is the hold's end, and it may or may not carry the explicit
 * `isHoldHead` flag (the site sets it, but the marker has to work without it).
 */
const holdAsSite = (
  column: number,
  time: number,
  endTime: number,
  withFlag = true,
): SiteHitObject[] => {
  const head: SiteHitObject = { type: "tap", column, time, endTime };
  if (withFlag) (head as { isHoldHead?: boolean }).isHoldHead = true;
  return [head, hold(column, time, endTime)];
};

describe("site detection", () => {
  it("confirms the production host", () => {
    const check = detectSite(env.window);
    assert.equal(check.verdict, "confirmed");
  });

  it("reports the exact required message on an unrelated site", () => {
    env.window.location.hostname = "example.com";
    const check = detectSite(env.window);
    assert.equal(check.verdict, "unknown");
    assert.equal(check.message, NOT_DETECTED_MESSAGE);
    assert.equal(NOT_DETECTED_MESSAGE, "Web osu!mania not detected.");
  });

  it("accepts the previous deployment hosts", () => {
    for (const host of ["web-osu-mania.pages.dev", "web-osu-mania.vercel.app", "www.webosumania.com"]) {
      env.window.location.hostname = host;
      assert.equal(detectSite(env.window).verdict, "confirmed", host);
    }
  });

  it("treats a local dev server as probable", () => {
    env.window.location.hostname = "localhost";
    assert.equal(detectSite(env.window).verdict, "probable");
  });
});

describe("game acquisition", () => {
  it("recognises a game-shaped object and rejects others", () => {
    const fake = createFakeGame();
    assert.equal(looksLikeGame(fake.game), true);
    assert.equal(looksLikeGame(null), false);
    assert.equal(looksLikeGame({}), false);
    assert.equal(looksLikeGame({ hitObjects: [] }), false);
    assert.equal(looksLikeGame(fake.canvas), false);
    fake.dispose();
  });

  it("finds the game via the site's __PIXI_APP__ global", () => {
    const fake = createFakeGame({ hitObjects: [tap(0, 1000)] });
    const settings = new SettingsManager(undefined, env.window);
    const engine = new Engine({ settings, win: env.window });
    engine.init();

    const diagnostics = engine.getDiagnostics() as any;
    assert.equal(diagnostics.via, "pixiGlobal");
    assert.equal(diagnostics.chart.keyCount, 4);
    assert.equal(diagnostics.chart.notes, 1);
    assert.equal(engine.currentPhase, "READY");

    engine.dispose();
    fake.dispose();
  });

  it("reads the key count from the live difficulty", () => {
    const fake = createFakeGame({ keyCount: 7, keybinds: ["KeyS","KeyD","KeyF","Space","KeyJ","KeyK","KeyL"], hitObjects: [tap(3, 1000)] });
    assert.equal(readKeyCount(fake.game), 7);
    fake.dispose();
  });

  it("builds the mapping from the site's resolved columnKeybinds", () => {
    const fake = createFakeGame({ keyCount: 7, keybinds: ["KeyS","KeyD","KeyF","Space","KeyJ","KeyK","KeyL"], hitObjects: [tap(3, 1000)] });
    const settings = new SettingsManager(undefined, env.window);
    const mapping = buildKeyMapping(fake.game, 7, settings.all);
    assert.equal(mapping.source, "site");
    assert.deepEqual(mapping.codes, ["KeyS","KeyD","KeyF","Space","KeyJ","KeyK","KeyL"]);
    settings.dispose();
    fake.dispose();
  });

  it("refuses to run while the site's own autoplay mod is on", () => {
    const fake = createFakeGame({ autoplayMod: true, hitObjects: [tap(0, 1000)] });
    const settings = new SettingsManager(undefined, env.window);
    const result = buildContextFromGame(fake.game, settings.all, "test");
    assert.equal(result.ok, false);
    assert.match(result.reason ?? "", /built-in Autoplay mod/i);
    settings.dispose();
    fake.dispose();
  });

  it("reports an invalid key count instead of guessing", () => {
    const fake = createFakeGame({ hitObjects: [tap(0, 1000)] });
    (fake.game.difficulty as any).keyCount = 0;
    const settings = new SettingsManager(undefined, env.window);
    const result = buildContextFromGame(fake.game, settings.all, "test");
    assert.equal(result.ok, false);
    assert.match(result.reason ?? "", /Invalid key count/);
    settings.dispose();
    fake.dispose();
  });

  it("reports missing chart data instead of guessing", () => {
    const fake = createFakeGame({ hitObjects: [] });
    const settings = new SettingsManager(undefined, env.window);
    const result = buildContextFromGame(fake.game, settings.all, "test");
    assert.equal(result.ok, false);
    assert.match(result.reason ?? "", /Chart data missing/);
    settings.dispose();
    fake.dispose();
  });
});

describe("end-to-end autoplay", () => {
  it("plays a 4K chart through the site's own input path", () => {
    const fake = createFakeGame({
      hitObjects: [tap(0, 1000), tap(1, 1200), tap(2, 1400), tap(3, 1600)],
    });
    const settings = new SettingsManager(undefined, env.window);
    settings.set("general.showOverlay", false);
    const engine = new Engine({ settings, win: env.window });
    engine.init();
    assert.equal(engine.currentPhase, "READY");

    engine.start();
    assert.equal(engine.currentPhase, "RUNNING");

    // Drive the site's clock forward and let the scheduler run.
    for (let t = 0; t <= 2000; t += 16) {
      fake.game.timeElapsed = t;
      env.advance(16);
      env.frame();
    }

    const hits = fake.judged.filter((j) => j.type === "hit");
    assert.equal(hits.length, 4, `expected 4 hits, got ${hits.length}`);
    assert.deepEqual(
      hits.map((h) => h.column),
      [0, 1, 2, 3],
    );

    // Every press must have a matching release: no stuck keys.
    const releases = fake.judged.filter((j) => j.type === "release");
    assert.equal(releases.length, 4);
    assert.deepEqual(fake.pressedColumns, [false, false, false, false]);
    assert.equal(engine.getDiagnostics().input as any && (engine.getDiagnostics() as any).input.held, 0);

    engine.dispose();
    fake.dispose();
  });

  it("plays hold notes with the correct duration and no overlap", () => {
    const fake = createFakeGame({
      keyCount: 4,
      hitObjects: [hold(0, 1000, 1600), tap(2, 1200), hold(3, 1000, 1400)],
    });
    const settings = new SettingsManager(undefined, env.window);
    settings.set("general.showOverlay", false);
    const engine = new Engine({ settings, win: env.window });
    engine.init();
    engine.start();

    const snapshots: Array<{ t: number; pressed: boolean[] }> = [];
    for (let t = 0; t <= 2000; t += 10) {
      fake.game.timeElapsed = t;
      env.advance(10);
      env.frame();
      snapshots.push({ t, pressed: [...fake.pressedColumns] });
    }

    const at = (t: number) => snapshots.find((s) => s.t === t)?.pressed ?? [];

    // Both holds down at the start.
    assert.deepEqual(at(1000), [true, false, false, true]);
    // The tap lands on column 3 while both holds are still down.
    assert.equal(at(1200)[2], true, "tap column pressed at its time");
    assert.equal(at(1210)[0], true, "hold on column 1 still down");
    assert.equal(at(1210)[3], true, "hold on column 4 still down");
    // Column 4's hold ends first.
    assert.equal(at(1450)[3], false, "column 4 hold released at 1400");
    assert.equal(at(1450)[0], true, "column 1 hold still running");
    // Then column 1's.
    assert.equal(at(1700)[0], false, "column 1 hold released at 1600");

    assert.deepEqual(fake.pressedColumns, [false, false, false, false], "nothing stuck");
    engine.dispose();
    fake.dispose();
  });

  it("deduplicates the site's hold-head tap so a hold is not released early", () => {
    // The site pushes both a head tap and a hold object for every hold note.
    // If the head survives into the timeline it looks like a real tap at the
    // hold's start: a duplicate press, and a deferred release that lets go of
    // the hold ~12ms in. Regression for the endTime-normalisation bug.
    const fake = createFakeGame({
      keyCount: 4,
      hitObjects: [...holdAsSite(1, 1000, 1800), tap(0, 1200), tap(2, 1500)],
    });
    const settings = new SettingsManager(undefined, env.window);
    settings.set("general.showOverlay", false);
    const engine = new Engine({ settings, win: env.window });
    engine.init();

    const chart = engine.currentChart;
    assert.ok(chart, "chart parsed");
    // chart.notes keeps every stored object — deduplication happens in the
    // timeline, not in the parsed chart. noteCount is the logical count.
    assert.equal(chart!.notes.length, 4, "all four stored objects are preserved");
    assert.equal(chart!.noteCount, 3, "the hold head is not counted as a note");

    engine.start();
    const snapshots: Array<{ t: number; pressed: boolean[] }> = [];
    for (let t = 0; t <= 2200; t += 10) {
      fake.game.timeElapsed = t;
      env.advance(10);
      env.frame();
      snapshots.push({ t, pressed: [...fake.pressedColumns] });
    }
    const at = (t: number) => snapshots.find((s) => s.t === t)?.pressed ?? [];

    assert.equal(at(1000)[1], true, "hold pressed at its start");
    assert.equal(at(1020)[1], true, "hold NOT released by the head tap's deferred release");
    assert.equal(at(1400)[1], true, "hold still down mid-way");
    assert.equal(at(1790)[1], true, "hold still down just before its end");
    assert.equal(at(1850)[1], false, "hold released at its real end");
    assert.equal(at(1200)[0], true, "unrelated tap still fires");
    assert.deepEqual(fake.pressedColumns, [false, false, false, false], "nothing stuck");

    const hits = fake.judged.filter((j) => j.type === "hit" && j.column === 1);
    assert.equal(hits.length, 1, "exactly one press reached the site for the hold column");

    engine.dispose();
    fake.dispose();
  });

  it("deduplicates a hold head that carries no explicit isHoldHead flag", () => {
    // The endTime marker alone has to be enough: a tap whose endTime is later
    // than its time and which matches a hold is a head, whatever the flag says.
    const fake = createFakeGame({
      keyCount: 4,
      hitObjects: [...holdAsSite(2, 1000, 1700, false)],
    });
    const settings = new SettingsManager(undefined, env.window);
    settings.set("general.showOverlay", false);
    const engine = new Engine({ settings, win: env.window });
    engine.init();
    assert.equal(engine.currentChart?.noteCount, 1, "head not counted without the flag");

    engine.start();
    for (let t = 0; t <= 2100; t += 10) {
      fake.game.timeElapsed = t;
      env.advance(10);
      env.frame();
    }
    const hits = fake.judged.filter((j) => j.type === "hit");
    const releases = fake.judged.filter((j) => j.type === "release");
    assert.equal(hits.length, 1, "one press");
    assert.equal(releases.length, 1, "one release");
    assert.ok(releases[0].at - hits[0].at >= 600, `hold held for ${releases[0].at - hits[0].at}ms`);
    assert.deepEqual(fake.pressedColumns, [false, false, false, false]);

    engine.dispose();
    fake.dispose();
  });

  it("counts a hold-head correctly whichever way the pair sorts", () => {
    // A comparator that breaks ties on the type string puts "hold" before
    // "tap", so the head lands SECOND. countUniqueNotes used to compare each
    // tap against the next element and over-counted in that order.
    const headFirst: SiteHitObject[] = [
      { type: "tap", column: 0, time: 1000, endTime: 2000 },
      hold(0, 1000, 2000),
    ];
    const holdFirst: SiteHitObject[] = [
      hold(0, 1000, 2000),
      { type: "tap", column: 0, time: 1000, endTime: 2000 },
    ];

    for (const [label, notes] of [["head first", headFirst], ["hold first", holdFirst]] as const) {
      const fake = createFakeGame({ keyCount: 4, hitObjects: [...notes] });
      const ctx = buildContextFromGame(fake.game, undefined);
      assert.ok(ctx?.ok, `context built (${label})`);
      assert.equal(ctx!.chart!.noteCount, 1, `one logical note (${label})`);
      assert.ok(ctx!.keyMapping, `mapping built (${label})`);
      fake.dispose();
    }
  });

  it("releases every key when stopped mid-hold", () => {
    const fake = createFakeGame({ hitObjects: [hold(0, 1000, 5000), hold(3, 1000, 5000)] });
    const settings = new SettingsManager(undefined, env.window);
    settings.set("general.showOverlay", false);
    const engine = new Engine({ settings, win: env.window });
    engine.init();
    engine.start();

    for (let t = 0; t <= 1200; t += 16) {
      fake.game.timeElapsed = t;
      env.advance(16);
      env.frame();
    }
    assert.equal(fake.pressedColumns[0], true, "hold is down before the stop");
    assert.equal(fake.pressedColumns[3], true);

    engine.stop();
    assert.deepEqual(fake.pressedColumns, [false, false, false, false], "stop must release everything");

    // And nothing more may fire afterwards.
    const judgedAtStop = fake.judged.length;
    for (let t = 1200; t <= 3000; t += 16) {
      fake.game.timeElapsed = t;
      env.advance(16);
      env.frame();
    }
    assert.equal(fake.judged.length, judgedAtStop, "no input after stop");

    engine.dispose();
    fake.dispose();
  });

  it("emergency stop releases everything and resets to IDLE", () => {
    const fake = createFakeGame({ hitObjects: [hold(1, 1000, 9000)] });
    const settings = new SettingsManager(undefined, env.window);
    settings.set("general.showOverlay", false);
    const engine = new Engine({ settings, win: env.window });
    engine.init();
    engine.start();

    for (let t = 0; t <= 1200; t += 16) {
      fake.game.timeElapsed = t;
      env.advance(16);
      env.frame();
    }
    assert.equal(fake.pressedColumns[1], true);

    engine.emergencyStop();
    assert.deepEqual(fake.pressedColumns, [false, false, false, false]);
    assert.equal(engine.currentPhase, "IDLE");
    assert.equal((engine.getDiagnostics() as any).scheduler.armed, 0);

    engine.dispose();
    fake.dispose();
  });

  it("pause releases keys, preserves position, and resumes correctly", () => {
    const fake = createFakeGame({
      hitObjects: [tap(0, 1000), tap(1, 2000), tap(2, 3000)],
    });
    const settings = new SettingsManager(undefined, env.window);
    settings.set("general.showOverlay", false);
    const engine = new Engine({ settings, win: env.window });
    engine.init();
    engine.start();

    for (let t = 0; t <= 1200; t += 16) {
      fake.game.timeElapsed = t;
      env.advance(16);
      env.frame();
    }
    const hitsBeforePause = fake.judged.filter((j) => j.type === "hit").length;
    assert.equal(hitsBeforePause, 1);

    engine.pause();
    assert.equal(engine.currentPhase, "PAUSED");
    assert.deepEqual(fake.pressedColumns, [false, false, false, false]);

    // Time passes while paused; nothing may fire.
    for (let t = 1200; t <= 1900; t += 16) {
      fake.game.timeElapsed = t;
      env.advance(16);
      env.frame();
    }
    assert.equal(fake.judged.filter((j) => j.type === "hit").length, hitsBeforePause);

    engine.resume();
    assert.equal(engine.currentPhase, "RUNNING");

    for (let t = 1900; t <= 3200; t += 16) {
      fake.game.timeElapsed = t;
      env.advance(16);
      env.frame();
    }
    const columns = fake.judged.filter((j) => j.type === "hit").map((j) => j.column);
    assert.ok(columns.includes(1), "the note at 2000 fires after resume");
    assert.ok(columns.includes(2), "the note at 3000 fires after resume");
    assert.deepEqual(fake.pressedColumns, [false, false, false, false]);

    engine.dispose();
    fake.dispose();
  });

  it("adapts to a 7K chart without any hardcoding", () => {
    const keybinds = ["KeyS", "KeyD", "KeyF", "Space", "KeyJ", "KeyK", "KeyL"];
    const fake = createFakeGame({
      keyCount: 7,
      keybinds,
      hitObjects: Array.from({ length: 7 }, (_, column) => tap(column, 1000 + column * 100)),
    });
    const settings = new SettingsManager(undefined, env.window);
    settings.set("general.showOverlay", false);
    const engine = new Engine({ settings, win: env.window });
    engine.init();

    assert.equal(engine.currentChart?.keyCount, 7);
    assert.deepEqual(engine.currentMapping?.codes, keybinds);

    engine.start();
    for (let t = 0; t <= 2000; t += 16) {
      fake.game.timeElapsed = t;
      env.advance(16);
      env.frame();
    }
    assert.equal(fake.judged.filter((j) => j.type === "hit").length, 7);
    assert.deepEqual(fake.pressedColumns, new Array(7).fill(false));

    engine.dispose();
    fake.dispose();
  });

  it("applies a negative timing offset by firing earlier", () => {
    const hitObjects = [tap(0, 2000)];

    const withOffset = (offset: number) => {
      const fake = createFakeGame({ hitObjects: hitObjects.map((n) => ({ ...n })) });
      const settings = new SettingsManager(undefined, env.window);
      settings.set("general.showOverlay", false);
      settings.set("timing.offset", offset);
      const engine = new Engine({ settings, win: env.window });
      engine.init();
      engine.start();
      let hitAt: number | null = null;
      for (let t = 0; t <= 2600; t += 4) {
        fake.game.timeElapsed = t;
        env.advance(4);
        env.frame();
        if (hitAt === null && fake.judged.some((j) => j.type === "hit")) hitAt = t;
      }
      engine.dispose();
      fake.dispose();
      return hitAt;
    };

    const baseline = withOffset(0);
    const early = withOffset(-50);
    const late = withOffset(50);

    assert.ok(baseline !== null, "the note fires at offset 0");
    assert.ok(early !== null && early < baseline!, `offset -50 fired at ${early}, baseline ${baseline}`);
    assert.ok(late !== null && late > baseline!, `offset +50 fired at ${late}, baseline ${baseline}`);
  });

  it("detects a new beatmap without a page refresh", () => {
    const first = createFakeGame({ hitObjects: [tap(0, 1000), tap(1, 1200)] });
    const settings = new SettingsManager(undefined, env.window);
    settings.set("general.showOverlay", false);
    const engine = new Engine({ settings, win: env.window });
    engine.init();

    const firstSignature = engine.currentChart?.signature;
    assert.equal(engine.currentChart?.noteCount, 2);

    // Simulate the user starting a different beatmap: the old game is disposed
    // and a new one appears under the same global.
    first.dispose();
    const second = createFakeGame({
      keyCount: 6,
      keybinds: ["KeyS", "KeyD", "KeyF", "KeyJ", "KeyK", "KeyL"],
      hitObjects: [tap(0, 1000), tap(1, 1100), tap(2, 1200), tap(3, 1300), tap(4, 1400), tap(5, 1500)],
    });

    env.advance(1000); // let the detection poll run
    engine.init();

    assert.equal(engine.currentChart?.keyCount, 6);
    assert.equal(engine.currentChart?.noteCount, 6);
    assert.notEqual(engine.currentChart?.signature, firstSignature);
    assert.equal((engine.getDiagnostics() as any).input.held, 0, "state was reset");

    engine.dispose();
    second.dispose();
  });

  it("stops safely and releases keys when the play fails mid-hold", () => {
    const fake = createFakeGame({ hitObjects: [hold(0, 1000, 8000)] });
    const settings = new SettingsManager(undefined, env.window);
    settings.set("general.showOverlay", false);
    const engine = new Engine({ settings, win: env.window });
    engine.init();
    engine.start();

    for (let t = 0; t <= 1200; t += 16) {
      fake.game.timeElapsed = t;
      env.advance(16);
      env.frame();
    }
    assert.equal(fake.pressedColumns[0], true, "hold is down before the failure");

    // The site moves to FAIL (health ran out) while a hold is down.
    fake.game.state = "FAIL";
    fake.game.timeElapsed = 1300;
    // The state monitor polls at 100ms; give it a couple of ticks.
    env.advance(250);
    env.frame();

    assert.deepEqual(
      fake.pressedColumns,
      [false, false, false, false],
      "the site's own listeners must receive the release",
    );
    assert.notEqual(engine.currentPhase, "RUNNING");
    assert.equal((engine.getDiagnostics() as any).input.held, 0);

    engine.dispose();
    fake.dispose();
  });

  it("stops safely when the game instance disappears mid-run", () => {
    const fake = createFakeGame({ hitObjects: [hold(0, 1000, 8000)] });
    const settings = new SettingsManager(undefined, env.window);
    settings.set("general.showOverlay", false);
    const engine = new Engine({ settings, win: env.window });
    engine.init();
    engine.start();

    for (let t = 0; t <= 1200; t += 16) {
      fake.game.timeElapsed = t;
      env.advance(16);
      env.frame();
    }
    assert.equal((engine.getDiagnostics() as any).input.held, 1);

    // The user closes the game: the site disposes and nulls the global. The
    // site's listeners go away with it, so what we can assert is our own side
    // of the contract — the engine stops and holds nothing.
    fake.dispose();
    env.advance(3000);
    engine.init();

    assert.notEqual(engine.currentPhase, "RUNNING");
    assert.equal((engine.getDiagnostics() as any).input.held, 0, "engine holds no keys");
    assert.equal((engine.getDiagnostics() as any).scheduler.armed, 0, "no timers left armed");
    assert.equal(engine.currentChart, null, "stale chart cleared");

    engine.dispose();
  });

  it("leaves no stuck keys when the engine is disposed mid-hold", () => {
    const fake = createFakeGame({ hitObjects: [hold(0, 1000, 9000), hold(2, 1000, 9000)] });
    const settings = new SettingsManager(undefined, env.window);
    settings.set("general.showOverlay", false);
    const engine = new Engine({ settings, win: env.window });
    engine.init();
    engine.start();

    for (let t = 0; t <= 1200; t += 16) {
      fake.game.timeElapsed = t;
      env.advance(16);
      env.frame();
    }
    assert.equal(fake.pressedColumns.filter(Boolean).length, 2);

    engine.dispose();
    assert.deepEqual(fake.pressedColumns, [false, false, false, false]);
    fake.dispose();
  });

  it("survives the site throwing during a keydown", () => {
    const fake = createFakeGame({ hitObjects: [tap(0, 1000), tap(1, 1200)] });
    // Simulate a site-side exception in its own handler.
    env.document.addEventListener("keydown", () => {
      throw new Error("site handler exploded");
    });

    const settings = new SettingsManager(undefined, env.window);
    settings.set("general.showOverlay", false);
    const engine = new Engine({ settings, win: env.window });
    engine.init();
    engine.start();

    // Must not throw out of the engine loop.
    assert.doesNotThrow(() => {
      for (let t = 0; t <= 1500; t += 16) {
        fake.game.timeElapsed = t;
        env.advance(16);
        env.frame();
      }
    });
    assert.deepEqual(fake.pressedColumns, [false, false, false, false]);

    engine.dispose();
    fake.dispose();
  });
});

describe("stats", () => {
  it("reports notes remaining and reads the site's own score", () => {
    const fake = createFakeGame({
      hitObjects: [tap(0, 1000), tap(1, 1500), tap(2, 2000), tap(3, 2500)],
    });
    (fake.game.scoreSystem as any).score = 123456;
    (fake.game.scoreSystem as any).combo = 42;
    (fake.game.scoreSystem as any).accuracy = 0.9876;
    (fake.game.scoreSystem as any)[320] = 2;
    (fake.game.scoreSystem as any)[300] = 1;

    const settings = new SettingsManager(undefined, env.window);
    settings.set("general.showOverlay", false);
    const engine = new Engine({ settings, win: env.window });
    engine.init();
    engine.start();

    fake.game.timeElapsed = 1600;
    env.advance(16);
    env.frame();

    const stats = engine.getStats();
    assert.ok(stats);
    assert.equal(stats.notesTotal, 4);
    assert.equal(stats.score, 123456, "score comes from the site's own scoring");
    assert.equal(stats.combo, 42);
    assert.ok(stats.accuracy !== null && Math.abs(stats.accuracy - 0.9876) < 1e-9);
    assert.equal(stats.hits, 3, "two 320s and one 300");
    assert.equal(stats.notesRemaining, 2, "notes at 2000 and 2500 are still ahead");

    engine.dispose();
    fake.dispose();
  });
});

describe("humanization end to end", () => {
  it("plays a chart with identical timing when humanization is off", () => {
    const hitObjects = [tap(0, 1000), tap(1, 1400), tap(2, 1800), tap(3, 2200)];

    const run = () => {
      const fake = createFakeGame({ hitObjects });
      const settings = new SettingsManager(undefined, env.window);
      settings.set("general.showOverlay", false);
      const engine = new Engine({ settings, win: env.window });
      engine.init();
      engine.start();
      for (let t = 0; t <= 2800; t += 10) {
        fake.game.timeElapsed = t;
        env.advance(10);
        env.frame();
      }
      const judged = fake.judged.map((j) => [j.type, j.column, j.at]);
      engine.dispose();
      fake.dispose();
      return judged;
    };

    assert.deepEqual(run(), run(), "two runs of an unhumanised chart must be identical");
  });

  it("shifts input timing when humanization is enabled, without losing notes", () => {
    const hitObjects = [
      tap(0, 1000), tap(1, 1300), tap(2, 1600), tap(3, 1900),
      tap(0, 2200), tap(1, 2500), tap(2, 2800), tap(3, 3100),
    ];

    const plain = createFakeGame({ hitObjects });
    const plainSettings = new SettingsManager(undefined, env.window);
    plainSettings.set("general.showOverlay", false);
    const plainEngine = new Engine({ settings: plainSettings, win: env.window });
    plainEngine.init();
    plainEngine.start();
    for (let t = 0; t <= 3600; t += 10) {
      plain.game.timeElapsed = t;
      env.advance(10);
      env.frame();
    }
    const plainHits = plain.judged.filter((j) => j.type === "hit");

    const human = createFakeGame({ hitObjects });
    const humanSettings = new SettingsManager(undefined, env.window);
    humanSettings.set("general.showOverlay", false);
    humanSettings.set("humanization.enabled", true);
    humanSettings.set("humanization.seed", 20261007);
    humanSettings.set("humanization.strength", 0.5);
    const humanEngine = new Engine({ settings: humanSettings, win: env.window });
    humanEngine.init();
    humanEngine.start();
    for (let t = 0; t <= 3600; t += 10) {
      human.game.timeElapsed = t;
      env.advance(10);
      env.frame();
    }
    const humanHits = human.judged.filter((j) => j.type === "hit");

    // Every note still reaches the site.
    assert.equal(humanHits.length, plainHits.length, "no notes lost or duplicated");
    assert.equal(humanHits.length, 8);
    // Columns and order are untouched — only the timing moves.
    assert.deepEqual(humanHits.map((h) => h.column), plainHits.map((h) => h.column));
    // And the timing genuinely differs.
    assert.notDeepEqual(
      humanHits.map((h) => h.at),
      plainHits.map((h) => h.at),
      "humanization should move the input timing",
    );

    const stats = humanEngine.humanizationStats;
    assert.ok(stats, "humanization stats are exposed");
    assert.ok(stats!.notes > 0);
    assert.ok(stats!.sdMs > 0, "there is measurable spread");

    assert.deepEqual(human.pressedColumns, [false, false, false, false], "no stuck keys");
    plainEngine.dispose();
    plain.dispose();
    humanEngine.dispose();
    human.dispose();
  });

  it("is reproducible from the seed across separate runs", () => {
    const hitObjects = [tap(0, 1000), tap(1, 1300), tap(2, 1600), tap(3, 1900), tap(0, 2200)];

    const run = () => {
      const fake = createFakeGame({ hitObjects });
      const settings = new SettingsManager(undefined, env.window);
      settings.set("general.showOverlay", false);
      settings.set("humanization.enabled", true);
      settings.set("humanization.seed", 777);
      settings.set("humanization.strength", 0.6);
      const engine = new Engine({ settings, win: env.window });
      engine.init();
      engine.start();
      for (let t = 0; t <= 2800; t += 10) {
        fake.game.timeElapsed = t;
        env.advance(10);
        env.frame();
      }
      const judged = fake.judged.map((j) => [j.type, j.column, j.at]);
      engine.dispose();
      fake.dispose();
      return judged;
    };

    assert.deepEqual(run(), run(), "same seed must reproduce the same run exactly");
  });

  it("plays holds correctly with humanization and release variation enabled", () => {
    // The risky configuration: independent release variation can push a hold's
    // tail past the next press on that column, which silently loses the note.
    const hitObjects = [
      ...holdAsSite(0, 1000, 1800),
      tap(0, 2000),
      ...holdAsSite(1, 1200, 2400),
      tap(0, 2600),
      ...holdAsSite(0, 3000, 3800),
      tap(0, 3800),
      tap(2, 4200),
    ];

    for (const seed of [1, 2, 3, 11, 99]) {
      const fake = createFakeGame({ hitObjects });
      const settings = new SettingsManager(undefined, env.window);
      settings.set("general.showOverlay", false);
      settings.set("humanization.enabled", true);
      settings.set("humanization.seed", seed);
      settings.set("humanization.strength", 1);
      settings.set("humanization.holdReleaseVariation", 1);
      settings.set("humanization.fatigue", 1);
      settings.set("humanization.longTermDrift", 1);
      const engine = new Engine({ settings, win: env.window });
      engine.init();
      engine.start();

      for (let t = 0; t <= 5000; t += 8) {
        fake.game.timeElapsed = t;
        env.advance(8);
        env.frame();
      }

      // No key may be left down, and the site must never see a press while the
      // column is already held (which it would drop).
      assert.deepEqual(
        fake.pressedColumns,
        [false, false, false, false],
        `stuck key at seed ${seed}: ${JSON.stringify(fake.pressedColumns)}`,
      );
      const hits = fake.judged.filter((j) => j.type === "hit").length;
      const releases = fake.judged.filter((j) => j.type === "release").length;
      assert.equal(hits, releases, `press/release mismatch at seed ${seed}`);
      assert.ok(hits >= 6, `expected the notes to reach the site at seed ${seed}, got ${hits}`);

      engine.dispose();
      fake.dispose();
    }
  });

  it("rebuilds the timeline when a humanization setting changes mid-run", () => {
    const hitObjects = [tap(0, 2000), tap(1, 2400), tap(2, 2800), tap(3, 3200)];
    const fake = createFakeGame({ hitObjects });
    const settings = new SettingsManager(undefined, env.window);
    settings.set("general.showOverlay", false);
    settings.set("humanization.enabled", true);
    settings.set("humanization.seed", 5);
    const engine = new Engine({ settings, win: env.window });
    engine.init();
    engine.start();

    fake.game.timeElapsed = 1000;
    env.advance(16);
    env.frame();
    const before = engine.humanizationStats;
    assert.ok(before, "stats available while running");

    // A rebuild must be reproducible, not a fresh roll of the dice.
    settings.set("humanization.strength", 0.9);
    engine.applySettings(settings.all);
    const after = engine.humanizationStats;
    assert.ok(after, "stats still available after the rebuild");
    assert.notDeepEqual(after, before, "the change should alter the perturbation");

    // Turning it off must return to frame-exact timing.
    settings.set("humanization.enabled", false);
    engine.applySettings(settings.all);
    assert.equal(engine.humanizationStats, null, "no humanizer while disabled");

    assert.deepEqual(fake.pressedColumns, [false, false, false, false], "nothing stuck across rebuilds");
    engine.dispose();
    fake.dispose();
  });
});
