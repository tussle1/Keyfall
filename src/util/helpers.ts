/** Small shared helpers. No dependencies, no DOM assumptions. */

export const clamp = (value: number, min: number, max: number): number =>
  value < min ? min : value > max ? max : value;

/**
 * Binary search: index of the first element whose key is >= target.
 * Returns `length` if every element is smaller.
 *
 * Used for O(log n) lookups into the sorted action timeline instead of
 * scanning from the front, which matters on 5k+ note charts.
 */
export function lowerBound<T>(
  arr: T[],
  target: number,
  key: (item: T) => number,
  from = 0,
): number {
  let lo = from;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (key(arr[mid]) < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Stable sort by a numeric key, preserving insertion order for ties. */
export function stableSortBy<T>(arr: T[], key: (item: T) => number): T[] {
  // Array.prototype.sort is stable in every engine we target (ES2019+),
  // but we decorate with the original index anyway so ties are deterministic
  // even if this is ever run somewhere unusual.
  return arr
    .map((item, index) => ({ item, index, k: key(item) }))
    .sort((a, b) => a.k - b.k || a.index - b.index)
    .map((entry) => entry.item);
}

/** Format ms as a compact clock, e.g. 182_340 -> "3:02.340". */
export function formatTime(ms: number): string {
  if (!Number.isFinite(ms)) return "--:--";
  const negative = ms < 0;
  const total = Math.floor(Math.abs(ms));
  const minutes = Math.floor(total / 60_000);
  const seconds = Math.floor((total % 60_000) / 1000);
  const millis = total % 1000;
  const body = `${minutes}:${String(seconds).padStart(2, "0")}.${String(
    millis,
  ).padStart(3, "0")}`;
  return negative ? `-${body}` : body;
}

/** 2481 -> "2,481" without pulling in Intl for a hot path. */
export function groupDigits(n: number): string {
  const s = String(Math.trunc(n));
  return s.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** `"KeyD"` -> `"D"`, `"Space"` -> `"␣"`, `"Semicolon"` -> `";"`. */
export function humanizeCode(code: string): string {
  if (!code) return "?";
  if (code === "Space") return "␣";
  if (code.startsWith("Key")) return code.slice(3);
  if (code.startsWith("Digit")) return code.slice(5);
  const specials: Record<string, string> = {
    Semicolon: ";",
    Quote: "'",
    Comma: ",",
    Period: ".",
    Slash: "/",
    Backslash: "\\",
    BracketLeft: "[",
    BracketRight: "]",
    Minus: "-",
    Equal: "=",
    Backquote: "`",
    Escape: "Esc",
    Enter: "⏎",
    Tab: "⇥",
    ShiftLeft: "L⇧",
    ShiftRight: "R⇧",
    ControlLeft: "LCtrl",
    ControlRight: "RCtrl",
    AltLeft: "LAlt",
    AltRight: "RAlt",
    MetaLeft: "L⌘",
    MetaRight: "R⌘",
  };
  return specials[code] ?? code;
}

/** Best-effort `KeyboardEvent.key` for a given `code`. */
export function keyForCode(code: string): string {
  if (code === "Space") return " ";
  if (code.startsWith("Key")) return code.slice(3).toLowerCase();
  if (code.startsWith("Digit")) return code.slice(5);
  if (code.startsWith("Arrow")) return code.slice(5);
  if (code.startsWith("Numpad")) return code.slice(6);
  const map: Record<string, string> = {
    Semicolon: ";",
    Quote: "'",
    Comma: ",",
    Period: ".",
    Slash: "/",
    Backslash: "\\",
    BracketLeft: "[",
    BracketRight: "]",
    Minus: "-",
    Equal: "=",
    Backquote: "`",
  };
  return map[code] ?? code;
}

/** Cheap, stable string hash for chart signatures. */
export function hashString(input: string): string {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

/** Round to n decimals without floating point noise. */
export function round(n: number, decimals = 2): number {
  const f = 10 ** decimals;
  return Math.round(n * f) / f;
}

/** Shallow-merge a partial settings object into defaults, recursively. */
export function deepMerge<T>(base: T, patch: unknown): T {
  if (patch === null || patch === undefined) return base;
  if (Array.isArray(base) || typeof base !== "object") {
    return (patch as T) ?? base;
  }
  if (typeof patch !== "object") return base;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    const existing = out[k];
    out[k] =
      existing && typeof existing === "object" && !Array.isArray(existing)
        ? deepMerge(existing, v)
        : v;
  }
  return out as T;
}
