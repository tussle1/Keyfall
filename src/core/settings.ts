import {
  DEFAULT_SETTINGS,
  LOOKAHEAD_MAX,
  LOOKAHEAD_MIN,
  MAX_KEY_COUNT,
  OFFSET_MAX,
  OFFSET_MIN,
  STORAGE_KEY,
} from "../constants";
import type { HotkeyAction, Settings } from "../types";
import { clamp, deepMerge } from "../util/helpers";
import { Emitter } from "../util/emitter";

/**
 * Settings with localStorage persistence.
 *
 * Stored separately from the site's own IndexedDB-persisted settings store so
 * the two can never interfere: we read the site's keybinds, we never write to
 * the site's storage.
 */

export interface SettingsEvents {
  change: { settings: Settings; path: string };
}

export class SettingsManager {
  private current: Settings;
  private emitter = new Emitter<SettingsEvents>();
  private storage: Storage | null;
  private writeScheduled = false;

  constructor(storageKey: string = STORAGE_KEY, win: Window = window) {
    this.storage = safeStorage(win);
    this.current = this.load();
  }

  get all(): Settings {
    return this.current;
  }

  onChange(handler: (payload: SettingsEvents["change"]) => void): () => void {
    return this.emitter.on("change", handler);
  }

  private load(): Settings {
    const base = structuredCloneSafe(DEFAULT_SETTINGS);
    if (!this.storage) return base;

    let raw: string | null = null;
    try {
      raw = this.storage.getItem(STORAGE_KEY);
    } catch {
      // Private browsing / blocked storage: run with defaults, don't crash.
      return base;
    }
    if (!raw) return base;

    try {
      const parsed = JSON.parse(raw);
      return this.sanitize(deepMerge(base, parsed));
    } catch (err) {
      console.warn("[Autoplay] stored settings were unreadable, using defaults", err);
      return base;
    }
  }

  /** Clamp and validate everything, so a corrupt store can't break the engine. */
  private sanitize(settings: Settings): Settings {
    const out = settings;

    out.timing.offset = clamp(num(out.timing.offset, 0), OFFSET_MIN, OFFSET_MAX);
    out.timing.lookahead = clamp(num(out.timing.lookahead, 120), LOOKAHEAD_MIN, LOOKAHEAD_MAX);
    out.timing.inputDelayCompensation = clamp(num(out.timing.inputDelayCompensation, 0), -100, 100);
    out.timing.spinThreshold = clamp(num(out.timing.spinThreshold, 6), 0, 25);

    out.appearance.uiScale = clamp(num(out.appearance.uiScale, 1), 0.6, 2);
    out.appearance.opacity = clamp(num(out.appearance.opacity, 0.92), 0.15, 1);
    out.appearance.position = {
      x: num(out.appearance.position?.x, 16),
      y: num(out.appearance.position?.y, 16),
    };
    out.appearance.size = {
      w: clamp(num(out.appearance.size?.w, 296), 220, 640),
      h: Math.max(0, num(out.appearance.size?.h, 0)),
    };
    if (typeof out.appearance.accent !== "string" || !/^#[0-9a-f]{3,8}$/i.test(out.appearance.accent)) {
      out.appearance.accent = DEFAULT_SETTINGS.appearance.accent;
    }
    out.appearance.collapsed = !!out.appearance.collapsed;

    out.general.enabled = out.general.enabled !== false;
    out.general.showOverlay = out.general.showOverlay !== false;
    out.general.showKeyboard = out.general.showKeyboard !== false;
    out.general.debug = !!out.general.debug;

    // Key mappings: drop anything malformed rather than trusting it.
    const clean: Record<string, string[]> = {};
    for (const [keyCountRaw, codes] of Object.entries(out.input.keyMappings ?? {})) {
      const keyCount = Number(keyCountRaw);
      if (!Number.isInteger(keyCount) || keyCount < 1 || keyCount > MAX_KEY_COUNT) continue;
      if (!Array.isArray(codes) || codes.length !== keyCount) continue;
      if (!codes.every((code) => typeof code === "string" && code.length > 0)) continue;
      clean[String(keyCount)] = codes.slice();
    }
    out.input.keyMappings = clean;
    out.input.useSecondaryKeybind = !!out.input.useSecondaryKeybind;

    const hotkeys = { ...DEFAULT_SETTINGS.input.hotkeys };
    for (const action of Object.keys(hotkeys) as HotkeyAction[]) {
      const value = out.input.hotkeys?.[action];
      if (typeof value === "string" && value.length > 0) hotkeys[action] = value;
    }
    out.input.hotkeys = hotkeys;

    return out;
  }

  /** Replace a nested value by dotted path, e.g. `"timing.offset"`. */
  set(path: string, value: unknown): void {
    const parts = path.split(".");
    let target: any = this.current;
    for (let i = 0; i < parts.length - 1; i++) {
      if (typeof target[parts[i]] !== "object" || target[parts[i]] === null) {
        target[parts[i]] = {};
      }
      target = target[parts[i]];
    }
    target[parts[parts.length - 1]] = value;

    this.current = this.sanitize(this.current);
    this.persist();
    this.emitter.emit("change", { settings: this.current, path });
  }

  patch(patch: Partial<Settings>): void {
    this.current = this.sanitize(deepMerge(this.current, patch));
    this.persist();
    this.emitter.emit("change", { settings: this.current, path: "*" });
  }

  toggleGeneral(key: keyof Settings["general"]): boolean {
    const next = !this.current.general[key];
    this.set(`general.${key}`, next);
    return next;
  }

  reset(): void {
    this.current = structuredCloneSafe(DEFAULT_SETTINGS);
    this.persist();
    this.emitter.emit("change", { settings: this.current, path: "*" });
  }

  /** Coalesce writes: settings sliders fire continuously. */
  private persist(): void {
    const storage = this.storage;
    if (!storage || this.writeScheduled) return;
    this.writeScheduled = true;
    setTimeout(() => {
      this.writeScheduled = false;
      try {
        storage.setItem(STORAGE_KEY, JSON.stringify(this.current));
      } catch {
        // Quota or blocked storage — settings stay in memory for this session.
      }
    }, 250);
  }

  dispose(): void {
    this.emitter.dispose();
  }
}

function num(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function safeStorage(win: Window): Storage | null {
  try {
    const probe = "__wom_probe__";
    win.localStorage.setItem(probe, "1");
    win.localStorage.removeItem(probe);
    return win.localStorage;
  } catch {
    return null;
  }
}

function structuredCloneSafe<T>(value: T): T {
  try {
    return typeof structuredClone === "function"
      ? structuredClone(value)
      : (JSON.parse(JSON.stringify(value)) as T);
  } catch {
    return JSON.parse(JSON.stringify(value)) as T;
  }
}

/**
 * Detect hotkeys that collide with the site's own bindings.
 *
 * Our hotkeys are handled on `keydown` with `preventDefault`, but the site's
 * `InputSystem` also listens on `document` and would still see the event. If a
 * user binds F7 to a column, pressing our "start" hotkey would also register a
 * note hit. We warn instead of silently misbehaving.
 */
export function findHotkeyCollisions(
  settings: Settings,
  siteKeybinds: (string | null)[],
): Array<{ action: HotkeyAction; code: string }> {
  const siteCodes = new Set(siteKeybinds.filter((c): c is string => !!c));
  const collisions: Array<{ action: HotkeyAction; code: string }> = [];

  for (const [action, code] of Object.entries(settings.input.hotkeys) as Array<
    [HotkeyAction, string]
  >) {
    if (siteCodes.has(code)) collisions.push({ action, code });
  }
  return collisions;
}
