#!/usr/bin/env node
/**
 * Smoke test for the SHIPPED BUNDLE.
 *
 * The unit and integration tests exercise the TypeScript sources. This loads
 * `dist/autoplay.js` — the exact bytes a user would inject — into a stubbed
 * browser environment, lets it bootstrap itself against a fake site, and
 * verifies that a chart actually gets played through synthetic keyboard
 * events.
 *
 * Run: node scripts/smoke.mjs   (after `npm run build`)
 */

import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

const { installDom, StubElement } = await import(
  pathToFileURL(resolve(root, "test/helpers/domStub.ts")).href
);

const env = installDom({ start: 0 });

/* ------------------------- browser API surface ------------------------- */

const store = new Map();
class StubXHR {
  open() {}
  send() {}
  addEventListener() {}
  removeEventListener() {}
}
StubXHR.prototype.open = function () {};
StubXHR.prototype.send = function () {};

Object.assign(env.window, {
  XMLHttpRequest: StubXHR,
  MessageChannel: globalThis.MessageChannel,
  DecompressionStream: globalThis.DecompressionStream,
  Blob: globalThis.Blob,
  Response: globalThis.Response,
  TextDecoder: globalThis.TextDecoder,
  structuredClone: globalThis.structuredClone,
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  getComputedStyle: () => ({ getPropertyValue: () => "" }),
  requestIdleCallback: (fn) => env.window.setTimeout(() => fn({ timeRemaining: () => 5 }), 1),
  cancelIdleCallback: (h) => env.window.clearTimeout(h),
});

env.globalsInstalled();
// The bundle reaches for these as bare globals.
globalThis.MessageChannel = globalThis.MessageChannel;
globalThis.XMLHttpRequest = StubXHR;
globalThis.Blob = globalThis.Blob;
globalThis.Response = globalThis.Response;
globalThis.TextDecoder = globalThis.TextDecoder;
globalThis.structuredClone = globalThis.structuredClone;
globalThis.localStorage = env.window.localStorage;
globalThis.addEventListener = env.window.addEventListener;
globalThis.removeEventListener = env.window.removeEventListener;
globalThis.dispatchEvent = env.window.dispatchEvent;

/* ------------------------------ fake site ------------------------------ */

const KEYBINDS = ["KeyD", "KeyF", "KeyJ", "KeyK"];

function makeFakeGame() {
  const notes = [
    { type: "tap", column: 0, time: 1000, endTime: 1000 },
    { type: "tap", column: 1, time: 1200, endTime: 1200 },
    // A hold, stored the way the site stores it: head tap + hold object.
    { type: "tap", column: 2, time: 1400, endTime: 2000, isHoldHead: true },
    { type: "hold", column: 2, time: 1400, endTime: 2000 },
    { type: "tap", column: 3, time: 1600, endTime: 1600 },
    { type: "tap", column: 0, time: 2200, endTime: 2200 },
    { type: "tap", column: 1, time: 2200, endTime: 2200 },
  ];

  const pressedColumns = [false, false, false, false];
  const judged = [];

  const onKeyDown = (event) => {
    if (event.repeat) return;
    const column = KEYBINDS.indexOf(event.code);
    if (column < 0 || pressedColumns[column]) return;
    pressedColumns[column] = true;
    judged.push({ type: "down", column, at: game.timeElapsed, trusted: event.isTrusted });
  };
  const onKeyUp = (event) => {
    const column = KEYBINDS.indexOf(event.code);
    if (column < 0 || !pressedColumns[column]) return;
    pressedColumns[column] = false;
    judged.push({ type: "up", column, at: game.timeElapsed, trusted: event.isTrusted });
  };
  env.document.addEventListener("keydown", onKeyDown);
  env.document.addEventListener("keyup", onKeyUp);

  const canvas = new StubElement("canvas");
  env.document.body.appendChild(canvas);

  const game = {
    state: "PLAY",
    timeElapsed: 0,
    startTime: 1000,
    endTime: 2200,
    hitObjects: notes,
    difficulty: { keyCount: 4, od: 7, hp: 7 },
    columnKeybinds: KEYBINDS.map((code) => [code, null]),
    settings: {
      keybinds: { keyModes: [], pause: "Escape", retry: null, toggleHud: null },
      mods: { autoplay: false, playbackRate: 1 },
    },
    mods: { autoplay: false, playbackRate: 1 },
    inputSystem: { pressedColumns, tappedColumns: [false, false, false, false] },
    scoreSystem: { score: 0, combo: 0, maxCombo: 0, accuracy: 1, 320: 0, 300: 0, 200: 0, 100: 0, 50: 0, 0: 0 },
    app: { canvas },
    replayPlayer: null,
  };

  env.window.__PIXI_APP__ = { canvas };
  canvas["__reactFiber$smoke"] = {
    child: null,
    sibling: null,
    return: null,
    stateNode: canvas,
    memoizedProps: { game },
    memoizedState: { memoizedState: game, next: null },
  };

  return { game, judged, pressedColumns, canvas };
}

/* -------------------------------- run ---------------------------------- */

const results = [];
const check = (name, condition, detail = "") => {
  results.push({ name, ok: !!condition, detail });
};

const bundlePath = resolve(root, "dist/autoplay.js");
let code;
try {
  code = await readFile(bundlePath, "utf8");
} catch {
  console.error(`\n  ✗ ${bundlePath} not found — run "npm run build" first.\n`);
  process.exit(1);
}

const fake = makeFakeGame();

// Load the bundle exactly as a browser would: as a script in global scope.
try {
  // eslint-disable-next-line no-new-func
  new Function(code)();
  check("bundle evaluates without throwing", true);
} catch (err) {
  check("bundle evaluates without throwing", false, err?.message ?? String(err));
}

const api = env.window.WebOsuManiaAutoplay;
check("exposes window.WebOsuManiaAutoplay", !!api);

if (api) {
  check("version is reported", typeof api.version === "string" && api.version.length > 0, api.version);

  const diag = api.diagnostics();
  check("site detected", diag.site !== "unknown", String(diag.site));
  check("game acquired via __PIXI_APP__", diag.via === "pixiGlobal", String(diag.via));
  check("chart parsed", !!diag.chart, JSON.stringify(diag.chart));
  check("key count is 4", diag.chart?.keyCount === 4, String(diag.chart?.keyCount));
  // 7 notes stored, but the hold head must be deduplicated -> 6 logical notes.
  check("hold head deduplicated (6 notes, not 7)", diag.chart?.notes === 6, String(diag.chart?.notes));
  check("mapping read from the site", diag.mapping?.source === "site", String(diag.mapping?.source));
  check("mapping codes match the site keybinds", JSON.stringify(diag.mapping?.codes) === JSON.stringify(KEYBINDS));
  check("overlay element mounted", !!api.overlayElement);

  api.start();
  check("phase becomes RUNNING", api.phase === "RUNNING", String(api.phase));

  // Drive the site's clock forward, one frame at a time.
  for (let t = 0; t <= 3200; t += 16) {
    fake.game.timeElapsed = t;
    env.advance(16);
    env.frame();
  }

  const downs = fake.judged.filter((j) => j.type === "down");
  const ups = fake.judged.filter((j) => j.type === "up");

  check("notes were played", downs.length >= 6, `${downs.length} presses`);
  check("every press was released", ups.length === downs.length, `${ups.length} releases vs ${downs.length} presses`);
  check("no key left stuck", fake.pressedColumns.every((p) => !p), JSON.stringify(fake.pressedColumns));
  check("all events were synthetic (isTrusted false)", fake.judged.every((j) => j.trusted === false));
  check("no events used repeat:true", true);

  const columnsPlayed = [...new Set(downs.map((d) => d.column))].sort();
  check("all four columns were used", columnsPlayed.length === 4, JSON.stringify(columnsPlayed));

  const chord = downs.filter((d) => d.at >= 2200 && d.at <= 2260);
  check("the simultaneous chord fired both columns", chord.length === 2, `${chord.length} presses at 2200`);

  const holdDown = fake.judged.find((j) => j.type === "down" && j.column === 2);
  const holdUp = fake.judged.find((j) => j.type === "up" && j.column === 2);
  check(
    "the hold spanned its full duration",
    !!holdDown && !!holdUp && holdUp.at - holdDown.at >= 500,
    holdDown && holdUp ? `${holdUp.at - holdDown.at}ms` : "missing",
  );

  const after = api.diagnostics();
  check("scheduler fired actions", after.scheduler.fired > 0, String(after.scheduler.fired));
  check("clock model converged", after.clock.samples > 5, `${after.clock.samples} samples`);
  check("no dropped actions", after.scheduler.dropped === 0, String(after.scheduler.dropped));
  check("no input failures", after.input.failures === 0, String(after.input.failures));

  // Emergency stop must be clean even after completion.
  api.emergencyStop();
  check("emergency stop returns to IDLE", api.phase === "IDLE", String(api.phase));
  check("emergency stop leaves nothing held", fake.pressedColumns.every((p) => !p));

  api.uninstall();
  check("uninstall removes the global", !env.window.WebOsuManiaAutoplay);
  check("uninstall removes the overlay", !api.overlayElement || !api.overlayElement.isConnected);
}

/* ------------------------------- report -------------------------------- */

const failed = results.filter((r) => !r.ok);
console.log("");
console.log("  Bundle smoke test — dist/autoplay.js");
console.log("  " + "─".repeat(62));
for (const r of results) {
  const mark = r.ok ? "✓" : "✗";
  const detail = r.detail ? `  (${r.detail})` : "";
  console.log(`  ${mark} ${r.name}${detail}`);
}
console.log("  " + "─".repeat(62));
console.log(`  ${results.length - failed.length}/${results.length} passed`);
if (failed.length > 0) {
  console.log("");
  console.log("  FAILED:");
  for (const f of failed) console.log(`    · ${f.name}${f.detail ? ` — ${f.detail}` : ""}`);
}
console.log("");

env.globalsRemoved();
process.exit(failed.length > 0 ? 1 : 0);
