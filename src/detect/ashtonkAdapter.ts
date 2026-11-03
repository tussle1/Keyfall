import { ASHTONK_APP_GLOBAL } from "../constants";
import { hashString } from "../util/helpers";
import type {
  ColumnKeybind,
  GameLike,
  SiteGameState,
  SiteHitObject,
} from "../types";

/**
 * Read-only adapter for Ashtonk!mania's public `window.AshtonkMania` API.
 *
 * The site is a separate codebase from Web osu!mania: gameplay lives in
 * `GameplayScreen.s`, notes are `{ col, time, end, isLN }`, and input listeners
 * are installed on `window` in the capture phase. Rather than adding a second
 * autoplay engine, this module projects that live session onto Keyfall's
 * existing `GameLike` contract so the same chart parser, clock mapper, timeline,
 * humanizer, scheduler, guards and synthetic DOM keyboard path can drive it.
 *
 * Nothing here calls the site's Auto (`AT`), `generateAutoInputs`, `s.feed`,
 * replay playback, `Verified.submit`, score submission, or private judgement
 * engine. All gameplay input still leaves through ordinary `KeyboardEvent`s.
 *
 * Ashtonk!mania has ranked, multiplayer and daily-challenge leaderboards, so the
 * adapter deliberately exposes only **Practice** sessions. Normal/online modes
 * are reported as unsupported with a readable reason rather than being played.
 */

type UnknownRecord = Record<string, unknown>;

interface AshtonkNote {
  col: number;
  time: number;
  end: number;
  isLN?: boolean;
}

interface AshtonkScore {
  counts?: number[];
  accuracy?: number;
  combo?: number;
  maxCombo?: number;
  score?: number;
}

interface AshtonkEngine {
  notes?: AshtonkNote[];
  score?: AshtonkScore;
}

interface AshtonkSession extends UnknownRecord {
  keys?: number;
  rate?: number;
  mode?: string;
  practice?: boolean;
  auto?: boolean;
  replay?: unknown;
  spectate?: unknown;
  mp?: unknown;
  feed?: unknown;
  ramp?: unknown;
  adaptive?: unknown;
  changingSpeed?: boolean;
  running?: boolean;
  finished?: boolean;
  failed?: boolean;
  engine?: AshtonkEngine;
  baseNotes?: AshtonkNote[];
  held?: boolean[];
  keyMap?: Map<string, number> | UnknownRecord;
  mods?: string[];
  seed?: number;
  loopA?: number | null;
  loopB?: number | null;
  firstNote?: number;
  endTime?: number;
  mapOffset?: number;
  rec?: {
    id?: string;
    hash?: string;
    title?: string;
    artist?: string;
    version?: string;
  };
}

interface AshtonkScreen extends UnknownRecord {
  s?: AshtonkSession | null;
  loaderGone?: boolean;
  cdEl?: unknown;
  params?: UnknownRecord;
  inputTime?: (event: { timeStamp: number }) => number;
  offsetMs?: () => number;
}

interface AshtonkApi extends UnknownRecord {
  GameplayScreen?: AshtonkScreen;
  Screens?: { current?: unknown; currentName?: string };
  Settings?: {
    keybinds?: (keys: number) => unknown;
    get?: (key: string) => unknown;
  };
  Music?: {
    timeAt?: (perf: number) => number;
    timeAtCtx?: (ctx: number) => number;
    time?: number;
    playing?: boolean;
  };
  AudioManager?: { perfToCtx?: (perf: number) => number };
  SkinEditor?: { on?: boolean };
}

/** Cached adapter per window, so detection polls see one stable game object. */
const ADAPTERS = new WeakMap<Window, GameLike>();

/** Stable identity for a prepared `s.engine`, which practice seeks replace. */
const ENGINE_IDS = new WeakMap<object, number>();
let nextEngineId = 1;

/** Recognise the site's exported API by shape, not by a constructor name. */
export function readAshtonkApi(win: Window): AshtonkApi | null {
  const value = (win as unknown as UnknownRecord)[ASHTONK_APP_GLOBAL];
  if (!isRecord(value)) return null;
  const screen = value.GameplayScreen;
  if (!isRecord(screen)) return null;
  return value as AshtonkApi;
}

export function hasAshtonkApi(win: Window): boolean {
  return readAshtonkApi(win) !== null;
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null;
}

function numberOr(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function perfNow(win: Window): number {
  const perf = (win as unknown as { performance?: Performance }).performance;
  if (perf && typeof perf.now === "function") return perf.now();
  return performance.now();
}

function sessionOf(screen: AshtonkScreen | null | undefined): AshtonkSession | null {
  const s = screen?.s;
  return isRecord(s) ? (s as AshtonkSession) : null;
}

function activeNotes(s: AshtonkSession | null): AshtonkNote[] {
  if (!s) return [];
  const engineNotes = s.engine?.notes;
  if (Array.isArray(engineNotes)) return engineNotes;
  return Array.isArray(s.baseNotes) ? s.baseNotes : [];
}

function isGameplayScreenActive(
  win: Window,
  api: AshtonkApi | null,
  screen: AshtonkScreen | null,
): boolean {
  if (!api || !screen) return false;
  const screens = api.Screens;
  if (
    screens &&
    (screens.current === screen || screens.currentName === "gameplay")
  ) {
    return true;
  }
  // Fallback for builds that no longer export `Screens`: the gameplay canvas.
  try {
    const canvas = win.document.querySelector?.("canvas.gp-canvas");
    return !!canvas && (canvas as { isConnected?: boolean }).isConnected !== false;
  } catch {
    return false;
  }
}

function hasStarted(
  api: AshtonkApi | null,
  screen: AshtonkScreen | null,
  s: AshtonkSession | null,
): boolean {
  if (!screen || !s) return false;
  if (screen.loaderGone === true) return true;
  if (s.running === true || screen.cdEl != null) return true;
  return api?.Music?.playing === true;
}

function autoplayActive(api: AshtonkApi | null, s: AshtonkSession | null): boolean {
  if (!s) return false;
  const hasAT = Array.isArray(s.mods) && s.mods.includes("AT");
  return s.auto === true || hasAT || api?.SkinEditor?.on === true;
}

function replayActive(s: AshtonkSession | null): boolean {
  if (!s) return false;
  return Boolean(s.replay || s.spectate || s.feed);
}

/**
 * Reasons for refusing a live session. These are policy gates, not detection
 * failures: the adapter still returns a `GameLike` so the overlay can show why
 * Keyfall will not produce input.
 */
function unsupportedReason(
  api: AshtonkApi | null,
  screen: AshtonkScreen | null,
  s: AshtonkSession | null,
): string | null {
  if (!api || !screen || !s) return "No active Ashtonk!mania gameplay session was found.";
  if (autoplayActive(api, s)) {
    return "The site's built-in Auto / skin-editor autoplay is active. Disable it; Keyfall uses its own keyboard-event autoplay instead.";
  }
  if (replayActive(s)) {
    return "A replay, spectated play or generated feed is already driving input. Keyfall refuses to take over a replay.";
  }
  if (s.mp || screen.params?.mp || screen.params?.daily) {
    return "Ranked, multiplayer and daily-challenge plays are not automated. Use Ashtonk!mania Practice mode.";
  }
  if (s.ramp || s.adaptive) {
    return "Wind Up / Wind Down / Adaptive Speed change the clock non-linearly. Use a constant speed in Practice mode.";
  }
  if (s.practice !== true && s.mode !== "practice") {
    return "On Ashtonk!mania, Keyfall is limited to Practice mode so automated scores are never submitted to ranked or online leaderboards. Start the map with Practice (F4).";
  }
  return null;
}

function readHitObjects(s: AshtonkSession | null): SiteHitObject[] {
  const out: SiteHitObject[] = [];
  for (const note of activeNotes(s)) {
    if (!isRecord(note)) continue;
    const time = numberOr(note.time, Number.NaN);
    const column = Math.trunc(numberOr(note.col, Number.NaN));
    if (!Number.isFinite(time) || !Number.isFinite(column) || column < 0) continue;
    const end = numberOr(note.end, time);
    const isHold = note.isLN !== false && Number.isFinite(end) && end > time;
    out.push(
      isHold
        ? { type: "hold", column, time, endTime: end }
        : { type: "tap", column, time, endTime: time },
    );
  }
  return out;
}

function readStartEnd(s: AshtonkSession | null, notes: SiteHitObject[]): {
  startTime: number;
  endTime: number;
} {
  let minTime = Number.POSITIVE_INFINITY;
  let maxEnd = Number.NEGATIVE_INFINITY;
  for (const note of notes) {
    if (note.time < minTime) minTime = note.time;
    if (note.endTime > maxEnd) maxEnd = note.endTime;
  }
  const startTime = Number.isFinite(minTime)
    ? minTime
    : numberOr(s?.firstNote, 0);
  const endTime = Number.isFinite(maxEnd)
    ? maxEnd
    : numberOr(s?.endTime, startTime);
  return { startTime, endTime };
}

function isKeyboardCode(code: unknown): code is string {
  return (
    typeof code === "string" &&
    code.length > 0 &&
    !code.startsWith("🎮") &&
    !/^Pad\d+$/.test(code)
  );
}

function readKeybinds(
  api: AshtonkApi | null,
  s: AshtonkSession | null,
  keyCount: number,
): ColumnKeybind[] {
  const columns: string[][] = Array.from({ length: Math.max(0, keyCount) }, () => []);
  let raw: unknown = null;
  try {
    raw = api?.Settings?.keybinds?.(keyCount);
  } catch {
    // A settings API change should degrade to the session's keyMap, not throw.
  }
  if (Array.isArray(raw)) {
    for (let col = 0; col < columns.length; col++) {
      const value = raw[col];
      if (Array.isArray(value)) columns[col] = value.filter(isKeyboardCode);
      else if (isKeyboardCode(value)) columns[col] = [value];
    }
  }

  // `s.keyMap` is the authoritative code -> column map actually used by input.
  // It also covers custom secondary binds and gamepad-only columns.
  const keyMap = s?.keyMap;
  if (keyMap) {
    if (typeof (keyMap as Map<string, number>).forEach === "function") {
      (keyMap as Map<string, number>).forEach((col, code) => {
        if (
          isKeyboardCode(code) &&
          Number.isInteger(col) &&
          col >= 0 &&
          col < columns.length &&
          !columns[col].includes(code)
        ) {
          columns[col].push(code);
        }
      });
    } else if (isRecord(keyMap)) {
      for (const [code, colValue] of Object.entries(keyMap)) {
        const col = numberOr(colValue, Number.NaN);
        if (
          isKeyboardCode(code) &&
          Number.isInteger(col) &&
          col >= 0 &&
          col < columns.length &&
          !columns[col].includes(code)
        ) {
          columns[col].push(code);
        }
      }
    }
  }

  return columns.map((codes): ColumnKeybind => [codes[0] ?? null, codes[1] ?? null]);
}

function readScoreSystem(s: AshtonkSession | null): Record<string, unknown> | null {
  const score = s?.engine?.score;
  if (!score) return null;
  const counts = Array.isArray(score.counts) ? score.counts : [];
  return {
    320: numberOr(counts[0], 0),
    300: numberOr(counts[1], 0),
    200: numberOr(counts[2], 0),
    100: numberOr(counts[3], 0),
    50: numberOr(counts[4], 0),
    0: numberOr(counts[5], 0),
    get accuracy() {
      return numberOr(score.accuracy, Number.NaN);
    },
    get combo() {
      return numberOr(score.combo, 0);
    },
    get maxCombo() {
      return numberOr(score.maxCombo, 0);
    },
    get score() {
      return numberOr(score.score, Number.NaN);
    },
  };
}

/**
 * Chart clock, in milliseconds, aligned with Ashtonk's own input judgement.
 *
 * `GameplayScreen.inputTime(event)` is the authoritative mapping:
 *
 *   Music.timeAtCtx(AudioManager.perfToCtx(event.timeStamp))
 *     - offsetMs() * rate - input.latency * rate
 *
 * Calling it with a fresh timestamp is a pure read. The fallback reproduces the
 * same formula from the exported `Music` / `Settings` objects if the site
 * renames `inputTime`.
 */
function readChartTime(
  win: Window,
  api: AshtonkApi | null,
  screen: AshtonkScreen | null,
  s: AshtonkSession | null,
): number {
  const perf = perfNow(win);
  if (screen && typeof screen.inputTime === "function") {
    try {
      const time = screen.inputTime({ timeStamp: perf });
      if (Number.isFinite(time)) return time;
    } catch {
      // Fall through to the exported clock APIs.
    }
  }

  let songTime = Number.NaN;
  try {
    const music = api?.Music;
    if (music && typeof music.timeAt === "function") {
      songTime = music.timeAt(perf);
    } else if (
      music &&
      typeof music.timeAtCtx === "function" &&
      typeof api?.AudioManager?.perfToCtx === "function"
    ) {
      songTime = music.timeAtCtx(api.AudioManager.perfToCtx(perf));
    } else if (music && typeof music.time === "number") {
      songTime = music.time;
    }
  } catch {
    return Number.NaN;
  }
  if (!Number.isFinite(songTime)) return Number.NaN;

  const rate = numberOr(s?.rate, 1);
  let offset = Number.NaN;
  try {
    if (screen && typeof screen.offsetMs === "function") offset = screen.offsetMs();
  } catch {
    // Use Settings + mapOffset below.
  }
  if (!Number.isFinite(offset)) {
    const audioOffset = numberOr(api?.Settings?.get?.("audio.offset"), 0);
    offset = audioOffset + numberOr(s?.mapOffset, 0);
  }
  const latency = numberOr(api?.Settings?.get?.("input.latency"), 0);
  return songTime - (offset + latency) * rate;
}

function engineId(engine: unknown): number {
  if (!isRecord(engine)) return 0;
  let id = ENGINE_IDS.get(engine);
  if (id === undefined) {
    id = nextEngineId++;
    ENGINE_IDS.set(engine, id);
  }
  return id;
}

/**
 * A structural chart signature. Ashtonk's `random` mod can move columns without
 * changing note times, and practice seeks replace `s.engine`; both must force a
 * timeline rebuild even though note count and start/end times may be similar.
 */
function readChartSignature(s: AshtonkSession | null): string {
  const notes = activeNotes(s);
  let layoutHash = 2166136261;
  for (const note of notes) {
    if (!isRecord(note)) continue;
    layoutHash ^= Math.round(numberOr(note.time, 0));
    layoutHash = Math.imul(layoutHash, 16777619);
    layoutHash ^= Math.round(numberOr(note.end, 0));
    layoutHash = Math.imul(layoutHash, 16777619);
    layoutHash ^= Math.trunc(numberOr(note.col, 0));
    layoutHash = Math.imul(layoutHash, 16777619);
  }
  const modList = s?.mods;
  const mods = Array.isArray(modList) ? modList.join(",") : "";
  return hashString(
    [
      s?.rec?.hash ?? s?.rec?.id ?? "ashtonk",
      s?.keys ?? 0,
      mods,
      s?.seed ?? 0,
      s?.rate ?? 1,
      s?.loopA ?? "",
      s?.loopB ?? "",
      engineId(s?.engine),
      notes.length,
      (layoutHash >>> 0).toString(36),
    ].join("|"),
  );
}

function readState(
  win: Window,
  api: AshtonkApi | null,
  screen: AshtonkScreen | null,
  s: AshtonkSession | null,
): SiteGameState {
  if (!isGameplayScreenActive(win, api, screen) || !s || s.finished || s.failed) {
    return "FAIL";
  }
  if (unsupportedReason(api, screen, s)) return "FAIL";
  if (!hasStarted(api, screen, s)) return "WAIT";
  if (s.running === true) return "PLAY";
  return screen?.cdEl != null ? "UNPAUSE" : "PAUSE";
}

interface LiveContext {
  api: AshtonkApi | null;
  screen: AshtonkScreen | null;
  s: AshtonkSession | null;
}

function liveContext(win: Window): LiveContext {
  const api = readAshtonkApi(win);
  const screen = api?.GameplayScreen ?? null;
  return { api, screen, s: sessionOf(screen) };
}

function createAdapter(win: Window): GameLike {
  const game: GameLike = {
    get state(): SiteGameState {
      const { api, screen, s } = liveContext(win);
      return readState(win, api, screen, s);
    },

    get timeElapsed(): number {
      const { api, screen, s } = liveContext(win);
      return readChartTime(win, api, screen, s);
    },

    get startTime(): number {
      const { s } = liveContext(win);
      return readStartEnd(s, readHitObjects(s)).startTime;
    },

    get endTime(): number {
      const { s } = liveContext(win);
      return readStartEnd(s, readHitObjects(s)).endTime;
    },

    get hitObjects(): SiteHitObject[] {
      const { s } = liveContext(win);
      return readHitObjects(s);
    },

    get difficulty(): { keyCount: number } {
      const { s } = liveContext(win);
      return { keyCount: Math.trunc(numberOr(s?.keys, 0)) };
    },

    get columnKeybinds(): ColumnKeybind[] {
      const { api, s } = liveContext(win);
      return readKeybinds(api, s, Math.trunc(numberOr(s?.keys, 0)));
    },

    get settings(): {
      keybinds: { keyModes: ColumnKeybind[][] };
      mods: { autoplay: boolean; playbackRate: number };
    } {
      const { api, s } = liveContext(win);
      const rate = numberOr(s?.rate, 1);
      const autoplay = autoplayActive(api, s);
      return {
        keybinds: { keyModes: [] },
        mods: { autoplay, playbackRate: rate },
      };
    },

    get mods(): { autoplay: boolean; playbackRate: number } {
      const { api, s } = liveContext(win);
      return {
        autoplay: autoplayActive(api, s),
        playbackRate: numberOr(s?.rate, 1),
      };
    },

    get inputSystem(): { pressedColumns: boolean[] } {
      const { s } = liveContext(win);
      return { pressedColumns: Array.isArray(s?.held) ? s.held : [] };
    },

    get scoreSystem(): Record<string, unknown> | null {
      const { s } = liveContext(win);
      return readScoreSystem(s);
    },


    get song(): {
      seek: () => number;
      playing: () => boolean;
      rate: () => number;
    } {
      const { api, screen, s } = liveContext(win);
      return {
        seek: () => readChartTime(win, api, screen, s) / 1000,
        playing: () => s?.running === true,
        rate: () => numberOr(s?.rate, 1),
      };
    },

    get metadata(): { title?: string; artist?: string; version?: string } {
      const rec = liveContext(win).s?.rec;
      return {
        title: typeof rec?.title === "string" ? rec.title : undefined,
        artist: typeof rec?.artist === "string" ? rec.artist : undefined,
        version: typeof rec?.version === "string" ? rec.version : undefined,
      };
    },

    get chartSignature(): string {
      return readChartSignature(liveContext(win).s);
    },

    get unsupportedReason(): string | undefined {
      const { api, screen, s } = liveContext(win);
      return unsupportedReason(api, screen, s) ?? undefined;
    },

    get replayPlayer(): object | null {
      const { s } = liveContext(win);
      return replayActive(s) ? {} : null;
    },
  };
  return game;
}

/**
 * Acquire a live, started gameplay session. Unsupported modes still return an
 * adapter (with `unsupportedReason`) so the UI can explain the refusal instead
 * of silently showing "no gameplay detected".
 */
export function acquireAshtonkGame(win: Window): GameLike | null {
  const { api, screen, s } = liveContext(win);
  if (
    !api ||
    !isGameplayScreenActive(win, api, screen) ||
    !s ||
    s.finished ||
    s.failed ||
    !hasStarted(api, screen, s)
  ) {
    return null;
  }

  let game = ADAPTERS.get(win);
  if (!game) {
    game = createAdapter(win);
    ADAPTERS.set(win, game);
  }
  return game;
}
