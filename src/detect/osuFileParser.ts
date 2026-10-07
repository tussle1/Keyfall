import { hashString } from "../util/helpers";
import type { ParsedChart, SiteHitObject } from "../types";

/**
 * Standalone `.osu` file parser — the *fallback* chart source.
 *
 * Used only when the live `Game` instance cannot be reached (e.g. a future
 * site refactor that hides it). The primary path always prefers reading the
 * site's own already-parsed `hitObjects`, because that array has mods,
 * audio offset and delay baked in by the site itself and is therefore exact.
 *
 * The transform semantics below mirror the site's `parseHitObjects` closely:
 *
 *   column   = floor(x * keyCount / 512)
 *   hold     = type 128, endTime from the `endTime:` field in sampleSet
 *   holdOff  = holds collapse into taps
 *   mirror   = column -> keyCount - 1 - column
 *   random   = NOT reconstructible (the permutation is generated at runtime
 *              and never persisted) — flagged so the engine refuses to guess.
 *   delay    = max(1000 - firstTime / rate, 0) * rate
 *   time    += delay - audioOffset
 *   rate     = applied to audio playback, NOT to note times, so note times are
 *              left alone; `timeElapsed` follows the song.
 */

export interface OsuFileModState {
  mirror: boolean;
  random: boolean;
  holdOff: boolean;
  playbackRate: number;
}

export interface OsuFileParseOptions {
  /** Settings audio offset (ms), as configured on the site. */
  audioOffset?: number;
  mods?: Partial<OsuFileModState>;
  /** Force a key count instead of reading `CircleSize`. */
  keyCountOverride?: number;
}

export interface OsuFileParseResult extends ParsedChart {
  metadata: {
    title: string;
    artist: string;
    version: string;
    creator: string;
  };
  /** True when the chart uses a mod we cannot faithfully reproduce. */
  unreliable: boolean;
  unreliableReason?: string;
}

const SECTION_RE = /^\[(.+)\]$/;

/** Split a `.osu` body into `{ section: string[] }`. */
function splitSections(text: string): Map<string, string[]> {
  const sections = new Map<string, string[]>();
  let current: string[] = [];
  sections.set("__preamble__", current);

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0) continue;

    const match = SECTION_RE.exec(line);
    if (match) {
      current = [];
      sections.set(match[1], current);
      continue;
    }
    if (line.startsWith("//") || line.startsWith(" ")) continue;
    current.push(line);
  }
  return sections;
}

function readKeyValue(lines: string[] | undefined, key: string): string | null {
  if (!lines) return null;
  const prefix = `${key}:`;
  for (const line of lines) {
    if (line.startsWith(prefix)) {
      return line.slice(prefix.length).trim();
    }
  }
  return null;
}

/**
 * Parse `.osu` file text into an engine-owned chart.
 * Returns null (never throws) when the file is not a usable mania chart.
 */
export function parseOsuFile(
  text: string,
  options: OsuFileParseOptions = {},
): OsuFileParseResult | null {
  if (!text || text.length < 16) return null;

  const sections = splitSections(text);
  const metadataLines = sections.get("Metadata");
  const difficultyLines = sections.get("Difficulty");
  const hitObjectLines = sections.get("HitObjects");

  if (!hitObjectLines || hitObjectLines.length === 0) return null;

  // --- Mode check -------------------------------------------------------
  const modeRaw = readKeyValue(sections.get("General"), "Mode");
  const mode = modeRaw === null ? null : Number(modeRaw);
  if (mode !== null && mode !== 3) {
    // 3 == osu!mania. Anything else is not a chart we can play.
    return null;
  }

  // --- Key count --------------------------------------------------------
  const circleSizeRaw = readKeyValue(difficultyLines, "CircleSize");
  const fromFile = circleSizeRaw === null ? NaN : Math.round(Number(circleSizeRaw));
  const keyCount = options.keyCountOverride ?? fromFile;

  if (!Number.isFinite(keyCount) || keyCount < 1 || keyCount > 40) {
    return null;
  }

  const mods: OsuFileModState = {
    mirror: false,
    random: false,
    holdOff: false,
    playbackRate: 1,
    ...options.mods,
  };
  const audioOffset = options.audioOffset ?? 0;

  // --- Hit objects ------------------------------------------------------
  const notes: SiteHitObject[] = [];
  let firstTime = Infinity;

  for (const line of hitObjectLines) {
    const parts = line.split(",");
    if (parts.length < 5) continue;

    const x = Number(parts[0]);
    const time = Number(parts[2]);
    const type = Number(parts[3]);

    if (!Number.isFinite(x) || !Number.isFinite(time) || !Number.isFinite(type)) {
      continue;
    }

    // The site clamps x into range implicitly via floor(); guard anyway so a
    // malformed chart can't produce a negative or out-of-range column.
    let column = Math.floor((x * keyCount) / 512);
    if (column < 0) column = 0;
    if (column > keyCount - 1) column = keyCount - 1;

    const isHold = (type & 128) !== 0;

    let endTime = time;
    if (isHold) {
      const sampleSet = parts[5]?.split(":");
      const parsedEnd = sampleSet ? parseInt(sampleSet[0], 10) : NaN;
      if (Number.isFinite(parsedEnd) && parsedEnd > time) {
        endTime = parsedEnd;
      }
    }

    if (isHold && !mods.holdOff) {
      // The site emits BOTH a head tap and a hold object for every hold note.
      // We reproduce that so note counts and input counts match what the site
      // itself would schedule. The hold drives the release; the head tap
      // drives the press. Deduplicated later by the timeline builder.
      notes.push({ type: "tap", column, time, endTime });
      notes.push({ type: "hold", column, time, endTime });
    } else {
      notes.push({ type: "tap", column, time, endTime: time });
    }

    if (time < firstTime) firstTime = time;
  }

  if (notes.length === 0 || !Number.isFinite(firstTime)) return null;

  // --- Column remap (mirror / random) -----------------------------------
  let unreliable = false;
  let unreliableReason: string | undefined;

  if (mods.mirror) {
    for (const note of notes) {
      note.column = keyCount - 1 - note.column;
    }
  } else if (mods.random) {
    // The permutation is generated at runtime by the site and never persisted,
    // so any mapping we invent would be wrong. Refuse rather than mis-play.
    unreliable = true;
    unreliableReason =
      "Random mod is active — column permutation is generated at runtime and cannot be reconstructed from the .osu file. Use the live-game detection path instead.";
  }

  // --- Delay + audio offset ---------------------------------------------
  const rate = Number.isFinite(mods.playbackRate) && mods.playbackRate > 0
    ? mods.playbackRate
    : 1;
  const delay = Math.max(1000 - firstTime / rate, 0) * rate;

  notes.sort((a, b) => a.time - b.time || a.column - b.column);

  for (const note of notes) {
    note.time += delay - audioOffset;
    note.endTime += delay - audioOffset;
  }

  const startTime = notes[0].time;

  // endTime = latest note end among the final `keyCount` notes, matching site.
  let endTime = 0;
  const tail = notes.slice(-keyCount);
  for (const note of tail) {
    const end = note.type === "hold" ? note.endTime : note.time;
    if (end > endTime) endTime = end;
  }
  if (endTime <= startTime) {
    endTime = notes[notes.length - 1].endTime ?? startTime;
  }

  const title = readKeyValue(metadataLines, "TitleUnicode") ??
    readKeyValue(metadataLines, "Title") ??
    "Unknown title";
  const artist = readKeyValue(metadataLines, "ArtistUnicode") ??
    readKeyValue(metadataLines, "Artist") ??
    "Unknown artist";
  const version = readKeyValue(metadataLines, "Version") ?? "Unknown";
  const creator = readKeyValue(metadataLines, "Creator") ?? "Unknown";

  const signature = hashString(
    `${title}|${version}|${keyCount}|${notes.length}|${Math.round(startTime)}|${Math.round(endTime)}`,
  );

  return {
    keyCount,
    notes,
    // Holds are double-counted above to mirror the site; report unique notes.
    noteCount: countUniqueNotes(notes),
    startTime,
    endTime,
    signature,
    label: `${artist} — ${title} [${version}]`,
    metadata: { title, artist, version, creator },
    unreliable,
    unreliableReason,
  };
}

/**
 * Unique note count: a hold contributes one note even though the site stores
 * both a head tap and a hold object for it.
 *
 * Deliberately order-independent. The head and its hold share a timestamp, so
 * whichever comes first depends entirely on the sort that ran beforehand — a
 * hold sorts before a tap when the comparator breaks ties on the type string.
 * An earlier version compared each tap against the *next* element and silently
 * over-counted whenever the hold landed first.
 */
export function countUniqueNotes(notes: SiteHitObject[]): number {
  const holdKeys = new Set<string>();
  for (const note of notes) {
    if (note.type === "hold" && note.endTime > note.time) {
      holdKeys.add(`${note.time}:${note.column}:${note.endTime}`);
    }
  }

  let count = 0;
  for (const note of notes) {
    if (note.type === "hold") {
      count++;
      continue;
    }
    const isHoldHead =
      note.isHoldHead === true ||
      (note.endTime > note.time && holdKeys.has(`${note.time}:${note.column}:${note.endTime}`));
    if (!isHoldHead) count++;
  }
  return count;
}
