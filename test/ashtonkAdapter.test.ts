import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { Engine } from "../src/engine/engine";
import { verifyInputState } from "../src/engine/guards";
import { collectStats } from "../src/engine/stats";
import { SettingsManager } from "../src/core/settings";
import { buildContextFromGame, fallbackCodes } from "../src/detect/buildContext";
import { acquireAshtonkGame } from "../src/detect/ashtonkAdapter";
import { acquireGame } from "../src/detect/pixiHook";
import { detectSite } from "../src/detect/siteDetection";
import { installDom, StubKeyboardEvent, type StubEnvironment } from "./helpers/domStub";

const HOST = "v2-ashtonkmania.lokaux.workers.dev";
const CODES = ["KeyD", "KeyF", "KeyJ", "KeyK"];
// Defaults from the site's Settings.keybinds, kept independent of Keyfall's fallback.
const SITE_DEFAULTS = [
  "Space",
  "KeyF KeyJ",
  "KeyF Space KeyJ",
  "KeyD KeyF KeyJ KeyK",
  "KeyD KeyF Space KeyJ KeyK",
  "KeyS KeyD KeyF KeyJ KeyK KeyL",
  "KeyS KeyD KeyF Space KeyJ KeyK KeyL",
  "KeyA KeyS KeyD KeyF KeyJ KeyK KeyL Semicolon",
  "KeyA KeyS KeyD KeyF Space KeyJ KeyK KeyL Semicolon",
  "KeyA KeyS KeyD KeyF KeyV KeyN KeyJ KeyK KeyL Semicolon",
  "KeyA KeyS KeyD KeyF KeyV Space KeyN KeyJ KeyK KeyL Semicolon",
  "KeyA KeyS KeyD KeyF KeyC KeyV KeyN KeyM KeyJ KeyK KeyL Semicolon",
  "KeyA KeyS KeyD KeyF KeyC KeyV Space KeyN KeyM KeyJ KeyK KeyL Semicolon",
  "KeyA KeyS KeyD KeyF KeyX KeyC KeyV KeyN KeyM Comma KeyJ KeyK KeyL Semicolon",
  "KeyA KeyS KeyD KeyF KeyX KeyC KeyV Space KeyN KeyM Comma KeyJ KeyK KeyL Semicolon",
  "KeyA KeyS KeyD KeyF KeyZ KeyX KeyC KeyV KeyN KeyM Comma Period KeyJ KeyK KeyL Semicolon",
  "KeyA KeyS KeyD KeyF KeyZ KeyX KeyC KeyV Space KeyN KeyM Comma Period KeyJ KeyK KeyL Semicolon",
  "KeyA KeyS KeyD KeyF KeyG KeyZ KeyX KeyC KeyV KeyN KeyM Comma Period KeyH KeyJ KeyK KeyL Semicolon",
].map((layout) => layout.split(" "));
const CUSTOM_CODES = "KeyQ KeyW KeyE KeyR KeyT KeyY KeyU KeyI KeyO KeyP Digit1 Digit2 Digit3 Digit4 Digit5 Digit6 Digit7 Digit8".split(" ");

let env: StubEnvironment;
const cleanups: Array<() => void> = [];

beforeEach(() => {
  env = installDom({ start: 0 });
  env.globalsInstalled();
  cleanups.length = 0;
});

afterEach(() => {
  for (const dispose of cleanups.splice(0)) {
    try { dispose(); } catch { /* best effort */ }
  }
  env.globalsRemoved();
});

function settings(): SettingsManager {
  const manager = new SettingsManager(undefined, env.window);
  cleanups.push(() => manager.dispose());
  return manager;
}

function engineWith(manager: SettingsManager): Engine {
  const engine = new Engine({ settings: manager, win: env.window });
  cleanups.push(() => engine.dispose());
  return engine;
}

interface AshtonkNote {
  col: number;
  time: number;
  end: number;
  isLN: boolean;
}

function notes(): AshtonkNote[] {
  return [
    { col: 0, time: 1000, end: 1000, isLN: false },
    { col: 1, time: 1200, end: 1200, isLN: false },
    { col: 2, time: 1400, end: 2000, isLN: true },
    { col: 3, time: 1600, end: 1600, isLN: false },
    { col: 0, time: 2200, end: 2200, isLN: false },
    { col: 1, time: 2200, end: 2200, isLN: false },
  ];
}

/** A small Ashtonk!mania session with the site's live key and judgement paths. */
function makeAshtonk(options: { keyCount?: number; codes?: string[]; chartNotes?: AshtonkNote[] } = {}) {
  env.window.location.hostname = HOST;
  env.window.location.href = `https://${HOST}/`;
  (env.document as any).title = "Ashtonk!mania";
  (env.document as any).parentNode = env.window.__et;

  const keyCount = options.keyCount ?? 4;
  const codes = options.codes ?? (keyCount === 4 ? CODES : fallbackCodes(keyCount));
  const chartNotes = options.chartNotes ?? notes();
  const held = new Array<boolean>(keyCount).fill(false);
  let hostBase = env.now();
  let chartBase = env.now();
  const judged: Array<{
    type: "down" | "up";
    column: number;
    at: number;
    trusted: boolean;
    repeat: boolean;
  }> = [];
  const score = {
    counts: [0, 0, 0, 0, 0, 0],
    accuracy: 1,
    combo: 0,
    maxCombo: 0,
    score: 0,
  };
  const keyMap = new Map<string, number>(codes.map((code, col) => [code, col]));
  const s: any = {
    keys: keyCount,
    rate: 1,
    mode: "practice",
    practice: true,
    auto: false,
    replay: null,
    spectate: null,
    mp: null,
    feed: null,
    running: true,
    finished: false,
    failed: false,
    loaderGone: true,
    held,
    keyMap,
    mods: [],
    seed: 20261103,
    firstNote: 1000,
    endTime: 2200,
    mapOffset: 0,
    rec: {
      hash: "ashtonk-test-map",
      title: "Test Map",
      artist: "Keyfall",
      version: "Practice",
    },
    engine: { notes: chartNotes, score },
    baseNotes: chartNotes,
  };

  const audioOffset = { value: 0 };
  const latency = { value: 0 };
  const GameplayScreen: any = {
    s,
    loaderGone: true,
    cdEl: null,
    params: {},
    offsetMs: () => audioOffset.value + (s.mapOffset ?? 0),
    inputTime: (event: { timeStamp: number }) => {
      const perf = Number(event?.timeStamp ?? env.now());
      return chartBase + (perf - hostBase) * s.rate -
        (audioOffset.value + (s.mapOffset ?? 0) + latency.value) * s.rate;
    },
  };

  const api: any = {
    GameplayScreen,
    Screens: { current: GameplayScreen, currentName: "gameplay" },
    Settings: {
      keybinds: (keys: number) => codes.slice(0, keys).map((code) => [code]),
      get: (key: string) => {
        if (key === "audio.offset") return audioOffset.value;
        if (key === "input.latency") return latency.value;
        return 0;
      },
    },
    Music: {
      timeAt: (perf: number) => chartBase + (perf - hostBase) * s.rate,
      timeAtCtx: (ctx: number) => chartBase + (ctx * 1000 - hostBase) * s.rate,
      get time() { return chartBase + (env.now() - hostBase) * s.rate; },
      playing: true,
    },
    AudioManager: { perfToCtx: (perf: number) => perf / 1000 },
    SkinEditor: { on: false },
  };
  env.window.AshtonkMania = api;

  // Ashtonk!mania installs its gameplay input listeners on `window` capture.
  // The stub bubbles document-dispatched events into that window target.
  const onKeyDown = (event: any) => {
    if (event.repeat || !GameplayScreen.loaderGone || s.running !== true || s.feed) return;
    const col = keyMap.get(event.code);
    if (col === undefined || held[col]) return;
    held[col] = true;
    judged.push({
      type: "down",
      column: col,
      at: GameplayScreen.inputTime(event),
      trusted: event.isTrusted,
      repeat: event.repeat,
    });
  };
  const onKeyUp = (event: any) => {
    const col = keyMap.get(event.code);
    if (col === undefined || !held[col]) return;
    held[col] = false;
    judged.push({
      type: "up",
      column: col,
      at: GameplayScreen.inputTime(event),
      trusted: event.isTrusted,
      repeat: event.repeat,
    });
  };
  env.window.addEventListener("keydown", onKeyDown, true);
  env.window.addEventListener("keyup", onKeyUp, true);
  cleanups.push(() => {
    env.window.removeEventListener("keydown", onKeyDown, true);
    env.window.removeEventListener("keyup", onKeyUp, true);
  });

  return {
    api,
    GameplayScreen,
    s,
    score,
    held,
    judged,
    keyMap,
    audioOffset,
    latency,
    chartNotes,
    changeRate(rate: number) {
      chartBase += (env.now() - hostBase) * s.rate;
      hostBase = env.now();
      s.rate = rate;
    },
  };
}

describe("Ashtonk!mania site detection", () => {
  it("confirms the requested v2 host and selects the Ashtonk adapter", () => {
    const fake = makeAshtonk();
    const check = detectSite(env.window);
    assert.equal(check.verdict, "confirmed");
    assert.equal(check.family, "ashtonkmania");
    assert.match(check.message, /Ashtonk!mania/);

    const acquired = acquireGame(env.window);
    assert.equal(acquired?.via, "ashtonkGlobal");
    assert.ok(acquired?.game);
    assert.equal(fake.s.auto, false, "adapter must not enable the site's AT mod");
    assert.equal(fake.s.feed, null, "adapter must not create a replay/auto feed");
  });

  it("recognises versioned Ashtonk deployments and the exported global on an unknown host", () => {
    const fake = makeAshtonk();
    env.window.location.hostname = "v3-ashtonkmania.lokaux.workers.dev";
    assert.equal(detectSite(env.window).family, "ashtonkmania");

    env.window.location.hostname = "saved-game.local";
    assert.equal(detectSite(env.window).verdict, "confirmed");
    assert.equal(detectSite(env.window).family, "ashtonkmania");
    assert.equal(acquireGame(env.window)?.via, "ashtonkGlobal");
    assert.ok(fake.api.GameplayScreen);
  });

  it("acquires prepared notes during loading but not an unprepared or finished session", () => {
    const fake = makeAshtonk();

    fake.GameplayScreen.loaderGone = false;
    fake.s.running = false;
    fake.api.Music.playing = false;
    assert.equal(acquireAshtonkGame(env.window)?.state, "WAIT");
    // The game's loader gate wins even if audio or a countdown is already live.
    fake.s.running = true;
    fake.api.Music.playing = true;
    fake.GameplayScreen.cdEl = {};
    assert.equal(acquireAshtonkGame(env.window)?.state, "WAIT");
    fake.s.running = false;
    fake.api.Music.playing = false;
    fake.GameplayScreen.cdEl = null;
    const prepared = fake.s.engine;
    fake.s.engine = undefined;
    assert.equal(acquireAshtonkGame(env.window), null);
    fake.s.engine = prepared;

    fake.GameplayScreen.loaderGone = true;
    fake.s.running = true;
    fake.api.Screens.currentName = "songselect";
    fake.api.Screens.current = null;
    assert.equal(acquireAshtonkGame(env.window), null);

    fake.api.Screens.currentName = "gameplay";
    fake.api.Screens.current = fake.GameplayScreen;
    fake.s.finished = true;
    assert.equal(acquireAshtonkGame(env.window), null);
  });
});

describe("Ashtonk!mania chart/clock/keybind adapter", () => {
  it("converts Ashtonk notes into Keyfall's existing SiteHitObject shape", () => {
    makeAshtonk();
    const game = acquireAshtonkGame(env.window)!;
    assert.equal(game.difficulty.keyCount, 4);
    assert.equal(game.hitObjects.length, 6);
    assert.deepEqual(game.hitObjects[0], { type: "tap", column: 0, time: 1000, endTime: 1000 });
    assert.deepEqual(game.hitObjects[2], { type: "hold", column: 2, time: 1400, endTime: 2000 });
    assert.equal(game.startTime, 1000);
    assert.equal(game.endTime, 2200);
    assert.equal(game.columnKeybinds?.length, 4);
    assert.equal(game.columnKeybinds?.[0][0], "KeyD");
    assert.ok(game.metadata?.title);
  });

  it("reports PLAY, PAUSE, UNPAUSE and FAIL from the live session", () => {
    const fake = makeAshtonk();
    const game = acquireAshtonkGame(env.window)!;
    assert.equal(game.state, "PLAY");

    fake.s.running = false;
    assert.equal(game.state, "PAUSE");
    fake.GameplayScreen.cdEl = {};
    assert.equal(game.state, "UNPAUSE");

    fake.s.practice = false;
    fake.s.mode = "play";
    fake.s.running = true;
    fake.GameplayScreen.cdEl = null;
    assert.equal(game.state, "PLAY");
    assert.equal(game.unsupportedReason, undefined);
    fake.s.failed = true;
    assert.equal(game.state, "FAIL");
  });

  it("uses inputTime's audio/offset/latency-adjusted chart clock", () => {
    const fake = makeAshtonk();
    env.advance(1000);
    fake.audioOffset.value = 10;
    fake.latency.value = 20;
    fake.s.mapOffset = 5;
    const game = acquireAshtonkGame(env.window)!;
    assert.equal(game.timeElapsed, 965);
  });

  it("falls back to Music + Settings when inputTime is unavailable", () => {
    const fake = makeAshtonk();
    env.advance(1000);
    delete fake.GameplayScreen.inputTime;
    delete fake.GameplayScreen.offsetMs;
    fake.audioOffset.value = 10;
    fake.latency.value = 20;
    fake.s.mapOffset = 5;
    const game = acquireAshtonkGame(env.window)!;
    assert.equal(game.timeElapsed, 965);
  });

  it("falls back to the site's keyMap when Settings.keybinds changes", () => {
    const fake = makeAshtonk();
    fake.api.Settings.keybinds = undefined;
    const game = acquireAshtonkGame(env.window)!;
    const result = buildContextFromGame(game, settings().all, "ashtonkGlobal");
    assert.equal(result.ok, true);
    assert.deepEqual(result.keyMapping?.codes, CODES);
    assert.equal(result.keyMapping?.source, "site");
  });

  it("uses the active keyMap rather than settings that changed after the play started", () => {
    const fake = makeAshtonk();
    fake.keyMap.delete("KeyD");
    fake.keyMap.set("KeyQ", 0);
    const game = acquireAshtonkGame(env.window)!;
    const result = buildContextFromGame(game, settings().all, "ashtonkGlobal");
    assert.equal(result.ok, true);
    assert.deepEqual(result.keyMapping?.codes, ["KeyQ", "KeyF", "KeyJ", "KeyK"]);
  });

  it("uses an active secondary key when the primary is consumed by gameplay shortcuts", () => {
    const fake = makeAshtonk();
    fake.keyMap.delete("KeyD");
    fake.keyMap.set("F3", 0); // Ashtonk handles F3 before its lane map
    fake.keyMap.set("KeyQ", 0);
    fake.api.Settings.keybinds = () => [["F3", "KeyQ"], ["KeyF"], ["KeyJ"], ["KeyK"]];
    const game = acquireAshtonkGame(env.window)!;
    const result = buildContextFromGame(game, settings().all, "ashtonkGlobal");
    assert.equal(result.ok, true);
    assert.equal(result.keyMapping?.codes[0], "KeyQ");
    fake.keyMap.delete("KeyQ");
    assert.match(game.unsupportedReason ?? "", /keyboard binding for lane 1/i);
  });

  it("exposes the site's judgement clock at arbitrary host timestamps", () => {
    const fake = makeAshtonk();
    env.advance(1000);
    fake.changeRate(2);
    fake.latency.value = 10;
    const game = acquireAshtonkGame(env.window)!;
    assert.equal(game.chartTimeAtHost?.(1000), 980);
    assert.equal(game.chartTimeAtHost?.(1100), 1180);
    fake.GameplayScreen.inputTime = () => { throw new Error("clock API changed"); };
    assert.equal(game.chartTimeAtHost?.(1100), null);
  });

  it("keeps the chart signature stable when variable-speed mods change rate", () => {
    const fake = makeAshtonk();
    fake.s.mods = ["WU"];
    fake.s.ramp = [0.5, 2];
    const game = acquireAshtonkGame(env.window)!;
    const signature = game.chartSignature;
    for (const rate of [0.5, 0.75, 1.2, 2]) {
      fake.changeRate(rate);
      assert.equal(game.chartSignature, signature);
      assert.equal(game.state, "PLAY");
    }
  });

  it("changes the chart signature when practice seeks replace the engine or random moves columns", () => {
    const fake = makeAshtonk();
    const game = acquireAshtonkGame(env.window)!;
    const first = game.chartSignature!;
    assert.ok(first);

    fake.s.engine = { notes: fake.chartNotes.slice(2), score: fake.score };
    const seeked = game.chartSignature!;
    assert.notEqual(seeked, first);

    fake.chartNotes[2].col = 3;
    assert.notEqual(game.chartSignature!, seeked);
  });

  it("exposes Ashtonk score, combo, accuracy and judgement counts to the existing stats reader", () => {
    const fake = makeAshtonk();
    fake.score.counts = [10, 2, 1, 0, 0, 0];
    fake.score.accuracy = 0.98;
    fake.score.combo = 12;
    fake.score.maxCombo = 15;
    fake.score.score = 123456;
    const game = acquireAshtonkGame(env.window)!;
    const stats = collectStats({
      game,
      notesTotal: 6,
      notesRemaining: 0,
      actionsFired: 12,
      pressesDown: 6,
      releasesUp: 6,
      timeElapsed: 2200,
      lastJitter: 0,
      avgJitter: 0,
    });
    assert.equal(stats.hits, 13);
    assert.equal(stats.combo, 12);
    assert.equal(stats.accuracy, 0.98);
    assert.equal(stats.score, 123456);

    fake.held[2] = true;
    assert.equal(verifyInputState(game, new Set([2])).ok, true);
    fake.held[2] = false;
    assert.deepEqual(verifyInputState(game, new Set([2])).stuckInOurs, [2]);
  });
});

describe("Ashtonk!mania input conflicts", () => {
  const refuses = (mutate: (fake: ReturnType<typeof makeAshtonk>) => void, expected: RegExp) => {
    const fake = makeAshtonk();
    mutate(fake);
    const game = acquireAshtonkGame(env.window)!;
    const result = buildContextFromGame(game, settings().all, "ashtonkGlobal");
    assert.equal(result.ok, false);
    assert.match(result.reason ?? "", expected);
  };

  it("refuses the site's built-in Auto mod", () => {
    refuses((fake) => { fake.s.auto = true; fake.s.mods = ["AT"]; }, /built-in Auto/);
  });

  it("refuses replays, spectating and generated feeds", () => {
    refuses((fake) => { fake.s.replay = { frames: [] }; }, /replay/i);
    refuses((fake) => { fake.s.spectate = { host: true }; }, /spectat/i);
    refuses((fake) => { fake.s.feed = [{ t: 0, k: "KeyD", d: true }]; }, /feed/i);
  });

  it("reports a lane with no active keyboard binding instead of guessing", () => {
    refuses((fake) => { fake.keyMap.delete("KeyD"); }, /keyboard binding for lane 1/i);
  });
});

describe("Ashtonk!mania end-to-end autoplay", () => {
  it("plays a practice chart through Keyfall's synthetic window-capture keyboard path", () => {
    const fake = makeAshtonk();
    const manager = settings();
    manager.set("general.showOverlay", false);
    const engine = engineWith(manager);

    engine.init();
    const initial = engine.getDiagnostics();
    assert.equal(engine.currentPhase, "READY");
    assert.equal(initial.via, "ashtonkGlobal");
    assert.equal(initial.siteFamily, "ashtonkmania");
    assert.equal((initial.chart as any).notes, 6);
    assert.equal((initial.mapping as any).source, "site");

    engine.start();
    assert.equal(engine.currentPhase, "RUNNING");

    for (let t = 0; t <= 3200; t += 16) {
      env.advance(16);
      env.frame();
    }

    const downs = fake.judged.filter((j) => j.type === "down");
    const ups = fake.judged.filter((j) => j.type === "up");
    assert.equal(downs.length, 6, `${downs.length} presses`);
    assert.equal(ups.length, downs.length, "every press was released");
    assert.ok(fake.held.every((down) => !down), "no key left stuck");
    assert.ok(fake.judged.every((j) => j.trusted === false), "all events were synthetic");
    assert.ok(fake.judged.every((j) => j.repeat === false), "no repeat:true events");

    const columns = [...new Set(downs.map((d) => d.column))].sort();
    assert.deepEqual(columns, [0, 1, 2, 3]);
    const chord = downs.filter((d) => d.at >= 2200 && d.at <= 2260);
    assert.equal(chord.length, 2, "simultaneous chord fired both columns");

    const holdDown = fake.judged.find((j) => j.type === "down" && j.column === 2)!;
    const holdUp = fake.judged.find((j) => j.type === "up" && j.column === 2)!;
    assert.ok(holdUp.at - holdDown.at >= 500, "hold spanned its full duration");

    const after = engine.getDiagnostics();
    assert.equal(engine.currentPhase, "READY");
    assert.equal((after.scheduler as any).fired > 0, true);
    assert.equal((after.scheduler as any).dropped, 0);
    assert.equal((after.input as any).failures, 0);
    assert.equal((after.clock as any).samples > 5, true);
    assert.equal(after.lastError, null);
  });

  for (const [name, configure] of [
    ["normal", (fake: ReturnType<typeof makeAshtonk>) => { fake.s.mode = "play"; fake.s.practice = false; }],
    ["ranked multiplayer", (fake: ReturnType<typeof makeAshtonk>) => { fake.s.mode = "play"; fake.s.practice = false; fake.s.mp = { rp: true }; }],
    ["multiplayer", (fake: ReturnType<typeof makeAshtonk>) => { fake.s.mode = "play"; fake.s.practice = false; fake.s.mp = { room: "test" }; }],
    ["daily challenge", (fake: ReturnType<typeof makeAshtonk>) => { fake.s.mode = "play"; fake.s.practice = false; fake.GameplayScreen.params.daily = { day: "today" }; }],
    ["Wind Up", (fake: ReturnType<typeof makeAshtonk>) => { fake.s.mode = "play"; fake.s.practice = false; fake.s.ramp = [0.75, 1.5]; fake.s.mods = ["WU"]; }],
    ["Wind Down", (fake: ReturnType<typeof makeAshtonk>) => { fake.s.mode = "play"; fake.s.practice = false; fake.s.ramp = [1.5, 0.75]; fake.s.mods = ["WD"]; }],
    ["Adaptive Speed", (fake: ReturnType<typeof makeAshtonk>) => { fake.s.mode = "play"; fake.s.practice = false; fake.s.adaptive = true; fake.s.mods = ["AS"]; }],
  ] as const) {
    it(`automatically plays detected notes in ${name}`, () => {
      const fake = makeAshtonk();
      configure(fake);
      const engine = engineWith(settings());
      engine.init();
      assert.equal(engine.currentPhase, "READY");
      engine.start();
      for (let t = 0; t < 3200; t += 16) { env.advance(16); env.frame(); }
      const downs = fake.judged.filter((j) => j.type === "down");
      assert.equal(downs.length, fake.chartNotes.length);
      assert.deepEqual([...new Set(downs.map((j) => j.column))].sort(), [0, 1, 2, 3]);
      assert.ok(fake.held.every((held) => !held));
      assert.equal(engine.lastErrorMessage, "");
    });
  }

  for (let keyCount = 1; keyCount <= 18; keyCount++) {
    for (const layout of ["site defaults", "custom bindings"] as const) {
      it(`plays chords and holds across every lane in ${keyCount}K using ${layout}`, () => {
        const codes = layout === "site defaults" ? SITE_DEFAULTS[keyCount - 1] : CUSTOM_CODES.slice(0, keyCount);
        const chartNotes = codes.map((_code, col) => ({
          col, time: 1200, end: col % 3 === 0 ? 1800 : 1200, isLN: col % 3 === 0,
        }));
        if (layout === "site defaults") assert.deepEqual(fallbackCodes(keyCount), codes);
        const fake = makeAshtonk({ keyCount, codes, chartNotes });
        fake.s.mode = "play";
        fake.s.practice = false;
        const engine = engineWith(settings());
        engine.init();
        assert.deepEqual(engine.currentMapping?.codes, codes);
        engine.start();
        for (let t = 0; t < 2400; t += 16) { env.advance(16); env.frame(); }
        const downs = fake.judged.filter((j) => j.type === "down");
        const ups = fake.judged.filter((j) => j.type === "up");
        assert.deepEqual(downs.map((j) => j.column).sort((a, b) => a - b), codes.map((_, col) => col));
        assert.equal(ups.length, keyCount);
        for (const note of chartNotes.filter((n) => n.isLN)) {
          const down = downs.find((j) => j.column === note.col)!;
          const up = ups.find((j) => j.column === note.col)!;
          assert.ok(up.at - down.at >= 570, `hold in lane ${note.col + 1} lasted ${up.at - down.at}ms`);
        }
        assert.ok(fake.held.every((held) => !held));
      });
    }
  }

  it("tracks acceleration and deceleration without rebuilding or missing notes", () => {
    const fake = makeAshtonk();
    fake.s.mode = "play";
    fake.s.practice = false;
    fake.s.ramp = [0.5, 2];
    fake.s.mods = ["WU"];
    const engine = engineWith(settings());
    let detections = 0;
    engine.on("detected", () => detections++);
    engine.init();
    engine.start();
    while (env.now() < 720) { env.advance(8); env.frame(); }
    fake.changeRate(2);
    while (env.now() < 1400) { env.advance(8); env.frame(); }
    fake.changeRate(0.5);
    while (env.now() < 2200) { env.advance(8); env.frame(); }

    const downs = fake.judged.filter((j) => j.type === "down");
    assert.equal(downs.length, fake.chartNotes.length);
    fake.chartNotes.forEach((note, i) => {
      assert.ok(Math.abs(downs[i].at - note.time) <= 20, `lane ${note.col} expected ${note.time}, got ${downs[i].at}`);
    });
    assert.equal(detections, 1, "mutable playback rate must not rebuild the chart");
    assert.ok(fake.held.every((held) => !held));
    assert.equal(engine.lastErrorMessage, "");
  });

  it("auto-starts an opt-in chart after loading, never while the site ignores keys", () => {
    const fake = makeAshtonk();
    fake.s.running = false;
    fake.GameplayScreen.loaderGone = false;
    fake.api.Music.playing = true;
    fake.s.running = true;
    const manager = settings();
    manager.set("general.autoStart", true);
    const engine = engineWith(manager);
    engine.init();
    assert.equal(engine.currentPhase, "READY");
    assert.equal((engine.getDiagnostics() as any).pendingStart, "automatic");
    for (let t = 0; t < 500; t += 8) { env.advance(8); env.frame(); }
    assert.equal(fake.judged.length, 0);
    assert.equal(engine.currentPhase, "READY");

    fake.GameplayScreen.loaderGone = true;
    fake.s.running = true;
    fake.api.Music.playing = true;
    for (let t = 0; t < 2800; t += 8) { env.advance(8); env.frame(); }
    assert.equal(fake.judged.filter((j) => j.type === "down").length, 6);
    assert.equal((engine.getDiagnostics() as any).pendingStart, null);
  });

  it("can arm Start before opening gameplay and cancel it with Stop", () => {
    const fake = makeAshtonk({ chartNotes: [{ col: 0, time: 3000, end: 3000, isLN: false }] });
    fake.api.Screens.current = null;
    fake.api.Screens.currentName = "songselect";
    const engine = engineWith(settings());
    const pendingEvents: Array<string | null> = [];
    engine.on("pendingStart", ({ pending }) => pendingEvents.push(pending));
    engine.init();
    engine.start();
    assert.equal((engine.getDiagnostics() as any).pendingStart, "manual");
    engine.stop();
    assert.equal((engine.getDiagnostics() as any).pendingStart, null);
    assert.deepEqual(pendingEvents, ["manual", null]);
    engine.start();
    fake.api.Screens.current = fake.GameplayScreen;
    fake.api.Screens.currentName = "gameplay";
    while (env.now() < 3200) { env.advance(8); env.frame(); }
    assert.equal(fake.judged.filter((j) => j.type === "down").length, 1);
  });

  it("disarms a manual start when the prepared chart is closed before playback", () => {
    const fake = makeAshtonk();
    fake.s.running = false;
    fake.GameplayScreen.loaderGone = false;
    const engine = engineWith(settings());
    engine.init();
    engine.start();
    assert.equal((engine.getDiagnostics() as any).pendingStart, "manual");
    fake.api.Screens.current = null;
    fake.api.Screens.currentName = "songselect";
    for (let t = 0; t < 800; t += 8) { env.advance(8); env.frame(); }
    assert.equal((engine.getDiagnostics() as any).pendingStart, null);

    fake.api.Screens.current = fake.GameplayScreen;
    fake.api.Screens.currentName = "gameplay";
    fake.GameplayScreen.loaderGone = true;
    fake.s.running = true;
    for (let t = 0; t < 2200; t += 8) { env.advance(8); env.frame(); }
    assert.equal(fake.judged.length, 0, "a later chart needs another manual start");
  });

  it("disarms a manual start if the detected chart has an incompatible input feed", () => {
    const fake = makeAshtonk();
    fake.api.Screens.current = null;
    fake.api.Screens.currentName = "songselect";
    const engine = engineWith(settings());
    engine.init(); engine.start();
    assert.equal((engine.getDiagnostics() as any).pendingStart, "manual");
    fake.s.auto = true;
    fake.api.Screens.current = fake.GameplayScreen;
    fake.api.Screens.currentName = "gameplay";
    for (let t = 0; t < 800; t += 8) { env.advance(8); env.frame(); }
    assert.equal(engine.currentPhase, "ERROR");
    assert.equal((engine.getDiagnostics() as any).pendingStart, null);
    fake.s.auto = false;
    for (let t = 0; t < 2000; t += 8) { env.advance(8); env.frame(); }
    assert.equal(fake.judged.length, 0, "clearing the feed must not silently start playback");
  });

  for (const stopMode of ["stop", "emergencyStop"] as const) {
    it(`re-arms an already prepared chart after ${stopMode}`, () => {
      const fake = makeAshtonk();
      fake.s.running = false;
      fake.GameplayScreen.loaderGone = false;
      fake.api.Music.playing = false;
      const engine = engineWith(settings());
      engine.init(); engine.start(); engine[stopMode](); engine.start();
      assert.equal((engine.getDiagnostics() as any).pendingStart, "manual");
      fake.GameplayScreen.loaderGone = true;
      fake.s.running = true;
      fake.api.Music.playing = true;
      for (let t = 0; t < 200; t += 8) { env.advance(8); env.frame(); }
      assert.equal(engine.currentPhase, "RUNNING", "the 100ms monitor must restart before the 700ms detection poll");
    });
  }

  it("re-arms the state monitor when auto-start is enabled after Stop", () => {
    const fake = makeAshtonk();
    fake.s.running = false;
    fake.GameplayScreen.loaderGone = false;
    fake.api.Music.playing = false;
    const manager = settings();
    const engine = engineWith(manager);
    engine.init(); engine.start(); engine.stop();
    manager.set("general.autoStart", true);
    engine.applySettings(manager.all);
    assert.equal((engine.getDiagnostics() as any).pendingStart, "automatic");
    fake.GameplayScreen.loaderGone = true;
    fake.s.running = true;
    fake.api.Music.playing = true;
    for (let t = 0; t < 200; t += 8) { env.advance(8); env.frame(); }
    assert.equal(engine.currentPhase, "RUNNING");
  });

  it("keeps an explicit pending Start when auto-start is disabled", () => {
    const fake = makeAshtonk();
    fake.s.running = false;
    fake.GameplayScreen.loaderGone = false;
    const manager = settings();
    manager.set("general.autoStart", true);
    const engine = engineWith(manager);
    engine.init();
    assert.equal((engine.getDiagnostics() as any).pendingStart, "automatic");
    engine.start();
    manager.set("general.autoStart", false);
    engine.applySettings(manager.all);
    assert.equal((engine.getDiagnostics() as any).pendingStart, "manual");
  });

  it("does not restart a stopped chart just because another setting changes", () => {
    const fake = makeAshtonk();
    const manager = settings();
    const engine = engineWith(manager);
    engine.init();
    manager.set("general.autoStart", true);
    engine.applySettings(manager.all);
    assert.equal(engine.currentPhase, "RUNNING");
    engine.stop();
    manager.set("timing.offset", 10);
    engine.applySettings(manager.all);
    assert.equal(engine.currentPhase, "READY");
    while (env.now() < 2500) { env.advance(8); env.frame(); }
    assert.equal(fake.judged.length, 0);
  });

  it("does not arm newly detected charts while the master switch is disabled", () => {
    const fake = makeAshtonk();
    fake.s.running = false;
    fake.GameplayScreen.loaderGone = false;
    const manager = settings();
    manager.set("general.autoStart", true);
    manager.set("general.enabled", false);
    const engine = engineWith(manager);
    engine.init();
    assert.equal((engine.getDiagnostics() as any).pendingStart, null);
    fake.GameplayScreen.loaderGone = true;
    fake.s.running = true;
    for (let t = 0; t < 1200; t += 8) { env.advance(8); env.frame(); }
    assert.equal(fake.judged.length, 0);
    manager.set("general.enabled", true);
    engine.applySettings(manager.all);
    for (let t = 0; t < 1000; t += 8) { env.advance(8); env.frame(); }
    assert.equal(fake.judged.length, 0, "re-enabling is not an implicit start of the current chart");
  });

  it("cancels a pending automatic start when the option or master switch is disabled", () => {
    const fake = makeAshtonk();
    fake.s.running = false;
    fake.GameplayScreen.loaderGone = false;
    fake.api.Music.playing = false;
    const manager = settings();
    manager.set("general.autoStart", true);
    const engine = engineWith(manager);
    engine.init();
    assert.equal((engine.getDiagnostics() as any).pendingStart, "automatic");
    manager.set("general.autoStart", false);
    engine.applySettings(manager.all);
    assert.equal((engine.getDiagnostics() as any).pendingStart, null);
    manager.set("general.autoStart", true);
    engine.applySettings(manager.all);
    assert.equal((engine.getDiagnostics() as any).pendingStart, "automatic");
    manager.set("general.enabled", false);
    engine.applySettings(manager.all);
    assert.equal((engine.getDiagnostics() as any).pendingStart, null);
    fake.s.running = true;
    fake.GameplayScreen.loaderGone = true;
    while (env.now() < 2200) { env.advance(8); env.frame(); }
    assert.equal(fake.judged.length, 0);
  });

  it("keeps an early-offset opening note queued during a negative lead-in", () => {
    const fake = makeAshtonk({ chartNotes: [
      { col: 0, time: 0, end: 0, isLN: false },
      { col: 1, time: 500, end: 500, isLN: false },
    ] });
    // A negative judgement clock is normal while the song is counting in.
    fake.audioOffset.value = 1000;
    const manager = settings();
    manager.set("timing.offset", -50);
    const engine = engineWith(manager);
    engine.init();
    engine.start();
    while (env.now() < 1650) { env.advance(8); env.frame(); }
    const downs = fake.judged.filter((event) => event.type === "down");
    assert.equal(downs.length, 2, "the opening note must not be skipped");
    assert.ok(Math.abs(downs[0].at + 50) <= 12, `opening note fired at ${downs[0].at}`);
    assert.ok(fake.held.every((held) => !held));
  });

  it("applies the configurable timing offset during normal play", () => {
    const fake = makeAshtonk();
    fake.s.mode = "play";
    fake.s.practice = false;
    const manager = settings();
    manager.set("timing.offset", -50);
    const engine = engineWith(manager);
    engine.init();
    engine.start();
    while (env.now() < 1200) { env.advance(8); env.frame(); }
    const first = fake.judged.find((j) => j.type === "down")!;
    assert.ok(first.at >= 945 && first.at <= 960, `offset note landed at ${first.at}`);
  });

  it("pauses and releases a hold if the gameplay loader returns", () => {
    const chartNotes = [
      { col: 0, time: 1000, end: 3000, isLN: true },
      { col: 1, time: 1800, end: 1800, isLN: false },
    ];
    const fake = makeAshtonk({ chartNotes });
    const engine = engineWith(settings());
    engine.init(); engine.start();
    while (env.now() < 1120) { env.advance(8); env.frame(); }
    assert.equal(fake.held[0], true);
    fake.GameplayScreen.loaderGone = false;
    while (env.now() < 1250) { env.advance(8); env.frame(); }
    assert.equal(engine.currentPhase, "PAUSED");
    assert.equal(fake.held[0], false, "the old hold is released during WAIT");
    fake.GameplayScreen.loaderGone = true;
    while (env.now() < 2000) { env.advance(8); env.frame(); }
    assert.ok(fake.judged.some((event) => event.type === "down" && event.column === 1));
    assert.ok(fake.held.every((held) => !held));
  });

  it("rebuilds a replaced active chart before firing the old chart's notes", () => {
    const chartNotes = [
      { col: 0, time: 1000, end: 3000, isLN: true },
      { col: 1, time: 1300, end: 1300, isLN: false },
    ];
    const fake = makeAshtonk({ chartNotes });
    const engine = engineWith(settings());
    engine.init(); engine.start();
    while (env.now() < 1120) { env.advance(8); env.frame(); }
    assert.equal(fake.held[0], true);
    fake.s.engine = { notes: [{ col: 2, time: 1400, end: 1400, isLN: false }], score: fake.score };
    while (env.now() < 1600) { env.advance(8); env.frame(); }
    const downs = fake.judged.filter((event) => event.type === "down");
    assert.deepEqual(downs.map((event) => event.column), [0, 2]);
    assert.equal(fake.held[0], false, "the old hold was released");
    assert.ok(fake.held.every((held) => !held));
  });

  it("blocks an old batch even before the chart-change monitor runs", () => {
    const fake = makeAshtonk({ chartNotes: [{ col: 0, time: 960, end: 960, isLN: false }] });
    const engine = engineWith(settings());
    engine.init(); engine.start();
    while (env.now() < 920) { env.advance(8); env.frame(); }
    fake.s.engine = { notes: [{ col: 2, time: 1200, end: 1200, isLN: false }], score: fake.score };
    while (env.now() < 990) { env.advance(8); env.frame(); }
    assert.equal(engine.currentPhase, "PAUSED");
    assert.equal(fake.judged.length, 0, "old chart input is blocked before the next 100ms monitor");
    while (env.now() < 1400) { env.advance(8); env.frame(); }
    assert.deepEqual(fake.judged.filter((event) => event.type === "down").map((event) => event.column), [2]);
    assert.ok(fake.held.every((held) => !held));
  });

  it("does not resume a user-paused run while the site is in WAIT", () => {
    const fake = makeAshtonk();
    const engine = engineWith(settings());
    engine.init(); engine.start(); engine.pause();
    fake.GameplayScreen.loaderGone = false;
    engine.resume();
    assert.equal(engine.currentPhase, "PAUSED");
    while (env.now() < 500) { env.advance(8); env.frame(); }
    assert.equal(fake.judged.length, 0);
    fake.GameplayScreen.loaderGone = true;
    while (env.now() < 1200) { env.advance(8); env.frame(); }
    assert.ok(fake.judged.some((event) => event.type === "down"));
  });

  it("does not transfer a manually armed start to a replaced prepared chart", () => {
    const fake = makeAshtonk();
    fake.GameplayScreen.loaderGone = false;
    fake.s.running = false;
    const engine = engineWith(settings());
    engine.init(); engine.start();
    assert.equal((engine.getDiagnostics() as any).pendingStart, "manual");
    fake.s.engine = { notes: [{ col: 2, time: 1500, end: 1500, isLN: false }], score: fake.score };
    while (env.now() < 800) { env.advance(8); env.frame(); }
    assert.equal((engine.getDiagnostics() as any).pendingStart, null);
    fake.GameplayScreen.loaderGone = true; fake.s.running = true;
    while (env.now() < 1900) { env.advance(8); env.frame(); }
    assert.equal(fake.judged.length, 0);
  });

  it("re-arms a replacement chart when auto-start was explicitly enabled", () => {
    const fake = makeAshtonk();
    fake.GameplayScreen.loaderGone = false;
    fake.s.running = false;
    const manager = settings();
    manager.set("general.autoStart", true);
    const engine = engineWith(manager);
    engine.init(); engine.start();
    assert.equal((engine.getDiagnostics() as any).pendingStart, "manual");
    fake.s.engine = { notes: [{ col: 2, time: 1500, end: 1500, isLN: false }], score: fake.score };
    while (env.now() < 800) { env.advance(8); env.frame(); }
    assert.equal((engine.getDiagnostics() as any).pendingStart, "automatic");
    fake.GameplayScreen.loaderGone = true; fake.s.running = true;
    while (env.now() < 1900) { env.advance(8); env.frame(); }
    assert.deepEqual(fake.judged.filter((event) => event.type === "down").map((event) => event.column), [2]);
    assert.ok(fake.held.every((held) => !held));
  });

  it("continues an active run after a practice seek replaces the gameplay engine", () => {
    const chartNotes = [
      { col: 0, time: 1000, end: 3000, isLN: true },
      { col: 1, time: 2400, end: 2400, isLN: false },
    ];
    const fake = makeAshtonk({ chartNotes });
    const engine = engineWith(settings());
    engine.init();
    engine.start();
    while (env.now() < 1200) { env.advance(16); env.frame(); }
    assert.equal(fake.held[0], true);
    fake.s.engine = { notes: [chartNotes[1]], score: fake.score };
    while (env.now() < 1800) { env.advance(16); env.frame(); }
    assert.equal(fake.held[0], false, "the old hold is released before rebinding");
    assert.equal(engine.currentPhase, "RUNNING", "an explicitly started run continues");
    while (env.now() < 2600) { env.advance(16); env.frame(); }
    assert.ok(fake.judged.some((j) => j.type === "down" && j.column === 1));
  });

  it("does not restart an explicitly paused run when the chart changes", () => {
    const fake = makeAshtonk();
    const engine = engineWith(settings());
    engine.init();
    engine.start();
    engine.pause();
    fake.s.engine = { notes: fake.chartNotes.slice(1), score: fake.score };
    env.advance(800);
    assert.equal(engine.currentPhase, "READY");
    while (env.now() < 2500) { env.advance(16); env.frame(); }
    assert.equal(fake.judged.length, 0);
  });

  it("stops with a readable reason if a replay feed starts during a run", () => {
    const fake = makeAshtonk();
    const manager = settings();
    const engine = engineWith(manager);
    engine.init();
    engine.start();
    assert.equal(engine.currentPhase, "RUNNING");

    fake.s.feed = [1000, 0, 1];
    env.advance(100); // state monitor polls at 100ms
    assert.equal(engine.currentPhase, "ERROR");
    assert.match(engine.lastErrorMessage, /feed/i);
    assert.equal(fake.judged.length, 0);
  });

  it("document-dispatched synthetic events reach window listeners in the DOM stub", () => {
    makeAshtonk();
    const seen: string[] = [];
    const listener = (event: any) => seen.push(event.code);
    env.window.addEventListener("keydown", listener, true);
    env.document.dispatchEvent(
      new StubKeyboardEvent("keydown", { code: "KeyD", bubbles: true, composed: true }),
    );
    assert.deepEqual(seen, ["KeyD"]);
  });
});
