import {
  EXTENDED_SUFFIX_CODES,
  FALLBACK_KEYBINDS,
  MAX_KEY_COUNT,
  MIN_KEY_COUNT,
} from "../constants";
import type {
  DetectionResult,
  GameLike,
  KeyMapping,
  ParsedChart,
  Settings,
  SiteHitObject,
} from "../types";
import { countUniqueNotes } from "./osuFileParser";
import { hashString } from "../util/helpers";

/**
 * Turn a detected live `Game` into the engine's own normalised context.
 *
 * This is the seam that keeps site coupling contained: everything downstream
 * (chart analysis, timing, input) only ever sees `ParsedChart` and
 * `KeyMapping`, never the site's objects.
 */

/** Read the key count, tolerating either shape the site has used. */
export function readKeyCount(game: GameLike): number | null {
  const fromDifficulty = game.difficulty?.keyCount;
  if (typeof fromDifficulty === "number" && Number.isFinite(fromDifficulty)) {
    return Math.trunc(fromDifficulty);
  }
  const fromColumnKeybinds = game.columnKeybinds?.length;
  if (typeof fromColumnKeybinds === "number" && fromColumnKeybinds > 0) {
    return fromColumnKeybinds;
  }
  const fromInput = game.inputSystem?.pressedColumns?.length;
  if (typeof fromInput === "number" && fromInput > 0) return fromInput;
  return null;
}

/**
 * Build a `keyCount -> code[]` mapping.
 *
 * Priority:
 *  1. The live game's resolved `columnKeybinds` (exact — includes the user's
 *     own rebinds and the deep-cloned settings for that specific run).
 *  2. The game's cloned settings `keybinds.keyModes[keyCount - 1]`.
 *  3. A user override from settings.
 *  4. The built-in fallback layout.
 */
export function buildKeyMapping(
  game: GameLike | null,
  keyCount: number,
  settings: Settings,
): KeyMapping {
  if (keyCount < MIN_KEY_COUNT || keyCount > MAX_KEY_COUNT) {
    return { codes: [], keyCount, source: "fallback" };
  }

  // 1. Live resolved keybinds on the game instance.
  const live = game?.columnKeybinds;
  if (Array.isArray(live) && live.length === keyCount) {
    const codes = live.map((pair) => pair?.[0] ?? null);
    if (codes.every((code) => typeof code === "string" && code.length > 0)) {
      return { codes: codes as string[], keyCount, source: "site" };
    }
  }

  // 2. Cloned settings on the game instance.
  const keyModes = game?.settings?.keybinds?.keyModes;
  if (Array.isArray(keyModes)) {
    const mode = keyModes[keyCount - 1];
    if (Array.isArray(mode) && mode.length === keyCount) {
      const codes = mode.map((pair) => pair?.[0] ?? null);
      if (codes.every((code) => typeof code === "string" && code.length > 0)) {
        return { codes: codes as string[], keyCount, source: "site" };
      }
    }
  }

  // 3. User override.
  const override = settings.input.keyMappings[String(keyCount)];
  if (Array.isArray(override) && override.length === keyCount) {
    return { codes: [...override], keyCount, source: "user" };
  }

  // 4. Fallback layout.
  return { codes: fallbackCodes(keyCount), keyCount, source: "fallback" };
}

/** Secondary keybinds per column, for columns that have two keys bound. */
export function buildSecondaryMapping(
  game: GameLike | null,
  keyCount: number,
): (string | null)[] {
  const source =
    (Array.isArray(game?.columnKeybinds) && game!.columnKeybinds!.length === keyCount
      ? game!.columnKeybinds
      : game?.settings?.keybinds?.keyModes?.[keyCount - 1]) ?? null;

  if (!Array.isArray(source) || source.length !== keyCount) {
    return new Array(keyCount).fill(null);
  }
  return source.map((pair) => pair?.[1] ?? null);
}

/** Built-in default layout, extended past 10K with spare key codes. */
export function fallbackCodes(keyCount: number): string[] {
  const known = FALLBACK_KEYBINDS[keyCount - 1];
  if (known) return known.map((pair) => pair[0] ?? "Space");

  // 11K..18K: start from the 10K layout and append unused codes.
  const base = (FALLBACK_KEYBINDS[FALLBACK_KEYBINDS.length - 1] ?? []).map(
    (pair) => pair[0] ?? "Space",
  );
  const used = new Set(base);
  const out = [...base];
  for (const code of EXTENDED_SUFFIX_CODES) {
    if (out.length >= keyCount) break;
    if (!used.has(code)) {
      out.push(code);
      used.add(code);
    }
  }
  while (out.length < keyCount) out.push("Space");
  return out.slice(0, keyCount);
}

/** Extract a normalised chart from a live game. */
export function buildChartFromGame(
  game: GameLike,
  keyCount: number,
): ParsedChart | null {
  const raw = game.hitObjects;
  if (!Array.isArray(raw) || raw.length === 0) return null;

  // Copy only the fields we need. This detaches us from the site's objects
  // (which carry Pixi sprites, Howl refs, etc.) and keeps the timeline
  // compact for the hot path.
  const notes: SiteHitObject[] = new Array(raw.length);
  let minTime = Infinity;
  let maxEnd = -Infinity;
  let maxColumn = -1;

  for (let i = 0; i < raw.length; i++) {
    const src = raw[i];
    const time = Number(src.time);
    const rawEnd = Number(src.endTime);
    const endTime = Number.isFinite(rawEnd) ? rawEnd : time;
    const column = Math.trunc(Number(src.column));
    const isHold = src.type === "hold";

    // The site stores every hold as TWO objects: a head `tap` whose endTime is
    // the hold's end, plus the `hold` itself. Preserve the head's endTime and
    // its explicit flag. An earlier version collapsed endTime to time here to
    // "normalise taps", which destroyed the only marker identifying the head:
    // the timeline then treated it as a real tap and emitted a duplicate press
    // plus a deferred release that let go of the hold ~12ms after it started.
    const note: SiteHitObject = isHold
      ? { type: "hold", column, time, endTime: Math.max(endTime, time) }
      : { type: "tap", column, time, endTime };
    if (note.type === "tap" && src.type === "tap" && src.isHoldHead === true) {
      note.isHoldHead = true;
    }
    notes[i] = note;

    if (time < minTime) minTime = time;
    const end = isHold ? endTime : time;
    if (end > maxEnd) maxEnd = end;
    if (column > maxColumn) maxColumn = column;
  }

  // Already sorted by the site, but re-sort defensively: a stable sort on a
  // sorted array is O(n) in practice and guarantees our binary searches hold.
  // No type tiebreaker: the timeline's hold deduplication is a Set lookup, so
  // it does not care whether a head lands before or after its hold.
  notes.sort((a, b) => a.time - b.time || a.column - b.column);

  // Sanity: if notes reference columns beyond the detected key count, the
  // key count is wrong. Trust the chart.
  const effectiveKeyCount = Math.max(keyCount, maxColumn + 1);

  const startTime = Number.isFinite(game.startTime) && game.startTime > 0
    ? game.startTime
    : minTime;
  const endTime = Number.isFinite(game.endTime) && game.endTime > startTime
    ? game.endTime
    : maxEnd;

  const noteCount = countUniqueNotes(notes);

  // The signature identifies "is this the same chart?" and must depend only on
  // structural facts. It used to fold in the label, which meant any change to
  // how a chart is *described* looked like the user switching beatmaps.
  const signature = hashString(
    `${effectiveKeyCount}|${notes.length}|${noteCount}|${Math.round(startTime)}|${Math.round(endTime)}`,
  );

  return {
    keyCount: effectiveKeyCount,
    notes,
    noteCount,
    startTime,
    endTime,
    signature,
    label: describeGame(game, effectiveKeyCount, noteCount, startTime, endTime),
  };
}

/**
 * Best-effort human description of the current run, for the UI.
 *
 * The site's `Game` does not retain any beatmap metadata. Its constructor
 * copies `hitObjects`, `startTime`, `endTime`, `breaks`, `hitWindows`,
 * `difficulty`, `audioOffset`, `timingPoints`, `delay` and `song` out of
 * `BeatmapData` and drops the rest — including `metadata`, `version`,
 * `beatmapId` and `beatmapHash`. So for the live-game path there is no title to
 * read, and an earlier version of this function looked for
 * `settings.beatmapTitle` / `settings.beatmapVersion`, which have never existed
 * in the site's settings store.
 *
 * Rather than guess, this describes what is actually known: the key count, how
 * many objects the chart holds, and the playfield's time span. When a title is
 * available — the fallback `.osz` path parses one out of the `[Metadata]`
 * section — the caller passes it in.
 */
function describeGame(game: GameLike, keyCount: number, noteCount: number, startTime: number, endTime: number): string {
  const meta = (game as { metadata?: { title?: unknown; artist?: unknown; version?: unknown } }).metadata;
  const title = typeof meta?.title === "string" && meta.title.length > 0 ? meta.title : null;
  if (title) {
    const artist = typeof meta?.artist === "string" && meta.artist.length > 0 ? `${meta.artist} — ` : "";
    const version = typeof meta?.version === "string" && meta.version.length > 0 ? ` [${meta.version}]` : "";
    return `${artist}${title}${version}`;
  }

  const seconds = Math.max(0, Math.round((endTime - startTime) / 1000));
  const span = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  return `${keyCount}K · ${noteCount} notes · ${span}`;
}

/** Full detection: live game -> context. */
export function buildContextFromGame(
  game: GameLike,
  settings: Settings,
  via: string,
): DetectionResult {
  const keyCount = readKeyCount(game);
  if (!keyCount || keyCount < MIN_KEY_COUNT || keyCount > MAX_KEY_COUNT) {
    return {
      ok: false,
      via,
      game,
      reason: `Invalid key count (${keyCount ?? "unknown"}). Expected ${MIN_KEY_COUNT}-${MAX_KEY_COUNT}.`,
    };
  }

  const chart = buildChartFromGame(game, keyCount);
  if (!chart) {
    return {
      ok: false,
      via,
      game,
      reason: "Chart data missing — the game reported no hit objects.",
    };
  }

  const keyMapping = buildKeyMapping(game, chart.keyCount, settings);
  if (keyMapping.codes.length !== chart.keyCount) {
    return {
      ok: false,
      via,
      game,
      chart,
      keyMapping,
      reason: `Key mapping incomplete: ${keyMapping.codes.length} codes for ${chart.keyCount} columns.`,
    };
  }

  // Refuse to run while the site's own autoplay mod is on: two independent
  // schedulers driving the same input system would double-fire every note.
  const siteAutoplay = game.mods?.autoplay ?? game.settings?.mods?.autoplay;
  if (siteAutoplay) {
    return {
      ok: false,
      via,
      game,
      chart,
      keyMapping,
      reason:
        "The site's built-in Autoplay mod is enabled. Turn it off to use this tool (running both would double-fire every note).",
    };
  }

  // A replay in progress drives input itself; don't fight it.
  if ((game as any).replayPlayer) {
    return {
      ok: false,
      via,
      game,
      chart,
      keyMapping,
      reason: "A replay is currently playing. Autoplay is disabled during replays.",
    };
  }

  return { ok: true, via, game, chart, keyMapping };
}
