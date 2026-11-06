import { ASHTONK_APP_GLOBAL, MAX_KEY_COUNT, MIN_KEY_COUNT } from "../constants";
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
 * Normal, Practice, multiplayer and daily sessions use the same keyboard
 * path. Replay, spectating and built-in Auto feeds are incompatible because
 * the game ignores gameplay keyboard input while a feed drives the session.
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

/** Stable identities for sessions, prepared engines and their note arrays. */
const OBJECT_IDS = new WeakMap<object, number>();
let nextObjectId = 1;

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
  // When present, this is the same gate onKeyDown checks before lane input.
  // Running audio or a countdown alone cannot make input playable yet.
  if (typeof screen.loaderGone === "boolean") return screen.loaderGone;
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

/** Report input conflicts so the overlay can explain why playback cannot work. */
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
    return "A replay, spectated play or generated feed is already driving input. Keyfall cannot take over that feed.";
  }
  const keys = Math.trunc(numberOr(s.keys, 0));
  if (s.keyMap && keys >= MIN_KEY_COUNT && keys <= MAX_KEY_COUNT) {
    const missing = readKeybinds(api, s, keys)
      .flatMap((pair, col) => pair[0] ? [] : [col + 1]);
    if (missing.length) {
      return `No active keyboard binding for lane${missing.length === 1 ? "" : "s"} ${missing.join(", ")}. Bind a keyboard key to each lane in Ashtonk!mania.`;
    }
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
    !/^Pad\d+$/.test(code) &&
    // Ashtonk consumes these before checking the lane keyMap.
    !["Escape", "Backquote", "Tab", "F3", "F4"].includes(code)
  );
}

function readKeybinds(
  api: AshtonkApi | null,
  s: AshtonkSession | null,
  keyCount: number,
): ColumnKeybind[] {
  const configured: string[][] = Array.from({ length: Math.max(0, keyCount) }, () => []);
  let raw: unknown = null;
  try {
    raw = api?.Settings?.keybinds?.(keyCount);
  } catch {
    // A settings API change should degrade to the session's keyMap, not throw.
  }
  if (Array.isArray(raw)) {
    for (let col = 0; col < configured.length; col++) {
      const value = raw[col];
      if (Array.isArray(value)) configured[col] = value.filter(isKeyboardCode);
      else if (isKeyboardCode(value)) configured[col] = [value];
    }
  }

  // The session's keyMap is what the active keyboard handler actually uses.
  // Settings may have changed since the play began, so never prefer a saved
  // binding the live map no longer accepts. Preserve the site's preferred
  // primary/secondary order where those codes are still active.
  const mapped: string[][] = Array.from({ length: configured.length }, () => []);
  const keyMap = s?.keyMap;
  let hasLiveMap = false;
  const add = (code: unknown, colValue: unknown): void => {
    const col = numberOr(colValue, Number.NaN);
    if (isKeyboardCode(code) && Number.isInteger(col) && col >= 0 && col < mapped.length && !mapped[col].includes(code)) {
      mapped[col].push(code);
    }
  };
  if (keyMap && typeof (keyMap as Map<string, number>).forEach === "function") {
    hasLiveMap = true;
    (keyMap as Map<string, number>).forEach((col, code) => add(code, col));
  } else if (isRecord(keyMap)) {
    hasLiveMap = true;
    for (const [code, col] of Object.entries(keyMap)) add(code, col);
  }

  return configured.map((preferred, col): ColumnKeybind => {
    const codes = hasLiveMap
      ? [...preferred.filter((code) => mapped[col].includes(code)), ...mapped[col].filter((code) => !preferred.includes(code))]
      : preferred;
    return [codes[0] ?? null, codes[1] ?? null];
  });
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

function objectId(value: unknown): number {
  if (!isRecord(value)) return 0;
  let id = OBJECT_IDS.get(value);
  if (id === undefined) {
    id = nextObjectId++;
    OBJECT_IDS.set(value, id);
  }
  return id;
}

/**
 * O(1) in chart length. Prepared Ashtonk note layouts remain stable during
 * play; retries/seeks replace their session, engine or array. This revision
 * catches those replacements before the next dispatch. The slower structural
 * signature below still detects in-place edits on the 100ms state monitor.
 */
function readChartRevision(s: AshtonkSession | null): string {
  const notes = activeNotes(s);
  return [
    objectId(s), objectId(s?.engine), objectId(notes), notes.length,
    s?.rec?.hash ?? s?.rec?.id ?? "ashtonk", s?.keys ?? 0,
    Array.isArray(s?.mods) ? s.mods.join(",") : "", s?.seed ?? 0,
    s?.loopA ?? "", s?.loopB ?? "",
  ].join("|");
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
    layoutHash ^= note.isLN === false ? 0 : 1;
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
      // Playback speed changes during Wind Up/Down and Adaptive Speed; it is
      // not chart identity and must not restart the timeline.
      s?.loopA ?? "",
      s?.loopB ?? "",
      objectId(s?.engine),
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

    chartTimeAtHost(hostTime: number): number | null {
      const { screen, s } = liveContext(win);
      if (!s || typeof screen?.inputTime !== "function" || !Number.isFinite(hostTime)) return null;
      try {
        const time = screen.inputTime({ timeStamp: hostTime });
        return Number.isFinite(time) ? time : null;
      } catch {
        // The engine will fall back to its continuously fitted clock model.
        return null;
      }
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

    get hasHitObjects(): boolean {
      return activeNotes(liveContext(win).s).length > 0;
    },

    get chartRevision(): string {
      return readChartRevision(liveContext(win).s);
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
 * Acquire a prepared gameplay session, including its loader. Input still waits
 * for the site to enter PLAY. Conflicting feeds return an adapter with a reason
 * so the UI can explain the refusal instead of showing no gameplay.
 */
export function acquireAshtonkGame(win: Window): GameLike | null {
  const { api, screen, s } = liveContext(win);
  if (
    !api ||
    !isGameplayScreenActive(win, api, screen) ||
    !s ||
    s.finished ||
    s.failed ||
    (!hasStarted(api, screen, s) && !(Array.isArray(s.engine?.notes) && s.engine.notes.length > 0))
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
