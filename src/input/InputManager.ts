import type { InputAction, KeyMapping } from "../types";

/**
 * Browser keyboard input abstraction.
 *
 * How input reaches the game
 * --------------------------
 * Web osu!mania's `InputSystem` registers plain DOM listeners:
 *
 *     document.addEventListener("keydown", ...)
 *     document.addEventListener("keyup",   ...)
 *
 * and its handlers gate only on `event.repeat` — they never check
 * `event.isTrusted`. So a synthetic `KeyboardEvent` dispatched on `document`
 * is processed exactly like a real keypress, flows through the site's own
 * `hit()` / `release()` path, and is judged against the site's own clock.
 *
 * That matters: we are not bypassing anything, not spoofing trust flags, and
 * not calling private scoring functions. The site's normal event path does all
 * the scoring. This is ordinary browser API usage.
 *
 * Key detail: the site maps `event.code` -> column via
 * `settings.keybinds.keyModes[keyCount - 1]`, so we must dispatch the correct
 * `code` (e.g. `"KeyD"`, `"Space"`), not a character.
 */

export interface InputManagerOptions {
  /** Element the site listens on. `document` in practice. */
  target?: EventTarget;
  /**
   * Taps get their release deferred by at least this many ms.
   *
   * The site's own autoplay replay emits a tap's press and release at the
   * *same* timestamp. Emitting both in one synchronous batch is technically
   * faithful but leaves zero key-down time, which some input paths coalesce.
   * A short deferral matches how a real keypress physically behaves and is
   * far outside any judgement window (the tightest is ~±22ms).
   */
  minTapHoldMs?: number;
  /** KeyboardEvent constructor override, for tests. */
  eventCtor?: typeof KeyboardEvent;
  now?: () => number;
  scheduleTask?: (fn: () => void, delayMs: number) => number;
  cancelTask?: (handle: number) => void;
  onEvent?: (action: InputAction, dispatchedAt: number) => void;
  onError?: (err: unknown) => void;
}

interface HeldEntry {
  column: number;
  code: string;
  pressedAtHost: number;
  chartTime: number;
  /** Pending deferred release, if any. */
  releaseHandle: number | null;
  releaseAtChart: number;
}

/**
 * How long a tap's release is deferred after its press.
 *
 * Exported because the humanizer needs the same number: its ordering clamp must
 * keep the next same-column press outside this window, or the deferred release
 * and the new press would swap places.
 */
export const DEFAULT_MIN_TAP_HOLD_MS = 12;

export class InputManager {
  private target: EventTarget;
  private minTapHoldMs: number;
  private Ctor: typeof KeyboardEvent;
  private now: () => number;
  private scheduleTask: (fn: () => void, delayMs: number) => number;
  private cancelTask: (handle: number) => void;
  private onEvent?: InputManagerOptions["onEvent"];
  private onError?: InputManagerOptions["onError"];

  /** code -> held entry. Keyed by code so two columns sharing a key are safe. */
  private held = new Map<string, HeldEntry>();
  /** column -> set of codes currently down for it. */
  private columnCodes = new Map<number, Set<string>>();

  private mapping: KeyMapping | null = null;
  private secondaryCodes: (string | null)[] = [];
  private disposed = false;

  public dispatchedDown = 0;
  public dispatchedUp = 0;
  public suppressedDuplicate = 0;
  /** Jacks faster than `minTapHoldMs`, where a pending release was flushed. */
  public flushedEarlyRelease = 0;
  public failures = 0;

  constructor(options: InputManagerOptions = {}) {
    this.target = options.target ?? document;
    this.minTapHoldMs = Math.max(0, options.minTapHoldMs ?? DEFAULT_MIN_TAP_HOLD_MS);
    this.Ctor = options.eventCtor ?? KeyboardEvent;
    this.now = options.now ?? (() => performance.now());
    this.scheduleTask =
      options.scheduleTask ?? ((fn, d) => setTimeout(fn, d) as unknown as number);
    this.cancelTask = options.cancelTask ?? ((h) => clearTimeout(h));
    this.onEvent = options.onEvent;
    this.onError = options.onError;
  }

  /** Bind the active key mapping. Called on every (re)detection. */
  setMapping(mapping: KeyMapping, secondaryCodes: (string | null)[] = []): void {
    this.mapping = mapping;
    this.secondaryCodes = secondaryCodes;
  }

  get codeForColumn(): string[] {
    return this.mapping?.codes ?? [];
  }

  /** Codes currently held down, in press order. */
  get heldCodes(): string[] {
    return Array.from(this.held.keys());
  }

  /** Columns currently held down. */
  get heldColumns(): number[] {
    const out: number[] = [];
    for (const [column, codes] of this.columnCodes) {
      if (codes.size > 0) out.push(column);
    }
    return out.sort((a, b) => a - b);
  }

  get heldCount(): number {
    return this.held.size;
  }

  isColumnHeld(column: number): boolean {
    return (this.columnCodes.get(column)?.size ?? 0) > 0;
  }

  /**
   * Chart time at which each currently-held key was pressed.
   *
   * The stuck-key watchdog needs a real press timestamp to measure against;
   * without it, "how long has this been held" is always zero and the watchdog
   * can never fire.
   */
  heldSinceChart(): Map<number, number> {
    const out = new Map<number, number>();
    for (const entry of this.held.values()) {
      const existing = out.get(entry.column);
      // If several codes map to one column, keep the earliest press.
      if (existing === undefined || entry.chartTime < existing) {
        out.set(entry.column, entry.chartTime);
      }
    }
    return out;
  }

  /* --------------------------- public API --------------------------- */

  press(column: number, chartTime: number): void {
    const codes = this.codesForColumn(column);
    for (const code of codes) this.keyDown(code, column, chartTime);
  }

  release(column: number, chartTime: number): void {
    const codes = this.codesForColumn(column);
    // Release every code bound to this column, even ones we didn't record
    // pressing, so a stale state can never pin a key down.
    for (const code of codes) this.keyUp(code, column, chartTime);

    const bound = this.columnCodes.get(column);
    if (bound && bound.size > 0) {
      for (const code of Array.from(bound)) this.keyUp(code, column, chartTime);
    }
  }

  tap(column: number, chartTime: number): void {
    this.press(column, chartTime);
    this.release(column, chartTime + this.minTapHoldMs);
  }

  hold(column: number, durationMs: number, chartTime: number): void {
    this.press(column, chartTime);
    this.release(column, chartTime + Math.max(durationMs, this.minTapHoldMs));
  }

  /**
   * Apply one same-timestamp batch, in order.
   *
   * A tap's press and release arrive in the same batch at the same chart time;
   * the release is deferred by `minTapHoldMs` via the scheduler rather than
   * fired synchronously, so the key is actually down for a measurable moment.
   * Holds (endTime > time) are never deferred.
   */
  applyActions(actions: InputAction[], chartTime: number): void {
    if (this.disposed) return;

    for (const action of actions) {
      if (action.type === "down") {
        this.keyDown(action.code, action.column, action.time);
        continue;
      }

      const held = this.held.get(action.code);
      const isImmediateTapRelease = held !== undefined && held.chartTime === action.time;

      if (isImmediateTapRelease && this.minTapHoldMs > 0) {
        this.deferRelease(action.code, action.column, this.minTapHoldMs);
      } else {
        this.keyUp(action.code, action.column, action.time);
      }
    }

    // chartTime is informational here; per-action times drive the logic.
    void chartTime;
  }

  /* ------------------------- event plumbing ------------------------- */

  private codesForColumn(column: number): string[] {
    const primary = this.mapping?.codes[column];
    if (!primary) return [];
    const out = [primary];
    const secondary = this.secondaryCodes[column];
    if (secondary && secondary !== primary) out.push(secondary);
    return out;
  }

  private keyDown(code: string, column: number, chartTime: number): void {
    if (this.disposed || !code) return;

    const existing = this.held.get(code);
    if (existing) {
      if (existing.releaseHandle !== null) {
        // A tap's deferred release is still pending and the column is being
        // pressed again — this is a jack faster than `minTapHoldMs`.
        //
        // Suppressing the press here would silently drop the note: the site
        // would still see the column as held, so its own `hit()` would no-op
        // too. Instead, complete the pending release immediately and then
        // press again. That reproduces what a physical key does (up, then
        // down) and keeps the site's `pressedColumns` in step with ours.
        this.cancelTask(existing.releaseHandle);
        existing.releaseHandle = null;
        this.flushedEarlyRelease++;
        this.keyUp(code, column, chartTime);
        // Fall through to the press below rather than returning.
      } else {
        // Genuinely already down with no pending release: a real duplicate
        // (e.g. two columns bound to the same key). The site ignores repeats
        // too, so this is a no-op there; counting it aids diagnosis.
        this.suppressedDuplicate++;
        return;
      }
    }

    const dispatched = this.dispatch("keydown", code, chartTime);
    if (!dispatched) {
      this.failures++;
      return;
    }

    this.held.set(code, {
      column,
      code,
      pressedAtHost: this.now(),
      chartTime,
      releaseHandle: null,
      releaseAtChart: chartTime,
    });

    let set = this.columnCodes.get(column);
    if (!set) {
      set = new Set();
      this.columnCodes.set(column, set);
    }
    set.add(code);

    this.dispatchedDown++;
    this.onEvent?.({ seq: -1, time: chartTime, type: "down", column, code, simultaneous: false, holdDuration: 0 }, this.now());
  }

  private keyUp(code: string, column: number, chartTime: number): void {
    if (this.disposed || !code) return;

    const entry = this.held.get(code);
    if (entry?.releaseHandle !== null && entry?.releaseHandle !== undefined) {
      this.cancelTask(entry.releaseHandle);
    }

    // Dispatch the release even if we have no record of the press: the game
    // may have registered it through another path, and a spurious keyup is
    // harmless while a missing one leaves a key stuck.
    const dispatched = this.dispatch("keyup", code, chartTime);
    if (!dispatched) {
      this.failures++;
      return;
    }

    this.held.delete(code);
    const set = this.columnCodes.get(column);
    if (set) {
      set.delete(code);
      if (set.size === 0) this.columnCodes.delete(column);
    }

    this.dispatchedUp++;
    this.onEvent?.({ seq: -1, time: chartTime, type: "up", column, code, simultaneous: false, holdDuration: 0 }, this.now());
  }

  private deferRelease(code: string, column: number, delayMs: number): void {
    const entry = this.held.get(code);
    if (!entry || entry.releaseHandle !== null) return;

    entry.releaseHandle = this.scheduleTask(() => {
      entry.releaseHandle = null;
      this.keyUp(code, column, entry.releaseAtChart + delayMs);
    }, delayMs);
  }

  /** Build and dispatch one synthetic keyboard event. */
  private dispatch(type: "keydown" | "keyup", code: string, _chartTime: number): boolean {
    try {
      const event = new this.Ctor(type, {
        code,
        key: keyFromCode(code),
        // Must be false: the site's handler returns early on `event.repeat`.
        repeat: false,
        bubbles: true,
        cancelable: true,
        composed: true,
        location: 0,
        altKey: false,
        ctrlKey: false,
        metaKey: false,
        shiftKey: false,
      });
      this.target.dispatchEvent(event);
      return true;
    } catch (err) {
      this.onError?.(err);
      return false;
    }
  }

  /* ---------------------------- teardown ---------------------------- */

  /**
   * Release every held key immediately and cancel pending releases.
   * This is the "never leave keys stuck" guarantee; it is safe to call when
   * nothing is held and safe to call repeatedly.
   */
  releaseAll(): number {
    let released = 0;
    for (const entry of Array.from(this.held.values())) {
      if (entry.releaseHandle !== null) {
        this.cancelTask(entry.releaseHandle);
        entry.releaseHandle = null;
      }
      // Inline the keyup so we don't mutate the map while iterating it.
      try {
        this.dispatch("keyup", entry.code, this.now());
        this.dispatchedUp++;
        released++;
      } catch (err) {
        this.onError?.(err);
      }
    }
    this.held.clear();
    this.columnCodes.clear();
    return released;
  }

  dispose(): void {
    if (this.disposed) return;
    this.releaseAll();
    this.disposed = true;
    this.mapping = null;
    this.secondaryCodes = [];
  }
}

/** Minimal `code` -> `key` translation, sufficient for the site's keybinds. */
export function keyFromCode(code: string): string {
  if (!code) return "";
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
    Escape: "Escape",
    Enter: "Enter",
    Tab: "Tab",
  };
  if (map[code]) return map[code];
  if (/^F\d{1,2}$/.test(code)) return code;
  if (code.startsWith("🎮")) return code;
  return code;
}
