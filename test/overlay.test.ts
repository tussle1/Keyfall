import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { DEFAULT_SETTINGS } from "../src/constants";
import { SettingsManager } from "../src/core/settings";
import { HotkeyManager } from "../src/hotkeys";
import { Overlay, type OverlayHost } from "../src/ui/overlay";
import { MOTION } from "../src/ui/motion";
import { buildCss } from "../src/ui/styles";
import type { HotkeyAction, ParsedChart } from "../src/types";
import { installDom, StubEventTarget, type StubElement, type StubEnvironment } from "./helpers/domStub";

let env: StubEnvironment;
beforeEach(() => { env = installDom(); env.globalsInstalled(); });
afterEach(() => { env.globalsRemoved(); });

function event(type: string, extra: Record<string, unknown> = {}): any {
  return {
    type, bubbles: false, defaultPrevented: false, __propagationStopped: false,
    preventDefault() { this.defaultPrevented = true; },
    stopPropagation() { this.__propagationStopped = true; },
    ...extra,
  };
}

function find(root: HTMLElement, selector: string): any {
  const node = root.querySelector(selector);
  assert.ok(node, `missing ${selector}`);
  return node;
}

function createOverlay() {
  const settings = new SettingsManager(undefined, env.window);
  const calls: string[] = [];
  const host: OverlayHost = {
    onStart: () => calls.push("start"),
    onPause: () => calls.push("pause"),
    onStop: () => calls.push("stop"),
    onEmergency: () => calls.push("emergency"),
    onSettingChange: () => calls.push("settings"),
    onRebindMapping: () => calls.push("mapping"),
    getDiagnostics: () => ({}),
    getHumanizationStats: () => null,
  };
  const overlay = new Overlay(host, settings);
  env.document.documentElement.appendChild(overlay.root as unknown as StubElement);
  return { overlay, settings, calls };
}

const chart: ParsedChart = {
  keyCount: 4,
  notes: [{ type: "tap", column: 0, time: 1000, endTime: 1000 }],
  noteCount: 1,
  startTime: 1000,
  endTime: 1000,
  signature: "chart",
  label: "Test chart",
};

describe("trainer overlay", () => {
  it("starts hidden and inert; stored visibility and resetting settings cannot open it", () => {
    const { overlay, settings } = createOverlay();
    assert.equal(overlay.isVisible, false);
    assert.equal(overlay.root.dataset.open, "0");
    assert.equal(overlay.root.getAttribute("aria-hidden"), "true");
    assert.equal(overlay.root.inert, true);
    settings.set("general.showOverlay", true);
    settings.reset();
    assert.equal(overlay.isVisible, false);
    overlay.setVisible(true);
    assert.equal(overlay.root.dataset.open, "1");
    assert.equal(overlay.root.inert, false);
    settings.reset();
    assert.equal(overlay.isVisible, true, "reset does not close the panel either");
    overlay.setVisible(false);
    assert.equal(overlay.root.getAttribute("aria-hidden"), "true");
    overlay.dispose(); settings.dispose();
  });

  it("keeps quick and expanded sliders in sync and resets individual values", () => {
    const { overlay, settings } = createOverlay();
    const sliders = overlay.root.querySelectorAll<HTMLInputElement>('[data-setting="timing.offset"]');
    assert.equal(sliders.length, 2);
    sliders[0].value = "-37";
    sliders[0].dispatchEvent(event("input"));
    assert.equal(settings.all.timing.offset, -37);
    assert.equal(sliders[1].value, "-37");
    assert.equal((sliders[0].parentNode as HTMLElement).style.getPropertyValue("--wom-progress"), "40.75%");
    assert.equal((sliders[1].parentNode as HTMLElement).style.getPropertyValue("--wom-progress"), "40.75%");
    assert.equal(sliders[0].type, "range", "the visual overlay does not replace the native input");
    assert.equal(sliders[0].getAttribute("aria-label"), "Offset (ms)");
    const reset = find(overlay.root, ".wom-slider-reset");
    reset.dispatchEvent(event("click"));
    assert.equal(settings.all.timing.offset, 0);
    assert.equal(sliders[1].value, "0");
    overlay.dispose(); settings.dispose();
  });

  it("settles clicks but switches to direct pointer tracking while dragging", () => {
    const { overlay, settings } = createOverlay();
    overlay.setVisible(true);
    const [slider, mirror] = overlay.root.querySelectorAll<HTMLInputElement>('[data-setting="timing.offset"]');
    const wrap = slider.parentNode as HTMLElement;
    const mirrorWrap = mirror.parentNode as HTMLElement;
    const pointer = (type: string, pointerId: number, clientX: number, clientY = 0) =>
      event(type, { pointerId, clientX, clientY, button: 0, isPrimary: true });

    slider.dispatchEvent(pointer("pointerdown", 1, 100));
    slider.value = "50"; slider.dispatchEvent(event("input"));
    assert.notEqual(wrap.dataset.direct, "1", "a track click may settle");
    assert.equal(wrap.style.getPropertyValue("--wom-progress"), "62.5%");
    env.window.dispatchEvent(pointer("pointermove", 2, 150));
    assert.notEqual(wrap.dataset.direct, "1", "another pointer cannot start this drag");
    env.window.dispatchEvent(pointer("pointermove", 1, 101));
    assert.notEqual(wrap.dataset.direct, "1", "tiny click jitter is not a drag");
    env.window.dispatchEvent(pointer("pointermove", 1, 120));
    assert.equal(wrap.dataset.direct, "1");
    slider.value = "100"; slider.dispatchEvent(event("input"));
    assert.equal(settings.all.timing.offset, 100);
    assert.equal(mirror.value, "100");
    assert.equal(wrap.style.getPropertyValue("--wom-progress"), "75%");
    assert.equal(mirrorWrap.style.getPropertyValue("--wom-progress"), "75%");
    assert.notEqual(mirrorWrap.dataset.direct, "1", "only the manipulated control tracks directly");
    env.window.dispatchEvent(pointer("pointercancel", 1, 120));
    assert.equal(wrap.dataset.direct, "0");

    slider.dispatchEvent(pointer("pointerdown", 3, 100));
    env.window.dispatchEvent(pointer("pointermove", 3, 130));
    overlay.setVisible(false);
    assert.equal(wrap.dataset.direct, "0", "hiding cancels direct manipulation");
    assert.equal(overlay.root.inert, true);
    overlay.dispose(); settings.dispose();
  });

  it("connects the master switches and humanization options to existing settings", () => {
    const { overlay, settings } = createOverlay();
    const autoplay = find(overlay.root, '[data-setting="general.enabled"]');
    autoplay.checked = false;
    autoplay.dispatchEvent(event("change"));
    assert.equal(settings.all.general.enabled, false);
    assert.equal(find(overlay.root, '[data-part="start"]').disabled, true);
    const humanize = find(overlay.root, '[data-setting="humanization.enabled"]');
    humanize.checked = true;
    humanize.dispatchEvent(event("change"));
    assert.equal(settings.all.humanization.enabled, true);
    assert.equal(overlay.root.querySelectorAll<HTMLInputElement>('[data-setting="humanization.enabled"]')[1].checked, true);
    find(overlay.root, '[data-distribution="uniform"]').dispatchEvent(event("click"));
    assert.equal(settings.all.humanization.distribution, "uniform");
    const seed = find(overlay.root, '[data-setting="humanization.seed"]');
    seed.value = "9876"; seed.dispatchEvent(event("change"));
    assert.equal(settings.all.humanization.seed, 9876);
    overlay.dispose(); settings.dispose();
  });

  it("opens the requested settings tab and keeps the closed drawer inert", () => {
    const { overlay, settings } = createOverlay();
    const drawer = find(overlay.root, '[data-part="settings"]');
    assert.equal(drawer.inert, true);
    find(overlay.root, '[data-tab="humanize"]').dispatchEvent(event("click"));
    assert.equal(overlay.root.dataset.expanded, "1");
    assert.equal(drawer.inert, false);
    assert.equal(find(overlay.root, '[data-tab="humanize"]').getAttribute("aria-pressed"), "true");
    assert.equal(find(overlay.root, '[data-tab-panel="humanize"]').classList.contains("wom-hidden"), false);
    assert.equal(find(overlay.root, '[data-tab-panel="timing"]').classList.contains("wom-hidden"), true);
    find(overlay.root, '[data-part="more"]').dispatchEvent(event("click"));
    assert.equal(drawer.inert, true);
    assert.equal(overlay.root.dataset.expanded, "0");
    overlay.dispose(); settings.dispose();
  });

  it("interrupts tab resizes using unscaled heights and cancels them on close, hide, preference change and disposal", () => {
    const preference = Object.assign(new StubEventTarget(), { matches: false });
    env.window.matchMedia = () => preference;
    const { overlay, settings } = createOverlay();
    overlay.setVisible(true);
    settings.set("appearance.uiScale", 1.5);
    let cssFinished = 0;
    let cssCancelled = 0;
    (overlay.root as any).getAnimations = (options: { subtree: boolean }) => {
      assert.equal(options.subtree, true);
      return [
        { finish: () => { cssFinished++; } },
        { finish: () => { throw new Error("cannot finish"); }, cancel: () => { cssCancelled++; } },
      ];
    };
    const scroll = find(overlay.root, ".wom-drawer-scroll");
    const animations: any[] = [];
    const heights: Record<string, number> = { timing: 210, humanize: 310, input: 280, appearance: 240 };
    Object.defineProperty(scroll, "offsetHeight", {
      get: () => {
        const running = animations.at(-1);
        if (running && !running.cancelled) return running.currentHeight;
        const active = ["timing", "humanize", "input", "appearance"].find((tab) =>
          !find(overlay.root, `[data-tab-panel="${tab}"]`).classList.contains("wom-hidden"));
        return heights[active!];
      },
    });
    scroll.animate = (frames: Array<{ height: string }>, timing: { duration: number; easing: string }) => {
      const animation = {
        frames, timing, currentHeight: Number.parseFloat(frames[0].height), cancelled: false,
        onfinish: null, oncancel: null,
        cancel() { this.cancelled = true; },
      };
      animations.push(animation);
      return animation;
    };
    const tab = (id: string) => find(overlay.root, `[data-tab="${id}"]`).dispatchEvent(event("click"));
    tab("timing");
    assert.equal(animations.length, 0, "opening the drawer uses the drawer transition");
    tab("humanize");
    assert.deepEqual(animations[0].frames, [{ height: "210px" }, { height: "310px" }]);
    assert.deepEqual(animations[0].timing, { duration: MOTION.ms.tabResize, easing: MOTION.curve.smooth });
    animations[0].currentHeight = 250;
    tab("input");
    assert.equal(animations[0].cancelled, true);
    assert.deepEqual(animations[1].frames, [{ height: "250px" }, { height: "280px" }], "rapid changes start from the current layout height");
    find(overlay.root, '[data-part="more"]').dispatchEvent(event("click"));
    assert.equal(animations[1].cancelled, true);
    assert.equal(find(overlay.root, '[data-part="settings"]').inert, true);

    tab("timing"); tab("input");
    assert.equal(animations.length, 3);
    overlay.setVisible(false);
    assert.equal(animations[2].cancelled, true);
    assert.equal(overlay.root.inert, true);
    overlay.setVisible(true);
    tab("timing");
    assert.equal(animations.length, 4);
    preference.matches = true;
    preference.dispatchEvent(event("change"));
    assert.equal(animations[3].cancelled, true, "enabling reduced motion stops an in-flight resize");
    assert.equal(cssFinished, 1, "in-flight CSS transitions finish too");
    assert.equal(cssCancelled, 1, "an unfinishable animation is cancelled");
    tab("humanize");
    assert.equal(animations.length, 4, "reduced motion skips new resize animations");
    preference.matches = false;
    preference.dispatchEvent(event("change"));
    tab("timing");
    assert.equal(animations.length, 5);
    overlay.dispose();
    assert.equal(animations[4].cancelled, true);
    assert.equal(preference.listenerCount("change"), 0);
    settings.dispose();
  });

  it("routes action buttons correctly and changes start into pause / resume", () => {
    const { overlay, settings, calls } = createOverlay();
    const start = find(overlay.root, '[data-part="start"]');
    start.dispatchEvent(event("click"));
    overlay.setNotice("warn", "Hotkey collision", "hotkey-collision");
    overlay.setPhase("RUNNING");
    const notice = find(overlay.root, '[data-part="notice"]');
    assert.equal(notice.classList.contains("wom-hidden"), false, "warnings remain visible during play");
    find(overlay.root, '[data-part="reset-settings"]').dispatchEvent(event("click"));
    assert.equal(notice.textContent, "Hotkey collision", "a success message cannot hide a collision");
    overlay.clearNotice("hotkey-collision");
    assert.equal(notice.classList.contains("wom-hidden"), true);
    start.dispatchEvent(event("click"));
    overlay.setPhase("PAUSED");
    start.dispatchEvent(event("click"));
    find(overlay.root, '[data-part="stop"]').dispatchEvent(event("click"));
    find(overlay.root, '[data-part="emergency"]').dispatchEvent(event("click"));
    assert.deepEqual(calls.filter((x) => x !== "settings" && x !== "mapping"), ["start", "pause", "start", "stop", "emergency"]);
    overlay.dispose(); settings.dispose();
  });

  it("makes the panel hotkey fixed and ignores synthetic rebind input", () => {
    const { overlay, settings } = createOverlay();
    const fixed = find(overlay.root, '[data-action="toggleUI"]');
    assert.equal(fixed.disabled, true);
    const start = find(overlay.root, '[data-action="start"]');
    start.dispatchEvent(event("click"));
    assert.equal(overlay.isCapturing, true);
    env.document.dispatchEvent(event("keydown", { code: "KeyM", isTrusted: false, repeat: false }));
    assert.equal(settings.all.input.hotkeys.start, DEFAULT_SETTINGS.input.hotkeys.start);
    env.document.dispatchEvent(event("keydown", { code: "KeyM", isTrusted: true, repeat: false }));
    assert.equal(settings.all.input.hotkeys.start, "KeyM");
    assert.equal(overlay.isCapturing, false);
    overlay.dispose(); settings.dispose();
  });

  it("saves column bindings and restores site bindings on re-read", () => {
    const { overlay, settings, calls } = createOverlay();
    const mapping = { keyCount: 4, source: "site" as const, codes: ["KeyD", "KeyF", "KeyJ", "KeyK"] };
    overlay.setChart(chart, {
      taps: 8, holds: 2, chords: 4, largestChord: 2, jacks: 1,
      longestStream: 3, peakNps: 6, averageNps: 4, minJackInterval: 80,
    }, mapping);
    assert.match(find(overlay.root, '[data-part="analysis"]').textContent, /8 taps · 2 holds · 4 chord notes · 1 jacks · peak 6 NPS/);
    find(overlay.root, '[data-column="0"]').dispatchEvent(event("click"));
    env.document.dispatchEvent(event("keydown", { code: "KeyQ", isTrusted: true, repeat: false }));
    assert.deepEqual(settings.all.input.keyMappings["4"], ["KeyQ", "KeyF", "KeyJ", "KeyK"]);
    assert.equal(calls.filter((call) => call === "mapping").length, 1);
    find(overlay.root, '[data-part="reread"]').dispatchEvent(event("click"));
    assert.equal(settings.all.input.keyMappings["4"], undefined);
    assert.equal(calls.filter((call) => call === "mapping").length, 2);
    overlay.dispose(); settings.dispose();
  });

  it("uses distinct spring, exit and press curves with direct-drag and reduced-motion fallbacks", () => {
    const css = buildCss("#ff6b9d");
    for (const curve of Object.values(MOTION.curve)) assert.ok(css.includes(curve));
    assert.match(css, new RegExp(`transform ${MOTION.ms.panelEnter}ms var\\(--wom-ease-spring\\)`));
    assert.match(css, new RegExp(`transform ${MOTION.ms.panelExit}ms var\\(--wom-ease-exit\\)`));
    assert.match(css, new RegExp(`grid-template-rows ${MOTION.ms.drawerEnter}ms`));
    assert.match(css, /\.wom-range-wrap\[data-direct="1"\] \.wom-range-fill \{ transition: none; \}/);
    assert.match(css, /\.wom-range:focus-visible \+ \.wom-range-visual/);
    assert.match(css, /prefers-reduced-motion: reduce/);
    assert.match(css, /transition-duration: 0s !important/);
    assert.match(css, /transition-delay: 0s !important/);
  });

  it("prefers an available Torus font before the bundled rounded fallback", () => {
    const css = buildCss("#ff6b9d");
    assert.match(css, /font: 13px\/1\.35 "Torus", "Torus Regular", "Torus-Regular", "Keyfall Rounded"/);
    assert.match(css, /button, .* input \{ font-family: inherit/);
  });
});

describe("Right Shift hotkey", () => {
  it("is reserved, trusted-only, and works during rebind capture", () => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.input.hotkeys.toggleUI = "KeyM"; // even a bypassed sanitizer cannot steal it
    settings.input.hotkeys.start = "ShiftRight";
    const actions: HotkeyAction[] = [];
    const hotkeys = new HotkeyManager({ onAction: (action) => actions.push(action), getSiteCodes: () => [], isCapturing: () => true });
    hotkeys.apply(settings); hotkeys.install();
    for (const key of [
      event("keydown", { code: "ShiftRight", isTrusted: false, repeat: false }),
      event("keydown", { code: "ShiftRight", isTrusted: true, repeat: true }),
      event("keydown", { code: "ShiftLeft", isTrusted: true, repeat: false }),
      event("keydown", { code: "KeyM", isTrusted: true, repeat: false }),
      event("keydown", { code: "ShiftRight", isTrusted: true, repeat: false, ctrlKey: true }),
    ]) env.document.dispatchEvent(key);
    assert.deepEqual(actions, []);
    const right = event("keydown", { code: "ShiftRight", isTrusted: true, repeat: false });
    env.document.dispatchEvent(right);
    assert.deepEqual(actions, ["toggleUI"]);
    assert.equal(right.defaultPrevented, true);
    hotkeys.dispose();
    env.document.dispatchEvent(event("keydown", { code: "ShiftRight", isTrusted: true, repeat: false }));
    assert.equal(actions.length, 1);
  });

  it("does not trigger action hotkeys while typing, but still allows Right Shift", () => {
    const actions: HotkeyAction[] = [];
    const hotkeys = new HotkeyManager({ onAction: (action) => actions.push(action), getSiteCodes: () => [] });
    hotkeys.apply(DEFAULT_SETTINGS); hotkeys.install();
    const target = { tagName: "INPUT", isContentEditable: false };
    env.document.dispatchEvent(event("keydown", { code: "KeyG", isTrusted: true, repeat: false, target }));
    env.document.dispatchEvent(event("keydown", { code: "ShiftRight", isTrusted: true, repeat: false, target }));
    assert.deepEqual(actions, ["toggleUI"]);
    hotkeys.dispose();
  });
});
