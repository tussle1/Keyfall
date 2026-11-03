import { UI_TOGGLE_CODE } from "./constants";
import type { HotkeyAction, Settings } from "./types";
import { listen } from "./ui/dom";

/**
 * Hotkey handling.
 *
 * Two rules make this safe to run inside someone else's page:
 *
 *  1. Only *trusted* events count. Our own synthetic keypresses are dispatched
 *     on `document` with `bubbles: true`, so without this check an autoplay
 *     note on a column bound to (say) KeyG would trigger the "start" hotkey.
 *     `event.isTrusted` is the clean discriminator: real user input is trusted,
 *     script-generated input is not.
 *
 *  2. Capture phase + `stopPropagation`. The site's `InputSystem` listens on
 *     `document` in the bubble phase, so handling in capture and stopping
 *     propagation prevents a hotkey from also registering as a column hit.
 *
 * Collisions with the site's keybinds are detected and surfaced rather than
 * silently misbehaving.
 */

export interface HotkeyHooks {
  onAction: (action: HotkeyAction) => void;
  /** All keybind codes the site currently uses, for collision warnings. */
  getSiteCodes: () => string[];
  onCollision?: (collisions: Array<{ action: HotkeyAction; code: string }>) => void;
  /**
   * True while the overlay is capturing a keystroke for rebinding. The binding
   * keystroke must never fire the action it is about to replace (pressing the
   * old key of another action during a capture would trigger it).
   */
  isCapturing?: () => boolean;
}

export class HotkeyManager {
  private hooks: HotkeyHooks;
  private codes = new Map<string, HotkeyAction>();
  private disposer: (() => void) | null = null;
  private collisions: Array<{ action: HotkeyAction; code: string }> = [];

  constructor(hooks: HotkeyHooks) {
    this.hooks = hooks;
  }

  /** Rebuild the code -> action table from settings. */
  apply(settings: Settings): void {
    this.codes.clear();
    for (const [action, code] of Object.entries(settings.input.hotkeys) as Array<
      [HotkeyAction, string]
    >) {
      if (action !== "toggleUI" && code !== UI_TOGGLE_CODE && typeof code === "string" && code.length > 0) {
        this.codes.set(code, action);
      }
    }
    // Do not let a stale/custom store replace or steal the panel shortcut.
    this.codes.set(UI_TOGGLE_CODE, "toggleUI");
    this.detectCollisions();
  }

  install(): void {
    if (this.disposer) return;
    this.disposer = listen(
      document,
      "keydown",
      (event) => this.onKeyDown(event as KeyboardEvent),
      { capture: true },
    );
  }

  private onKeyDown(event: KeyboardEvent): void {
    // Ignore our own synthetic events and key repeats.
    if (!event.isTrusted || event.repeat) return;

    // Never swallow modifier combos — those belong to the browser or the page.
    if (event.ctrlKey || event.metaKey || event.altKey) return;

    const action = this.codes.get(event.code);
    if (!action) return;

    // Right Shift remains an escape hatch even while a rebind is listening or
    // a text field has focus. Every other action belongs to the capture/input.
    if (action !== "toggleUI") {
      if (this.hooks.isCapturing?.()) return;
      const target = event.target as HTMLElement | null;
      if (target && (/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) || target.isContentEditable)) return;
    }

    event.preventDefault();
    // Stop other listeners on this document too (not only ancestors).
    if (typeof event.stopImmediatePropagation === "function") event.stopImmediatePropagation();
    else event.stopPropagation();
    this.hooks.onAction(action);
  }

  private detectCollisions(): void {
    const siteCodes = new Set(this.hooks.getSiteCodes());
    const hadCollisions = this.collisions.length > 0;
    this.collisions = [];
    for (const [code, action] of this.codes) {
      if (siteCodes.has(code)) this.collisions.push({ action, code });
    }
    // Report resolution too, so an old warning disappears after rebinding.
    if (this.collisions.length > 0 || hadCollisions) this.hooks.onCollision?.(this.collisions);
  }

  get currentCollisions(): Array<{ action: HotkeyAction; code: string }> {
    return this.collisions;
  }

  dispose(): void {
    this.disposer?.();
    this.disposer = null;
    this.codes.clear();
  }
}
