import type { HumanizationConfig } from "./humanize/humanizer";

/**
 * Shared type vocabulary for the whole tool.
 *
 * These types deliberately mirror the *observable* shape of Web osu!mania's
 * internals rather than importing them: the tool runs as an injected script
 * with no build-time access to the site's modules. Everything here is
 * structurally typed so that minor site refactors keep working.
 */

/** osu!mania gameplay states, as exposed by the site's `Game.state`. */
export type SiteGameState = "WAIT" | "PLAY" | "PAUSE" | "UNPAUSE" | "FAIL";

/**
 * A tap note.
 *
 * `endTime` is normally equal to `time` — but NOT for a hold's head object,
 * which the site stores as a *tap* carrying the hold's end time. That is the
 * only marker identifying the head, so it must survive every copy and sort;
 * collapsing it to `time` (as an earlier version did while "normalising taps")
 * makes the head indistinguishable from a real tap, and the timeline then
 * emits a duplicate press plus a deferred release that lets go of the hold
 * milliseconds after it started.
 */
export interface TapNote {
  type: "tap";
  column: number;
  time: number;
  endTime: number;
  /** Present on the site's hold-head tap. Optional: `endTime > time` implies it. */
  isHoldHead?: boolean;
}

/** A hold note: press at `time`, release at `endTime`. */
export interface HoldNote {
  type: "hold";
  column: number;
  time: number;
  endTime: number;
}

export type SiteHitObject = TapNote | HoldNote;

/** Per-column keybind pair, exactly as the site stores it (`[primary, secondary]`). */
export type ColumnKeybind = [string | null, string | null];

/**
 * The subset of the site's live `Game` instance that this tool depends on.
 * Kept intentionally small: the narrower the contract, the more resilient
 * the tool is to site changes. See docs/SITE-CONTRACT.md.
 */
export interface GameLike {
  state: SiteGameState;
  /** Chart time of the playhead, in ms. Derived from the audio element. */
  timeElapsed: number;
  startTime: number;
  endTime: number;
  hitObjects: SiteHitObject[];
  difficulty: { keyCount: number; od?: number; hp?: number };
  /** Resolved keybinds for the active key count: `[primary, secondary]` per column. */
  columnKeybinds?: ColumnKeybind[] | null;
  settings?: {
    keybinds?: {
      keyModes?: ColumnKeybind[][];
      pause?: string | null;
      retry?: string | null;
      toggleHud?: string | null;
    };
    mods?: { autoplay?: boolean; playbackRate?: number };
  };
  mods?: { autoplay?: boolean; playbackRate?: number };
  inputSystem?: {
    pressedColumns?: boolean[];
    tappedColumns?: boolean[];
    hit?: (column: number, time?: number) => void;
    release?: (column: number, time?: number) => void;
  };
  scoreSystem?: Record<string, unknown>;
  accuracyText?: { text?: string } | null;
  comboText?: { text?: string } | null;
  scoreText?: { text?: string } | null;
  song?: { seek?: () => number; playing?: () => boolean; rate?: () => number };
  audioOffset?: number;
  /** Pixi application, present on the real `Game`. Used as a liveness marker. */
  app?: unknown;
  dispose?: () => void;
}

/** A normalised, engine-owned view of the chart. */
export interface ParsedChart {
  keyCount: number;
  notes: SiteHitObject[];
  /** Total note count (holds count once, not twice). */
  noteCount: number;
  startTime: number;
  endTime: number;
  /** Stable identity used to detect "the user switched beatmaps". */
  signature: string;
  /** Human-readable label for the UI, best effort. */
  label?: string;
}

/** A single scheduled physical key action. */
export interface InputAction {
  /** Monotonic index; preserves ordering for replay compatibility. */
  seq: number;
  /** Absolute chart time in ms at which this action should land. */
  time: number;
  type: "down" | "up";
  column: number;
  /** The keybind `code` actually dispatched (e.g. `"KeyD"`). */
  code: string;
  /**
   * True when several actions share the exact same timestamp. Used to keep
   * same-frame simultaneous inputs in a deterministic order.
   */
  simultaneous: boolean;
  /** For `up` actions on holds: the hold's duration in ms. 0 for taps. */
  holdDuration: number;
}

export type EnginePhase =
  | "IDLE"
  | "DETECTING"
  | "READY"
  | "RUNNING"
  | "PAUSED"
  | "STOPPING"
  | "ERROR";

export interface EngineStats {
  notesTotal: number;
  notesRemaining: number;
  actionsFired: number;
  pressesDown: number;
  releasesUp: number;
  /** Notes the site judged, read back from its own HUD when available. */
  hits: number;
  combo: number;
  accuracy: number | null;
  score: number | null;
  /** Chart time of the playhead, ms. */
  timeElapsed: number;
  /** Wall-clock scheduling error of the last fired action, ms. Signed. */
  lastJitter: number;
  /** Rolling average absolute scheduling error, ms. */
  avgJitter: number;
}

export interface KeyMapping {
  /** Column index -> keybind `code`. */
  codes: string[];
  keyCount: number;
  /** Where the mapping came from, for diagnostics. */
  source: "site" | "user" | "fallback";
}

export type HotkeyAction =
  | "toggleUI"
  | "start"
  | "pause"
  | "stop"
  | "emergency";

export interface Settings {
  general: {
    enabled: boolean;
    showOverlay: boolean;
    showKeyboard: boolean;
    debug: boolean;
  };
  timing: {
    /** Applied to every scheduled action. Negative = earlier. ms. */
    offset: number;
    /** How far ahead of the playhead to arm precise timers. ms. */
    lookahead: number;
    /** Extra lead applied to compensate for dispatch latency. ms. */
    inputDelayCompensation: number;
    /** Upper bound on the busy-wait used for sub-ms precision. ms. */
    spinThreshold: number;
  };
  input: {
    /** User overrides, keyed by key count, e.g. `{ "4": ["KeyD", ...] }`. */
    keyMappings: Record<string, string[]>;
    /** Press both keybinds of a column when the site has two bound. */
    useSecondaryKeybind: boolean;
    hotkeys: Record<HotkeyAction, string>;
  };
  appearance: {
    uiScale: number;
    opacity: number;
    accent: string;
    position: { x: number; y: number };
    collapsed: boolean;
    size: { w: number; h: number };
  };
  /**
   * Deliberate timing variation. Off by default: frame-exact playback is the
   * honest baseline, and enabling this makes a run intentionally imperfect.
   * See src/humanize/humanizer.ts for what each control does and for the
   * ordering invariants the perturbation must not break.
   */
  humanization: HumanizationConfig;
}

/** Outcome of a detection attempt. */
export interface DetectionResult {
  ok: boolean;
  /** Which strategy produced the result. */
  via?: string;
  game?: GameLike;
  chart?: ParsedChart;
  keyMapping?: KeyMapping;
  reason?: string;
}
