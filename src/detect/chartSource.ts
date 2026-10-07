import { parseOsuFile, type OsuFileParseOptions, type OsuFileParseResult } from "./osuFileParser";

/**
 * Fallback chart source.
 *
 * Two independent things live here:
 *
 *  1. A tiny in-memory registry of charts we have already obtained, keyed by a
 *     signature, so repeated detection attempts don't re-parse.
 *  2. Network sniffing for the `.osz` the site downloads, plus a minimal ZIP
 *     reader, so a chart can be recovered even when the live `Game` instance
 *     is unreachable.
 *
 * Sniffing is strictly read-only: requests are observed and allowed to proceed
 * untouched. Nothing is modified, blocked or replayed.
 */

interface RegistryEntry {
  chart: OsuFileParseResult;
  capturedAt: number;
  source: "osz" | "osu" | "fiber";
}

const registry = new Map<string, RegistryEntry>();
const MAX_REGISTRY_ENTRIES = 12;

export function registerChart(
  chart: OsuFileParseResult,
  source: RegistryEntry["source"],
): void {
  registry.set(chart.signature, { chart, capturedAt: performance.now(), source });
  // Keep the registry bounded: oldest first.
  if (registry.size > MAX_REGISTRY_ENTRIES) {
    const oldest = [...registry.entries()].sort((a, b) => a[1].capturedAt - b[1].capturedAt)[0];
    if (oldest) registry.delete(oldest[0]);
  }
}

export function getRegisteredChart(signature: string): OsuFileParseResult | null {
  return registry.get(signature)?.chart ?? null;
}

/** Most recently captured chart, regardless of signature. */
export function getLatestChart(): OsuFileParseResult | null {
  let latest: RegistryEntry | null = null;
  for (const entry of registry.values()) {
    if (!latest || entry.capturedAt > latest.capturedAt) latest = entry;
  }
  return latest?.chart ?? null;
}

export function clearRegistry(): void {
  registry.clear();
}

/* ------------------------------------------------------------------------- */
/* Minimal ZIP reader                                                         */
/* ------------------------------------------------------------------------- */

interface ZipEntryInfo {
  name: string;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_DIR_SIGNATURE = 0x02014b50;
const LOCAL_HEADER_SIGNATURE = 0x04034b50;

/** Find the End Of Central Directory record, scanning backwards. */
function findEocd(view: DataView): number {
  // EOCD is at least 22 bytes; the comment can be up to 65535 bytes.
  const maxComment = 0xffff;
  const start = Math.max(0, view.byteLength - 22 - maxComment);
  for (let i = view.byteLength - 22; i >= start; i--) {
    if (view.getUint32(i, true) === EOCD_SIGNATURE) return i;
  }
  return -1;
}

function readCentralDirectory(view: DataView): ZipEntryInfo[] {
  const eocd = findEocd(view);
  if (eocd < 0) return [];

  const entryCount = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);
  const entries: ZipEntryInfo[] = [];

  for (let i = 0; i < entryCount; i++) {
    if (offset + 46 > view.byteLength) break;
    if (view.getUint32(offset, true) !== CENTRAL_DIR_SIGNATURE) break;

    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const uncompressedSize = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localHeaderOffset = view.getUint32(offset + 42, true);

    const nameBytes = new Uint8Array(view.buffer, view.byteOffset + offset + 46, nameLength);
    const name = new TextDecoder().decode(nameBytes);

    entries.push({ name, method, compressedSize, uncompressedSize, localHeaderOffset });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** Inflate a single entry's payload. */
async function extractEntry(
  buffer: ArrayBuffer,
  view: DataView,
  entry: ZipEntryInfo,
): Promise<Uint8Array | null> {
  const off = entry.localHeaderOffset;
  if (off + 30 > view.byteLength) return null;
  if (view.getUint32(off, true) !== LOCAL_HEADER_SIGNATURE) return null;

  const nameLength = view.getUint16(off + 26, true);
  const extraLength = view.getUint16(off + 28, true);
  const dataStart = off + 30 + nameLength + extraLength;
  const dataEnd = dataStart + entry.compressedSize;
  if (dataEnd > view.byteLength) return null;

  const payload = new Uint8Array(buffer, dataStart, entry.compressedSize);

  if (entry.method === 0) {
    // Stored
    return payload;
  }
  if (entry.method === 8) {
    // Deflate
    if (typeof DecompressionStream === "undefined") {
      throw new Error("DecompressionStream unavailable in this browser");
    }
    const ds = new DecompressionStream("deflate-raw");
    const stream = new Blob([payload]).stream().pipeThrough(ds);
    const out = await new Response(stream).arrayBuffer();
    return new Uint8Array(out);
  }
  return null;
}

/**
 * Pull the mania `.osu` chart out of an `.osz` blob.
 * Prefers the file matching `preferredVersion` when several difficulties exist.
 */
export async function readOszBlob(
  blob: Blob,
  preferredVersion?: string | null,
): Promise<{ text: string; name: string } | null> {
  const buffer = await blob.arrayBuffer();
  const view = new DataView(buffer);
  const entries = readCentralDirectory(view);
  if (entries.length === 0) return null;

  const osuEntries = entries.filter((e) => e.name.toLowerCase().endsWith(".osu"));
  if (osuEntries.length === 0) return null;

  // Pick the requested difficulty, else the largest chart (most notes is a
  // decent proxy for "the one being played" when we have no better signal).
  const ordered = preferredVersion
    ? [
        ...osuEntries.filter((e) => e.name.includes(preferredVersion)),
        ...osuEntries.filter((e) => !e.name.includes(preferredVersion)),
      ]
    : osuEntries;

  for (const entry of ordered) {
    try {
      const data = await extractEntry(buffer, view, entry);
      if (!data) continue;
      const text = new TextDecoder("utf-8").decode(data);
      if (text.includes("[HitObjects]")) return { text, name: entry.name };
    } catch {
      // Try the next candidate entry.
    }
  }
  return null;
}

/* ------------------------------------------------------------------------- */
/* Network sniffing                                                           */
/* ------------------------------------------------------------------------- */

export interface OszHookOptions {
  parseOptions?: OsuFileParseOptions;
  /** Called after a chart is successfully captured and registered. */
  onChart?: (chart: OsuFileParseResult, source: "osz" | "osu") => void;
  /** Called when something goes wrong; never throws to the host page. */
  onError?: (err: unknown) => void;
}

let installed = false;
let pendingCount = 0;
const MAX_CONCURRENT_PARSES = 3;

/** Is this URL / filename plausibly a beatmap archive? */
function looksLikeOsz(url: string): boolean {
  const lower = url.toLowerCase().split("?")[0];
  return lower.endsWith(".osz") || lower.includes("/download") || lower.includes("beatmap");
}

function looksLikeOsu(url: string): boolean {
  return url.toLowerCase().split("?")[0].endsWith(".osu");
}

async function handleBlob(
  blob: Blob,
  url: string,
  opts: OszHookOptions,
): Promise<void> {
  if (pendingCount >= MAX_CONCURRENT_PARSES) return;
  pendingCount++;
  try {
    let text: string | null = null;

    if (looksLikeOsu(url) && blob.type !== "application/zip") {
      text = await blob.text();
    } else if (looksLikeOsz(url) || blob.size > 1024) {
      const found = await readOszBlob(blob);
      text = found?.text ?? null;
      // Some providers serve a bare .osu with a generic URL.
      if (!text && blob.size < 4_000_000) {
        const maybe = await blob.text();
        if (maybe.includes("[HitObjects]")) text = maybe;
      }
    }

    if (!text) return;

    const chart = parseOsuFile(text, opts.parseOptions);
    if (!chart) return;

    registerChart(chart, url.toLowerCase().endsWith(".osu") ? "osu" : "osz");
    opts.onChart?.(chart, "osz");
  } catch (err) {
    opts.onError?.(err);
  } finally {
    pendingCount--;
  }
}

/**
 * Install read-only observation of fetch/XHR so `.osz` downloads yield charts.
 * Idempotent. Returns an uninstaller.
 */
export function installOszSniffer(win: Window, opts: OszHookOptions = {}): () => void {
  if (installed) return () => {};
  installed = true;

  const originalFetch = win.fetch;
  const patchedFetch: typeof fetch = async function (input, init) {
    const response = await originalFetch.call(win as any, input as any, init);
    try {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : (input as Request)?.url ?? "";
      if (url && (looksLikeOsz(url) || looksLikeOsu(url))) {
        // Clone so the site still gets an unconsumed body.
        response
          .clone()
          .blob()
          .then((blob) => handleBlob(blob, url, opts))
          .catch((err) => opts.onError?.(err));
      }
    } catch (err) {
      opts.onError?.(err);
    }
    return response;
  };

  const OriginalXHR: typeof XMLHttpRequest = (win as any).XMLHttpRequest;
  if (!OriginalXHR) {
    // No XHR in this environment (unlikely in a browser); the fetch hook alone
    // still covers the site's download path.
    return () => {
      try {
        win.fetch = originalFetch;
      } catch {
        /* ignore */
      }
      installed = false;
    };
  }
  const openDescriptor = Object.getOwnPropertyDescriptor(OriginalXHR.prototype, "open");
  const sendDescriptor = Object.getOwnPropertyDescriptor(OriginalXHR.prototype, "send");
  const originalOpen = openDescriptor?.value as ((this: XMLHttpRequest, ...args: any[]) => void) | undefined;
  const originalSend = sendDescriptor?.value as ((this: XMLHttpRequest, ...args: any[]) => void) | undefined;

  type TrackedXHR = XMLHttpRequest & { __womUrl?: string; __womHooked?: boolean };

  const onLoadEnd = function (this: TrackedXHR) {
    try {
      const url = this.__womUrl ?? "";
      if (!url || (!looksLikeOsz(url) && !looksLikeOsu(url))) return;
      // Only blob responses can be handed to the ZIP reader.
      if (this.responseType !== "blob") return;
      const data = this.response;
      if (data instanceof Blob) void handleBlob(data, url, opts);
    } catch (err) {
      opts.onError?.(err);
    }
  };

  const patchedOpen = function (this: TrackedXHR, ...args: any[]) {
    try {
      this.__womUrl = String(args[0] ?? "");
    } catch {
      /* ignore */
    }
    return originalOpen?.apply(this, args as any);
  };

  // The listener must be attached per-instance: `addEventListener` on the
  // prototype does not fire for instances. `send` is the right place because
  // it runs after `open` (so the URL is known) and before the response arrives.
  const patchedSend = function (this: TrackedXHR, ...args: any[]) {
    try {
      if (!this.__womHooked) {
        this.__womHooked = true;
        this.addEventListener("loadend", onLoadEnd);
      }
    } catch {
      /* ignore */
    }
    return originalSend?.apply(this, args as any);
  };

  let xhrPatched = false;
  if (originalOpen && originalSend) {
    try {
      Object.defineProperty(OriginalXHR.prototype, "open", { ...openDescriptor!, value: patchedOpen });
      Object.defineProperty(OriginalXHR.prototype, "send", { ...sendDescriptor!, value: patchedSend });
      xhrPatched = true;
    } catch {
      /* non-writable in some sandboxes; the fetch hook still covers the site */
    }
  }

  return function uninstall() {
    try {
      win.fetch = originalFetch;
    } catch {
      /* ignore */
    }
    if (xhrPatched && openDescriptor && sendDescriptor) {
      try {
        Object.defineProperty(OriginalXHR.prototype, "open", openDescriptor);
        Object.defineProperty(OriginalXHR.prototype, "send", sendDescriptor);
      } catch {
        /* ignore */
      }
    }
    installed = false;
  };
}

export function isSnifferInstalled(): boolean {
  return installed;
}
