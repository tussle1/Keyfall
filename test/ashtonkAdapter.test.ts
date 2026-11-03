import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { Engine } from "../src/engine/engine";
import { verifyInputState } from "../src/engine/guards";
import { collectStats } from "../src/engine/stats";
import { SettingsManager } from "../src/core/settings";
import { buildContextFromGame } from "../src/detect/buildContext";
import { acquireAshtonkGame } from "../src/detect/ashtonkAdapter";
import { acquireGame } from "../src/detect/pixiHook";
import { detectSite } from "../src/detect/siteDetection";
import { installDom, StubKeyboardEvent, type StubEnvironment } from "./helpers/domStub";

const HOST = "v2-ashtonkmania.lokaux.workers.dev";
const CODES = ["KeyD", "KeyF", "KeyJ", "KeyK"];

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

/** A faithful-enough mini Ashtonk!mania practice session. */
function makeAshtonk() {
  env.window.location.hostname = HOST;
  env.window.location.href = `https://${HOST}/`;
  (env.document as any).title = "Ashtonk!mania";
  (env.document as any).parentNode = env.window.__et;

  const chartNotes = notes();
  const held = [false, false, false, false];
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
  const keyMap = new Map<string, number>(CODES.map((code, col) => [code, col]));
  const s: any = {
    keys: 4,
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
      return perf - (audioOffset.value + (s.mapOffset ?? 0) + latency.value) * (s.rate ?? 1);
    },
  };

  const api: any = {
    GameplayScreen,
    Screens: { current: GameplayScreen, currentName: "gameplay" },
    Settings: {
      keybinds: (keys: number) => CODES.slice(0, keys).map((code) => [code]),
      get: (key: string) => {
        if (key === "audio.offset") return audioOffset.value;
        if (key === "input.latency") return latency.value;
        return 0;
      },
    },
    Music: {
      timeAt: (perf: number) => perf,
      timeAtCtx: (ctx: number) => ctx * 1000,
      get time() { return env.now(); },
      playing: true,
    },
    AudioManager: { perfToCtx: (perf: number) => perf / 1000 },
    SkinEditor: { on: false },
  };
  env.window.AshtonkMania = api;

  // Ashtonk!mania installs its gameplay input listeners on `window` capture.
  // The stub bubbles document-dispatched events into that window target.
  const onKeyDown = (event: any) => {
    if (event.repeat || s.running !== true || s.feed) return;
    const col = keyMap.get(event.code);
    if (col === undefined || held[col]) return;
    held[col] = true;
    judged.push({
      type: "down",
      column: col,
      at: Number(event.timeStamp),
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
      at: Number(event.timeStamp),
      trusted: event.isTrusted,
      repeat: event.repeat,
    });
  };
  env.window.addEventListener("keydown", onKeyDown, true);
  env.window.addEventListener("keyup", onKeyUp, true);

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

  it("does not acquire before the loader finishes, off the gameplay screen, or after a finished play", () => {
    const fake = makeAshtonk();

    fake.GameplayScreen.loaderGone = false;
    fake.s.running = false;
    fake.api.Music.playing = false;
    assert.equal(acquireAshtonkGame(env.window), null);

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
    assert.equal(game.state, "FAIL");
    assert.match(game.unsupportedReason ?? "", /Practice mode/);
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

describe("Ashtonk!mania fair-play gates", () => {
  const refuses = (mutate: (fake: ReturnType<typeof makeAshtonk>) => void, expected: RegExp) => {
    const fake = makeAshtonk();
    mutate(fake);
    const game = acquireAshtonkGame(env.window)!;
    const result = buildContextFromGame(game, settings().all, "ashtonkGlobal");
    assert.equal(result.ok, false);
    assert.match(result.reason ?? "", expected);
  };

  it("refuses normal/ranked play and asks for Practice mode", () => {
    refuses((fake) => {
      fake.s.practice = false;
      fake.s.mode = "play";
    }, /Practice mode/);
  });

  it("refuses the site's built-in Auto mod", () => {
    refuses((fake) => {
      fake.s.auto = true;
      fake.s.mods = ["AT"];
    }, /built-in Auto/);
  });

  it("refuses replays, spectating and generated feeds", () => {
    refuses((fake) => { fake.s.replay = { frames: [] }; }, /replay/i);
    refuses((fake) => { fake.s.spectate = { host: true }; }, /replay/i);
    refuses((fake) => { fake.s.feed = [{ t: 0, k: "KeyD", d: true }]; }, /replay/i);
  });

  it("refuses multiplayer, daily challenges and non-linear rate mods", () => {
    refuses((fake) => { fake.s.mp = { room: "x" }; }, /multiplayer/i);
    refuses((fake) => { fake.GameplayScreen.params.daily = { id: 1 }; }, /daily/i);
    refuses((fake) => { fake.s.ramp = [1, 1.5]; }, /Wind Up/i);
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

  it("shows a readable refusal instead of starting in normal play", () => {
    const fake = makeAshtonk();
    fake.s.practice = false;
    fake.s.mode = "play";
    const manager = settings();
    manager.set("general.showOverlay", false);
    const engine = engineWith(manager);

    engine.init();
    assert.equal(engine.currentPhase, "ERROR");
    assert.match(engine.lastErrorMessage, /Practice mode/);

    engine.start();
    assert.notEqual(engine.currentPhase, "RUNNING");
    assert.equal(fake.judged.length, 0, "no synthetic input was produced");
  });

  it("stops with the adapter's reason if a live run leaves Practice mode", () => {
    const fake = makeAshtonk();
    const manager = settings();
    manager.set("general.showOverlay", false);
    const engine = engineWith(manager);

    engine.init();
    engine.start();
    assert.equal(engine.currentPhase, "RUNNING");

    fake.s.practice = false;
    fake.s.mode = "play";
    env.advance(100); // state monitor polls at 100ms

    assert.equal(engine.currentPhase, "ERROR");
    assert.match(engine.lastErrorMessage, /Practice mode/);
    assert.equal(fake.judged.length, 0, "no notes fired before the first one was due");
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
