import { DEFAULT_HUMANIZATION } from "./humanize/humanizer";
import type { Settings } from "./types";

export const NAME = "Keyfall";
export const VERSION = "1.1.0";

/** localStorage key for persisted settings. Versioned so we can migrate. */
export const STORAGE_KEY = "keyfall:settings:v1";

/**
 * Hostnames the tool considers "Web osu!mania".
 *
 * The site has moved hosts twice (Vercel -> Cloudflare Pages -> custom domain),
 * so the check is a suffix match against known deployments rather than an
 * equality check on one domain. Unknown-but-plausible hosts are reported as
 * "possible" so the UI can offer an override instead of dead-ending the user.
 */
export const KNOWN_HOSTS = [
  "webosumania.com",
  "www.webosumania.com",
  "web-osu-mania.pages.dev",
  "web-osu-mania.vercel.app",
];

/** Localhost dev servers for the site's own repo (`npm run dev`). */
export const DEV_HOST_PATTERN = /^(localhost|127\.0\.0\.1|\[::1\])$/;

/** The global the site sets for the Pixi devtools extension while playing. */
export const PIXI_APP_GLOBAL = "__PIXI_APP__";

/** Key counts supported for mapping/UI. The site filters beyond this. */
export const MIN_KEY_COUNT = 1;
export const MAX_KEY_COUNT = 18;

/**
 * Fallback keybind layout used only when the site's own keybinds cannot be
 * read AND the user has not configured a mapping. Mirrors the site's defaults
 * so that a fresh install behaves sensibly.
 * Index = keyCount - 1.
 */
export const FALLBACK_KEYBINDS: (string | null)[][][] = [
  [["Space"]], // 1K
  [["KeyF"], ["KeyJ"]], // 2K
  [["KeyF"], ["Space"], ["KeyJ"]], // 3K
  [["KeyD"], ["KeyF"], ["KeyJ"], ["KeyK"]], // 4K
  [["KeyD"], ["KeyF"], ["Space"], ["KeyJ"], ["KeyK"]], // 5K
  [["KeyS"], ["KeyD"], ["KeyF"], ["KeyJ"], ["KeyK"], ["KeyL"]], // 6K
  [["KeyS"], ["KeyD"], ["KeyF"], ["Space"], ["KeyJ"], ["KeyK"], ["KeyL"]], // 7K
  [
    ["KeyA"],
    ["KeyS"],
    ["KeyD"],
    ["KeyF"],
    ["KeyJ"],
    ["KeyK"],
    ["KeyL"],
    ["Semicolon"],
  ], // 8K
  [
    ["KeyA"],
    ["KeyS"],
    ["KeyD"],
    ["KeyF"],
    ["Space"],
    ["KeyJ"],
    ["KeyK"],
    ["KeyL"],
    ["Semicolon"],
  ], // 9K
  [
    ["KeyA"],
    ["KeyS"],
    ["KeyD"],
    ["KeyF"],
    ["KeyV"],
    ["KeyN"],
    ["KeyJ"],
    ["KeyK"],
    ["KeyL"],
    ["Semicolon"],
  ], // 10K
];

/** Extend 11K..18K programmatically rather than typing them all out. */
export const EXTENDED_SUFFIX_CODES = [
  "KeyQ",
  "KeyW",
  "KeyE",
  "KeyR",
  "KeyT",
  "KeyY",
  "KeyU",
  "KeyI",
  "KeyO",
  "KeyP",
];

export const DEFAULT_SETTINGS: Settings = {
  general: {
    enabled: true,
    showOverlay: true,
    showKeyboard: true,
    debug: false,
  },
  timing: {
    offset: 0,
    lookahead: 120,
    inputDelayCompensation: 0,
    spinThreshold: 6,
  },
  input: {
    keyMappings: {},
    useSecondaryKeybind: false,
    hotkeys: {
      // Right Shift toggles the panel: it is a modifier the site never uses as
      // a column key, it is reachable without looking, and it cannot be hit by
      // accident while typing or playing. The action keys are letters chosen
      // from the set that appears in NO column layout: FALLBACK_KEYBINDS
      // covers A S D F V N J K L (plus Space and Semicolon) and
      // EXTENDED_SUFFIX_CODES covers Q W E R T Y U I O P, so a default hotkey
      // can never double as a column key at any key count.
      // Mnemonics: G = go, B = break, X = stop, Z = last resort.
      toggleUI: "ShiftRight",
      start: "KeyG",
      pause: "KeyB",
      stop: "KeyX",
      emergency: "KeyZ",
    },
  },
  appearance: {
    uiScale: 1,
    opacity: 0.92,
    accent: "#ff6b9d",
    position: { x: 16, y: 16 },
    collapsed: false,
    size: { w: 296, h: 0 },
  },
  humanization: { ...DEFAULT_HUMANIZATION },
};

/**
 * The original F-key hotkey defaults. Installs that ran before the letter-key
 * defaults persisted these into localStorage. A stored hotkey set that still
 * matches this exactly has never been customised, so load() migrates it to the
 * current defaults; any other stored set is a deliberate choice and is kept.
 */
export const LEGACY_DEFAULT_HOTKEYS: Settings["input"]["hotkeys"] = {
  toggleUI: "F6",
  start: "F7",
  pause: "F8",
  stop: "F9",
  emergency: "F10",
};

/** Timing offset slider bounds, per spec. */
export const OFFSET_MIN = -200;
export const OFFSET_MAX = 200;

/** Scheduling window bounds. */
export const LOOKAHEAD_MIN = 20;
export const LOOKAHEAD_MAX = 500;

/** How often the status readout is allowed to touch the DOM. */
export const UI_UPDATE_INTERVAL = 90; // ms

/** How often the debug log is flushed to the DOM. */
export const DEBUG_FLUSH_INTERVAL = 150; // ms

/**
 * Idle poll interval for *detection only*.
 *
 * Note this is deliberately NOT used for note scheduling — the spec forbids
 * per-note polling, and the scheduler uses precise timers instead. This single
 * slow timer exists purely to notice "a game started" / "a game ended".
 */
export const DETECT_POLL_INTERVAL = 700; // ms

/** Safety: if a key has been held longer than this with no matching release
 *  action in the queue, force-release it. Guards against stuck keys when the
 *  chart or the site misbehaves. */
export const STUCK_KEY_TIMEOUT = 20_000; // ms

/** Guard against runaway scheduling if the clock mapping goes non-monotonic. */
export const MAX_CATCHUP_ACTIONS_PER_FRAME = 256;
