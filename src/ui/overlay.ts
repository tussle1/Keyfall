import {
  DEFAULT_SETTINGS,
  LOOKAHEAD_MAX,
  LOOKAHEAD_MIN,
  MAX_KEY_COUNT,
  NAME,
  OFFSET_MAX,
  OFFSET_MIN,
  UI_TOGGLE_CODE,
  VERSION,
} from "../constants";
import type { ChartAnalysis } from "../chart/timeline";
import type { SettingsManager } from "../core/settings";
import type { HumanizationStats } from "../humanize/humanizer";
import type { EnginePhase, EngineStats, HotkeyAction, KeyMapping, ParsedChart, Settings } from "../types";
import { formatTime, groupDigits, humanizeCode, round } from "../util/helpers";
import { DebugPanel } from "./debug";
import { el, hexToRgba, listen, setDataset, setDisabled, setText } from "./dom";
import { KeyboardView } from "./keyboard";
import { MOTION } from "./motion";
import { ensureStyle, ROOT_CLASS } from "./styles";

/** The panel is a view over the existing engine; no playback logic lives here. */
export interface OverlayHost {
  onStart: () => void;
  onPause: () => void;
  onStop: () => void;
  onEmergency: () => void;
  onSettingChange: (settings: Settings) => void;
  onRebindMapping: () => void;
  getDiagnostics: () => Record<string, unknown>;
  getHumanizationStats?: () => HumanizationStats | null;
}

type SettingsTab = "timing" | "humanize" | "input" | "appearance";
type EditableHotkey = Exclude<HotkeyAction, "toggleUI">;
type CaptureTarget = { kind: "mapping"; index: number } | { kind: "hotkey"; action: EditableHotkey };

type SliderSpec = {
  label: string;
  path: string;
  min: number;
  max: number;
  step: number;
  initial: number;
  read: (settings: Settings) => number;
  unit?: string;
  title?: string;
  wide?: boolean;
};

const HOTKEY_LABELS: Record<HotkeyAction, string> = {
  toggleUI: "Show / hide panel",
  start: "Start",
  pause: "Pause / resume",
  stop: "Stop",
  emergency: "Emergency stop",
};

const TAB_INFO: Array<{ id: SettingsTab; label: string; first: string; second: string }> = [
  { id: "timing", label: "Timing", first: "Offset", second: "Scheduler" },
  { id: "humanize", label: "Humanize", first: "Variation", second: "Seed" },
  { id: "input", label: "Input", first: "Keybinds", second: "Hotkeys" },
  { id: "appearance", label: "Display", first: "Stats", second: "Appearance" },
];

const HUMANIZE_SLIDERS: Array<{
  key: "strength" | "shortTermDrift" | "longTermDrift" | "patternAware" | "holdReleaseVariation" | "fatigue";
  label: string;
}> = [
  { key: "strength", label: "Strength" },
  { key: "shortTermDrift", label: "Short drift" },
  { key: "longTermDrift", label: "Long drift" },
  { key: "patternAware", label: "Pattern aware" },
  { key: "holdReleaseVariation", label: "Hold release" },
  { key: "fatigue", label: "Fatigue" },
];

const TIMING_SLIDERS: SliderSpec[] = [
  {
    label: "Offset", path: "timing.offset", min: OFFSET_MIN, max: OFFSET_MAX, step: 1,
    initial: DEFAULT_SETTINGS.timing.offset, read: (s) => s.timing.offset, unit: "ms",
    title: "Negative fires earlier; positive fires later.",
  },
  {
    label: "Lookahead", path: "timing.lookahead", min: LOOKAHEAD_MIN, max: LOOKAHEAD_MAX, step: 5,
    initial: DEFAULT_SETTINGS.timing.lookahead, read: (s) => s.timing.lookahead, unit: "ms",
    title: "How far ahead to arm the scheduler.",
  },
  {
    label: "Delay", path: "timing.inputDelayCompensation", min: -100, max: 100, step: 1,
    initial: DEFAULT_SETTINGS.timing.inputDelayCompensation, read: (s) => s.timing.inputDelayCompensation, unit: "ms",
    title: "Positive compensation fires earlier to account for input latency.",
  },
  {
    label: "Spin", path: "timing.spinThreshold", min: 0, max: 25, step: 0.5,
    initial: DEFAULT_SETTINGS.timing.spinThreshold, read: (s) => s.timing.spinThreshold, unit: "ms",
    title: "Maximum final busy-wait, in milliseconds.",
  },
];

/**
 * A compact, trainer-style window. It is mounted once but starts inaccessible
 * and invisible on every page load. Visibility is controlled by the Right Shift
 * handler in main.ts, never by a persisted flag or a clickable launcher.
 */
export class Overlay {
  public readonly root: HTMLElement;

  private readonly host: OverlayHost;
  private readonly settingsManager: SettingsManager;
  private readonly disposers: Array<() => void> = [];
  private readonly bindings: Array<(settings: Settings) => void> = [];
  private mappingDisposers: Array<() => void> = [];
  private hotkeyDisposers: Array<() => void> = [];

  private panel!: HTMLElement;
  private header!: HTMLElement;
  private body!: HTMLElement;
  private heroTitle!: HTMLElement;
  private heroSubtitle!: HTMLElement;
  private heroBadge!: HTMLElement;
  private statusValue!: HTMLElement;
  private noticeEl!: HTMLElement;
  private noticeId = "";
  private startBtn!: HTMLButtonElement;
  private startLabel!: HTMLElement;
  private startHint!: HTMLElement;
  private stopHint!: HTMLElement;
  private emergencyBtn!: HTMLButtonElement;
  private moreBtn!: HTMLButtonElement;
  private moreText!: HTMLElement;
  private drawer!: HTMLElement;
  private drawerScroll!: HTMLElement;
  private mappingGrid!: HTMLElement;
  private mappingHelp!: HTMLElement;
  private analysisEl!: HTMLElement;
  private hotkeyList!: HTMLElement;
  private humanizeSeed: HTMLInputElement | null = null;
  private humanizeDistButtons: HTMLButtonElement[] = [];
  private humanizeStatsEl: HTMLElement | null = null;

  private readonly metrics: Record<string, HTMLElement> = {};
  private readonly quickMetrics: Record<string, HTMLElement> = {};
  private readonly keyboard = new KeyboardView();
  private readonly debug = new DebugPanel();
  private readonly tabButtons = new Map<SettingsTab, HTMLButtonElement>();
  private readonly tabPanels = new Map<SettingsTab, HTMLElement>();
  private activeTab: SettingsTab = "timing";
  private expanded = false;
  private visible = false;
  private phase: EnginePhase = "IDLE";
  private pendingStart = false;
  private chart: ParsedChart | null = null;
  private mapping: KeyMapping | null = null;
  private mappingSignature = "";
  private hotkeySignature = "";
  private listeningFor: CaptureTarget | null = null;
  private listeningCell: HTMLElement | null = null;
  private listenOriginalText = "";
  private listenDisposer: (() => void) | null = null;
  private dragState: { pointerId: number; offsetX: number; offsetY: number } | null = null;
  private resizeState: { pointerId: number; startX: number; startY: number; startW: number; startH: number } | null = null;
  private rangePointer: { pointerId: number; x: number; y: number; wrap: HTMLElement; direct: boolean } | null = null;
  private tabResize: Animation | null = null;
  private motionPreference: MediaQueryList | null = null;
  private appearanceSignature = "";
  private sliderSequence = 0;

  constructor(host: OverlayHost, settingsManager: SettingsManager) {
    this.host = host;
    this.settingsManager = settingsManager;
    ensureStyle(document, settingsManager.all.appearance.accent);
    this.root = el("div", {
      className: ROOT_CLASS,
      dataset: { part: "root", tool: NAME, open: "0", expanded: "0" },
      attrs: { role: "region", "aria-label": "Keyfall autoplay controls", "aria-hidden": "true" },
    });
    this.build();
    this.watchMotionPreference();
    this.setVisible(false);
    this.disposers.push(settingsManager.onChange(({ settings }) => this.syncFromSettings(settings)));
    this.syncFromSettings(settingsManager.all);
  }

  private build(): void {
    this.panel = el("div", { className: "wom-panel", dataset: { part: "panel" } });
    this.header = el("div", { className: "wom-header", dataset: { part: "header" } }, [
      el("span", { className: "wom-logo", text: "kf", attrs: { "aria-hidden": "true" } }),
      el("span", { className: "wom-title", text: `${NAME} v${VERSION}` }),
      // The reference is a desktop window. These are decorative window chrome:
      // Right Shift, not a mouse launcher or mini-bar, controls visibility.
      el("span", { className: "wom-window-controls", attrs: { "aria-hidden": "true", title: "Press Right Shift to hide" } }, [
        el("span", { text: "−" }), el("span", { text: "×" }),
      ]),
    ]);

    this.heroTitle = el("div", { className: "wom-hero-title", text: "Waiting for gameplay…" });
    this.heroSubtitle = el("div", { className: "wom-hero-subtitle", text: "Open a chart to get started" });
    this.heroBadge = el("span", { className: "wom-hero-badge", text: "— K" });
    this.statusValue = el("span", { className: "wom-hero-status", text: "DETECTING", dataset: { phase: "IDLE", part: "status" } });
    const hero = el("div", { className: "wom-hero", dataset: { part: "hero" } }, [
      this.statusValue,
      el("div", { className: "wom-hero-copy" }, [this.heroTitle, this.heroSubtitle]),
      this.heroBadge,
    ]);
    const heroWrap = el("div", { className: "wom-hero-wrap" }, [hero]);
    this.noticeEl = el("div", {
      className: "wom-notice wom-hidden", dataset: { kind: "warn", part: "notice" },
      attrs: { role: "status", "aria-live": "polite" },
    });

    const quickSliders = el("div", { className: "wom-quick-sliders", dataset: { part: "quick-sliders" } },
      TIMING_SLIDERS.map((spec) => this.sliderRow(spec)));

    const quickReadouts = el("div", { className: "wom-quick-readouts" });
    for (const [key, label] of [["notes", "Notes left"], ["accuracy", "Accuracy"], ["score", "Score"]]) {
      const value = el("span", { className: "wom-quick-value", text: "—", dataset: { metric: key } });
      this.quickMetrics[key] = value;
      quickReadouts.appendChild(el("div", { className: "wom-quick-readout" }, [
        el("span", { className: "wom-quick-label", text: label }), value,
      ]));
    }
    const quickSwitches = el("div", { className: "wom-quick-switches" }, [
      this.switchRow("Autoplay", "general.enabled", (s) => s.general.enabled),
      this.switchRow("Humanize", "humanization.enabled", (s) => s.humanization.enabled),
      this.switchRow("Show keys", "general.showKeyboard", (s) => s.general.showKeyboard),
    ]);
    const quickGrid = el("div", { className: "wom-quick-grid" }, [quickReadouts, quickSwitches]);

    const presets = el("div", { className: "wom-presets", dataset: { part: "tabs" } });
    for (const info of TAB_INFO) {
      const button = el("button", {
        className: "wom-preset-button", type: "button", text: info.label,
        dataset: { tab: info.id },
        attrs: { "aria-pressed": "false", "aria-controls": `keyfall-tab-${info.id}` },
      });
      this.tabButtons.set(info.id, button);
      this.disposers.push(listen(button, "click", () => this.setTab(info.id)));
      presets.appendChild(el("div", { className: "wom-preset" }, [
        button,
        el("span", { className: "wom-preset-caption", text: info.first }),
        el("span", { className: "wom-preset-caption", text: info.second }),
      ]));
    }

    this.moreText = el("span", { text: " More!" });
    this.moreBtn = el("button", {
      className: "wom-more-button", type: "button",
      dataset: { part: "more" }, attrs: { "aria-expanded": "false", "aria-controls": "keyfall-settings" },
    }, [el("span", { className: "wom-disclosure-icon", text: "▸", attrs: { "aria-hidden": "true" } }), this.moreText]);
    this.emergencyBtn = el("button", {
      className: "wom-emergency", type: "button", text: "Z · emergency",
      attrs: { title: "Emergency stop — immediately release every key" },
      dataset: { part: "emergency" },
    });
    const moreBar = el("div", { className: "wom-more-bar" }, [this.moreBtn, this.emergencyBtn]);

    this.drawerScroll = el("div", { className: "wom-drawer-scroll" });
    for (const info of TAB_INFO) {
      const tabPanel = el("div", {
        className: "wom-tab-panel", id: `keyfall-tab-${info.id}`,
        dataset: { tabPanel: info.id },
      });
      this.tabPanels.set(info.id, tabPanel);
      this.buildTabContent(info.id, tabPanel);
      this.drawerScroll.appendChild(tabPanel);
    }
    this.drawer = el("div", {
      className: "wom-drawer", id: "keyfall-settings", dataset: { part: "settings" },
      attrs: { "aria-hidden": "true" },
    }, [el("div", { className: "wom-drawer-inner" }, [this.drawerScroll])]);

    this.body = el("div", { className: "wom-body", dataset: { part: "body" } }, [
      heroWrap, this.noticeEl, quickSliders, quickGrid, presets, moreBar, this.drawer,
    ]);

    this.stopHint = el("span", { className: "wom-action-hint", text: "X · release keys" });
    const stopBtn = el("button", {
      className: "wom-action wom-action-stop", type: "button", dataset: { part: "stop" },
      attrs: { title: "Stop playback and release all keys" },
    }, [el("span", { className: "wom-action-label", text: "Stop" }), this.stopHint]);
    this.startLabel = el("span", { className: "wom-action-label", text: "Start autoplay" });
    this.startHint = el("span", { className: "wom-action-hint", text: "G · start" });
    this.startBtn = el("button", {
      className: "wom-action wom-action-start", type: "button", dataset: { part: "start" },
    }, [this.startLabel, this.startHint]);
    const footer = el("div", { className: "wom-footer" }, [stopBtn, this.startBtn]);
    const resize = el("div", {
      className: "wom-resize", dataset: { part: "resize" }, attrs: { title: "Resize window" },
    });
    this.panel.append(this.header, this.body, footer, resize);
    this.root.appendChild(this.panel);
    this.disposers.push(
      listen(stopBtn, "click", () => this.host.onStop()),
      listen(this.startBtn, "click", () => {
        if (this.phase === "RUNNING") this.host.onPause();
        else if (this.pendingStart) this.host.onStop();
        else this.host.onStart();
      }),
      listen(this.emergencyBtn, "click", () => this.host.onEmergency()),
      listen(this.moreBtn, "click", () => this.setExpanded(!this.expanded)),
    );
    this.wireDrag(resize);
    this.setExpanded(false);
  }

  private buildTabContent(tab: SettingsTab, panel: HTMLElement): void {
    if (tab === "timing") {
      panel.append(
        el("div", { className: "wom-section-title", text: "Timing & scheduler" }),
        el("p", { className: "wom-help", text: "Fine-tune the same controls above. Offset changes take effect while playing." }),
        ...TIMING_SLIDERS.map((spec) => this.sliderRow({ ...spec, wide: true })),
        this.switchRow("Auto-start detected charts", "general.autoStart", (s) => s.general.autoStart),
        el("p", { className: "wom-help", text: "When enabled, autoplay starts on each new playable chart. You can also press Start before a chart loads." }),
        el("p", { className: "wom-help", text: "Negative offset plays earlier. Higher spin windows can improve precision but cost more CPU." }),
      );
      return;
    }
    if (tab === "humanize") {
      panel.append(
        el("div", { className: "wom-section-title", text: "Timing variation" }),
        this.switchRow("Enable humanization", "humanization.enabled", (s) => s.humanization.enabled),
        ...HUMANIZE_SLIDERS.map(({ key, label }) => this.sliderRow({
          label, path: `humanization.${key}`, min: 0, max: 1, step: 0.05,
          initial: DEFAULT_SETTINGS.humanization[key], read: (s) => s.humanization[key], wide: true,
        })),
      );
      const seed = el("input", {
        className: "wom-text", type: "text", value: String(this.settingsManager.all.humanization.seed),
        attrs: { "aria-label": "Humanization seed", inputmode: "numeric", title: "The same seed and chart reproduce the same variation" },
        dataset: { setting: "humanization.seed" },
      });
      this.humanizeSeed = seed;
      const commitSeed = (): void => {
        const parsed = Number(seed.value);
        const next = Number.isFinite(parsed) ? Math.abs(Math.trunc(parsed)) >>> 0 : 0;
        seed.value = String(next);
        this.settingsManager.set("humanization.seed", next);
      };
      const randomize = el("button", { className: "wom-small-button", type: "button", text: "Randomize" });
      this.disposers.push(
        listen(seed, "change", commitSeed),
        listen(randomize, "click", () => { seed.value = String((Math.random() * 4294967295) >>> 0); commitSeed(); }),
      );
      const gaussian = el("button", { className: "wom-small-button", type: "button", text: "Gaussian", dataset: { distribution: "gaussian" } });
      const uniform = el("button", { className: "wom-small-button", type: "button", text: "Uniform", dataset: { distribution: "uniform" } });
      this.humanizeDistButtons = [gaussian, uniform];
      this.disposers.push(
        listen(gaussian, "click", () => this.settingsManager.set("humanization.distribution", "gaussian")),
        listen(uniform, "click", () => this.settingsManager.set("humanization.distribution", "uniform")),
      );
      this.humanizeStatsEl = el("p", { className: "wom-help", dataset: { part: "humanize-stats" } });
      panel.append(
        el("div", { className: "wom-form-row" }, [el("span", { className: "wom-form-label", text: "Seed" }), seed, randomize]),
        el("div", { className: "wom-form-row" }, [el("span", { className: "wom-form-label", text: "Distribution" }), gaussian, uniform]),
        this.humanizeStatsEl,
        el("p", { className: "wom-help", text: "For timing practice, not detection evasion. Keyfall's keyboard events are always synthetic." }),
      );
      return;
    }
    if (tab === "input") {
      this.hotkeyList = el("div", { className: "wom-hotkeys" });
      this.mappingGrid = el("div", { className: "wom-map-grid" });
      this.mappingHelp = el("p", { className: "wom-help", text: "Start a chart to edit its column bindings." });
      const resetHotkeys = el("button", { className: "wom-small-button", type: "button", text: "Reset action hotkeys" });
      const reread = el("button", { className: "wom-small-button", type: "button", text: "Re-read from site", dataset: { part: "reread" } });
      this.disposers.push(
        listen(resetHotkeys, "click", () => {
          this.settingsManager.set("input.hotkeys", { ...DEFAULT_SETTINGS.input.hotkeys });
          this.setConfirmation("Action hotkeys reset. Right Shift always opens and closes the panel.");
        }),
        listen(reread, "click", () => {
          const keyCount = this.mapping?.keyCount;
          if (keyCount) {
            const overrides = { ...this.settingsManager.all.input.keyMappings };
            delete overrides[String(keyCount)];
            this.settingsManager.set("input.keyMappings", overrides);
          }
          this.host.onRebindMapping();
          this.setConfirmation("Key mapping re-read from the site.");
        }),
      );
      panel.append(
        el("div", { className: "wom-section-title", text: "Hotkeys" }),
        el("p", { className: "wom-help", text: "Click an action key and press a replacement. Escape cancels. Right Shift is reserved for this window." }),
        this.hotkeyList, resetHotkeys,
        el("div", { className: "wom-section-title wom-section-gap", text: "Column mapping" }),
        this.mappingHelp, this.mappingGrid, reread,
        this.switchRow("Use secondary keybinds", "input.useSecondaryKeybind", (s) => s.input.useSecondaryKeybind),
      );
      return;
    }

    const metricsGrid = el("div", { className: "wom-metrics" });
    for (const [key, label] of [
      ["notes", "Notes left"], ["accuracy", "Accuracy"], ["combo", "Combo"], ["score", "Score"],
      ["actions", "Actions"], ["jitter", "Jitter"], ["time", "Time"], ["keys", "Keys"],
    ]) {
      const value = el("div", { className: "wom-metric-v", text: "—", dataset: { metric: key } });
      this.metrics[key] = value;
      metricsGrid.appendChild(el("div", { className: "wom-metric" }, [
        el("div", { className: "wom-metric-k", text: label }), value,
      ]));
    }
    this.analysisEl = el("p", { className: "wom-help", text: "Pattern analysis appears when a chart is detected.", dataset: { part: "analysis" } });
    const scale = this.sliderRow({
      label: "UI scale", path: "appearance.uiScale", min: 0.6, max: 2, step: 0.05,
      initial: DEFAULT_SETTINGS.appearance.uiScale, read: (s) => s.appearance.uiScale, unit: "×", wide: true,
    });
    const opacity = this.sliderRow({
      label: "Opacity", path: "appearance.opacity", min: 0.15, max: 1, step: 0.01,
      initial: DEFAULT_SETTINGS.appearance.opacity, read: (s) => s.appearance.opacity, wide: true,
    });
    const color = el("input", {
      type: "color", className: "wom-color", value: this.colorValue(this.settingsManager.all.appearance.accent),
      dataset: { setting: "appearance.accent" }, attrs: { "aria-label": "Accent color" },
    });
    this.disposers.push(listen(color, "input", () => this.settingsManager.set("appearance.accent", color.value)));
    this.bindings.push((s) => {
      const value = this.colorValue(s.appearance.accent);
      if (color.value !== value) color.value = value;
    });
    const resetPosition = el("button", { className: "wom-small-button", type: "button", text: "Reset position & size" });
    const resetSettings = el("button", {
      className: "wom-small-button wom-reset-settings", type: "button", text: "Reset all settings", dataset: { part: "reset-settings" },
    });
    this.disposers.push(
      listen(resetPosition, "click", () => {
        this.settingsManager.set("appearance.position", { ...DEFAULT_SETTINGS.appearance.position });
        this.settingsManager.set("appearance.size", { ...DEFAULT_SETTINGS.appearance.size });
      }),
      listen(resetSettings, "click", () => {
        this.settingsManager.reset();
        this.host.onRebindMapping();
        this.setConfirmation("Keyfall settings reset to defaults.");
      }),
    );
    panel.append(
      el("div", { className: "wom-section-title", text: "Live statistics" }), metricsGrid,
      this.analysisEl, this.keyboard.root,
      el("div", { className: "wom-section-title wom-section-gap", text: "Appearance" }),
      scale, opacity,
      el("div", { className: "wom-form-row" }, [el("span", { className: "wom-form-label", text: "Accent" }), color, resetPosition]),
      this.switchRow("Show keyboard", "general.showKeyboard", (s) => s.general.showKeyboard),
      this.switchRow("Debug mode", "general.debug", (s) => s.general.debug),
      resetSettings, this.debug.root,
    );
  }

  private sliderRow(spec: SliderSpec): HTMLElement {
    const id = `keyfall-slider-${this.sliderSequence++}`;
    const label = el("label", { className: "wom-slider-label", text: spec.label, attrs: { for: id } });
    const value = el("span", { className: "wom-slider-value" });
    const input = el("input", {
      id, className: "wom-range", type: "range", min: String(spec.min), max: String(spec.max), step: String(spec.step),
      dataset: { setting: spec.path },
      attrs: { "aria-label": `${spec.label}${spec.unit ? ` (${spec.unit})` : ""}`, title: spec.title ?? spec.label },
    });
    const wrap = el("span", { className: "wom-range-wrap" }, [
      input,
      el("span", { className: "wom-range-visual", attrs: { "aria-hidden": "true" } }, [
        el("span", { className: "wom-range-fill" }), el("span", { className: "wom-range-thumb" }),
      ]),
    ]);
    const reset = el("button", {
      className: "wom-slider-reset", type: "button", text: "↺",
      attrs: { title: `Reset ${spec.label}`, "aria-label": `Reset ${spec.label}` },
    });
    this.disposers.push(
      listen(input, "pointerdown", (event) => this.beginRangePointer(event as PointerEvent, wrap)),
      listen(input, "input", () => this.settingsManager.set(spec.path, Number(input.value))),
      listen(reset, "click", () => this.settingsManager.set(spec.path, spec.initial)),
    );
    this.bindings.push((settings) => {
      const current = spec.read(settings);
      if (input.value !== String(current)) input.value = String(current);
      setText(value, `${round(current, 2)}${spec.unit ?? ""}`);
      const percent = Math.max(0, Math.min(100, ((current - spec.min) / (spec.max - spec.min)) * 100));
      const progress = `${percent}%`;
      if (wrap.style.getPropertyValue("--wom-progress") !== progress) wrap.style.setProperty("--wom-progress", progress);
    });
    return el("div", { className: `wom-slider-row${spec.wide ? " wom-slider-wide" : ""}` }, [label, value, wrap, reset]);
  }

  private beginRangePointer(event: PointerEvent, wrap: HTMLElement): void {
    if (event.button !== 0 || event.isPrimary === false) return;
    this.endRangePointer();
    this.rangePointer = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, wrap, direct: false };
  }

  private moveRangePointer(event: PointerEvent): void {
    const range = this.rangePointer;
    if (!range || range.pointerId !== event.pointerId || range.direct) return;
    // A click on the track settles; actual pointer movement follows directly.
    if (Math.hypot(event.clientX - range.x, event.clientY - range.y) > 2) {
      range.direct = true;
      setDataset(range.wrap, "direct", "1");
    }
  }

  private endRangePointer(event?: PointerEvent): void {
    const range = this.rangePointer;
    if (!range || (event && range.pointerId !== event.pointerId)) return;
    if (range.direct) setDataset(range.wrap, "direct", "0");
    this.rangePointer = null;
  }

  private switchRow(label: string, path: string, read: (settings: Settings) => boolean): HTMLElement {
    const input = el("input", { type: "checkbox", className: "wom-switch-input", dataset: { setting: path }, attrs: { "aria-label": label } });
    const track = el("span", { className: "wom-switch-track", attrs: { "aria-hidden": "true" } }, [el("span", { className: "wom-switch-knob" })]);
    const row = el("label", { className: "wom-switch" }, [el("span", { className: "wom-switch-label", text: label }), input, track]);
    this.disposers.push(listen(input, "change", () => this.settingsManager.set(path, input.checked)));
    this.bindings.push((settings) => { if (input.checked !== read(settings)) input.checked = read(settings); });
    return row;
  }

  private colorValue(color: string): string {
    const value = color.replace("#", "");
    if (/^[0-9a-f]{3}$/i.test(value)) return `#${value.split("").map((c) => c + c).join("")}`.toLowerCase();
    if (/^[0-9a-f]{6,8}$/i.test(value)) return `#${value.slice(0, 6)}`.toLowerCase();
    return "#ff6b9d";
  }

  private watchMotionPreference(): void {
    if (typeof window.matchMedia !== "function") return;
    this.motionPreference = window.matchMedia("(prefers-reduced-motion: reduce)");
    const preference = this.motionPreference;
    const onChange = (): void => {
      if (!preference.matches) return;
      this.cancelTabResize();
      // CSS transition durations do not change retroactively. Finish any
      // in-flight panel/control motion when the OS preference changes too.
      if (typeof this.root.getAnimations === "function") {
        for (const animation of this.root.getAnimations({ subtree: true })) {
          try { animation.finish(); } catch { animation.cancel(); }
        }
      }
    };
    if (typeof preference.addEventListener === "function") {
      this.disposers.push(listen(preference, "change", onChange));
    } else if (typeof preference.addListener === "function") {
      preference.addListener(onChange);
      this.disposers.push(() => preference.removeListener(onChange));
    }
  }

  private cancelTabResize(): void {
    const animation = this.tabResize;
    this.tabResize = null;
    if (animation) {
      animation.onfinish = null;
      animation.oncancel = null;
      animation.cancel();
    }
  }

  private setTab(tab: SettingsTab): void {
    if (this.activeTab === tab && this.expanded) {
      this.drawerScroll.scrollTop = 0;
      return;
    }
    const animateResize = this.visible && this.expanded && !this.motionPreference?.matches
      && typeof this.drawerScroll.animate === "function";
    // offsetHeight is in layout pixels, unlike getBoundingClientRect, which is
    // scaled by the user's UI scale and by the panel's entrance transform.
    const fromHeight = animateResize ? this.drawerScroll.offsetHeight : 0;
    this.cancelTabResize();
    this.activeTab = tab;
    this.setExpanded(true);
    this.drawerScroll.scrollTop = 0;
    const toHeight = animateResize ? this.drawerScroll.offsetHeight : 0;
    if (fromHeight > 0 && toHeight > 0 && Math.abs(fromHeight - toHeight) > 1) {
      const animation = this.drawerScroll.animate(
        [{ height: `${fromHeight}px` }, { height: `${toHeight}px` }],
        { duration: MOTION.ms.tabResize, easing: MOTION.curve.smooth },
      );
      this.tabResize = animation;
      animation.onfinish = () => { if (this.tabResize === animation) this.tabResize = null; };
      animation.oncancel = () => { if (this.tabResize === animation) this.tabResize = null; };
    }
  }

  private setExpanded(expanded: boolean): void {
    this.expanded = expanded;
    setDataset(this.root, "expanded", expanded ? "1" : "0");
    this.moreBtn.setAttribute("aria-expanded", String(expanded));
    setText(this.moreText, expanded ? " Less!" : " More!");
    this.drawer.setAttribute("aria-hidden", String(!expanded));
    this.drawer.inert = !expanded;
    for (const [tab, button] of this.tabButtons) button.setAttribute("aria-pressed", String(expanded && tab === this.activeTab));
    for (const [tab, panel] of this.tabPanels) panel.classList.toggle("wom-hidden", tab !== this.activeTab);
    if (!expanded) {
      this.cancelTabResize();
      this.endRangePointer();
      this.cancelListen();
    }
  }

  private renderMappingGrid(force = false): void {
    if (!this.mappingGrid) return;
    const mapping = this.mapping;
    const signature = JSON.stringify(mapping ? [mapping.keyCount, mapping.source, mapping.codes] : null);
    if (!force && signature === this.mappingSignature) return;
    this.mappingSignature = signature;
    for (const dispose of this.mappingDisposers.splice(0)) dispose();
    this.mappingGrid.replaceChildren();
    if (!mapping) {
      setText(this.mappingHelp, "Start a chart to edit its column bindings.");
      return;
    }
    setText(this.mappingHelp, `${mapping.keyCount}K · ${mapping.source} mapping. These keys must also be accepted by the game. Editing stops an active run.`);
    for (let index = 0; index < mapping.keyCount; index++) {
      const code = mapping.codes[index] ?? "?";
      const cell = el("button", {
        className: "wom-map-cell", type: "button", dataset: { column: String(index), source: mapping.source, listening: "0" },
        attrs: { title: `Column ${index + 1} → ${code}; click to rebind`, "aria-label": `Column ${index + 1}: ${humanizeCode(code)}` },
      }, [el("span", { className: "wom-map-index", text: String(index + 1) }), el("span", { text: humanizeCode(code) })]);
      this.mappingDisposers.push(listen(cell, "click", () => this.beginListen({ kind: "mapping", index }, cell)));
      this.mappingGrid.appendChild(cell);
    }
  }

  private renderHotkeyList(force = false): void {
    if (!this.hotkeyList) return;
    const hotkeys = this.settingsManager.all.input.hotkeys;
    const signature = JSON.stringify(hotkeys);
    if (!force && signature === this.hotkeySignature) return;
    this.hotkeySignature = signature;
    for (const dispose of this.hotkeyDisposers.splice(0)) dispose();
    this.hotkeyList.replaceChildren();
    for (const action of Object.keys(HOTKEY_LABELS) as HotkeyAction[]) {
      const fixed = action === "toggleUI";
      const key = el("button", {
        className: "wom-hotkey-key", text: fixed ? "Right Shift · fixed" : humanizeCode(hotkeys[action]),
        type: "button", disabled: fixed, dataset: { action, listening: "0" },
        attrs: { title: fixed ? "Right Shift is reserved for the panel" : `${HOTKEY_LABELS[action]} — click to rebind` },
      });
      if (!fixed) this.hotkeyDisposers.push(listen(key, "click", () => this.beginListen({ kind: "hotkey", action }, key)));
      this.hotkeyList.appendChild(el("div", { className: "wom-hotkey" }, [
        el("span", { className: "wom-hotkey-name", text: HOTKEY_LABELS[action] }), key,
      ]));
    }
  }

  private beginListen(target: CaptureTarget, cell: HTMLElement): void {
    this.cancelListen();
    this.listeningFor = target;
    this.listeningCell = cell;
    this.listenOriginalText = cell.textContent ?? "";
    cell.dataset.listening = "1";
    setText(cell, "press a key…");
    const onKey = (event: KeyboardEvent): void => {
      // Autoplay-generated events can never become a binding.
      if (!event.isTrusted || event.repeat) return;
      if (event.code === UI_TOGGLE_CODE) { this.cancelListen(); return; }
      event.preventDefault();
      if (typeof event.stopImmediatePropagation === "function") event.stopImmediatePropagation();
      else event.stopPropagation();
      if (event.code === "Escape") { this.cancelListen(); return; }
      if (!event.code) return;
      if (target.kind === "mapping") {
        const keyCount = this.mapping?.keyCount ?? 0;
        if (!keyCount || !this.mapping) { this.cancelListen(); return; }
        const next = this.mapping.codes.slice();
        next[target.index] = event.code;
        this.settingsManager.set(`input.keyMappings.${keyCount}`, next);
        this.host.onRebindMapping();
      } else {
        const taken = (Object.entries(this.settingsManager.all.input.hotkeys) as Array<[HotkeyAction, string]>)
          .find(([other, code]) => code === event.code && other !== target.action);
        if (taken) {
          this.setNotice("warn", `${humanizeCode(event.code)} is already bound to ${HOTKEY_LABELS[taken[0]]}. Press another key or Esc.`);
          return;
        }
        this.settingsManager.set(`input.hotkeys.${target.action}`, event.code);
      }
      this.cancelListen();
    };
    // Ashtonk handles and stops lane keys on window capture, before document.
    this.listenDisposer = listen(window, "keydown", onKey as EventListener, { capture: true });
  }

  private cancelListen(): void {
    const target = this.listeningFor;
    this.listenDisposer?.();
    this.listenDisposer = null;
    if (this.listeningCell) {
      this.listeningCell.dataset.listening = "0";
      setText(this.listeningCell, this.listenOriginalText);
    }
    this.listeningCell = null;
    this.listeningFor = null;
    if (target?.kind === "mapping") this.renderMappingGrid(true);
    else if (target?.kind === "hotkey") this.renderHotkeyList(true);
  }

  get isCapturing(): boolean { return this.listeningFor !== null; }
  get isVisible(): boolean { return this.visible; }

  /** Called only by the trusted Right Shift hotkey; no visibility is persisted. */
  setVisible(visible: boolean): void {
    this.visible = visible;
    if (!visible) {
      this.cancelTabResize();
      this.endRangePointer();
      this.cancelListen();
      const focused = document.activeElement as HTMLElement | null;
      if (focused && typeof this.root.contains === "function" && this.root.contains(focused)) focused.blur();
    }
    setDataset(this.root, "open", visible ? "1" : "0");
    this.root.setAttribute("aria-hidden", String(!visible));
    this.root.inert = !visible;
  }

  private wireDrag(resize: HTMLElement): void {
    this.disposers.push(
      listen(this.header, "pointerdown", (event) => {
        const e = event as PointerEvent;
        const target = e.target as HTMLElement;
        if (target.closest("button, input, label, select")) return;
        const rect = this.root.getBoundingClientRect();
        this.dragState = { pointerId: e.pointerId, offsetX: e.clientX - rect.left, offsetY: e.clientY - rect.top };
        e.preventDefault();
      }),
      listen(resize, "pointerdown", (event) => {
        const e = event as PointerEvent;
        const rect = this.root.getBoundingClientRect();
        this.resizeState = { pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, startW: rect.width, startH: rect.height };
        e.preventDefault(); e.stopPropagation();
      }),
      listen(window, "pointermove", (event) => {
        this.moveRangePointer(event as PointerEvent);
        this.onPointerMove(event as PointerEvent);
      }),
      listen(window, "pointerup", (event) => {
        this.endRangePointer(event as PointerEvent);
        this.onPointerUp(event as PointerEvent);
      }),
      listen(window, "pointercancel", (event) => {
        this.endRangePointer(event as PointerEvent);
        this.onPointerUp(event as PointerEvent);
      }),
      listen(window, "blur", () => this.endRangePointer()),
      listen(window, "resize", () => { this.appearanceSignature = ""; this.applyAppearance(this.settingsManager.all); }),
    );
  }

  private onPointerMove(event: PointerEvent): void {
    if (this.dragState?.pointerId === event.pointerId) {
      this.setPosition(event.clientX - this.dragState.offsetX, event.clientY - this.dragState.offsetY);
      return;
    }
    if (this.resizeState?.pointerId === event.pointerId) {
      const scale = this.settingsManager.all.appearance.uiScale || 1;
      const w = Math.max(220, Math.min(640, (this.resizeState.startW + event.clientX - this.resizeState.startX) / scale));
      const h = Math.max(180, (this.resizeState.startH + event.clientY - this.resizeState.startY) / scale);
      this.settingsManager.set("appearance.size", { w: Math.round(w), h: Math.round(h) });
    }
  }

  private onPointerUp(event: PointerEvent): void {
    if (this.dragState?.pointerId === event.pointerId) {
      this.dragState = null;
      this.settingsManager.set("appearance.position", {
        x: Math.round(parseFloat(this.root.style.left) || 0), y: Math.round(parseFloat(this.root.style.top) || 0),
      });
    }
    if (this.resizeState?.pointerId === event.pointerId) this.resizeState = null;
  }

  private setPosition(x: number, y: number): void {
    const rect = this.root.getBoundingClientRect();
    const visibleWidth = Math.min(rect.width, 80);
    this.root.style.left = `${Math.max(-rect.width + visibleWidth, Math.min(window.innerWidth - visibleWidth, x))}px`;
    this.root.style.top = `${Math.max(0, Math.min(window.innerHeight - 35, y))}px`;
  }

  private applyAppearance(settings: Settings): void {
    const { uiScale, opacity, accent, position, size } = settings.appearance;
    const signature = JSON.stringify([uiScale, opacity, accent, position.x, position.y, size.w, size.h, window.innerWidth, window.innerHeight]);
    if (signature === this.appearanceSignature) return;
    this.appearanceSignature = signature;
    const width = Math.min(size.w || 427, Math.max(100, (window.innerWidth - 16) / uiScale));
    this.root.style.width = `${width}px`;
    this.root.style.transform = `scale(${uiScale})`;
    this.root.style.transformOrigin = "top left";
    this.root.style.opacity = String(opacity);
    this.root.style.setProperty("--wom-accent", accent);
    this.root.style.setProperty("--wom-accent-soft", hexToRgba(accent, 0.35));
    this.panel.style.maxHeight = `${Math.max(180, (window.innerHeight - 16) / uiScale)}px`;
    this.panel.style.height = size.h > 120 ? `${size.h}px` : "auto";
    this.setPosition(position.x, position.y);
  }

  private syncFromSettings(settings: Settings): void {
    this.applyAppearance(settings);
    for (const update of this.bindings) update(settings);
    this.keyboard.setVisible(settings.general.showKeyboard);
    this.debug.setEnabled(settings.general.debug);
    this.renderHotkeyList();
    this.renderMappingGrid();
    this.syncHumanizeDistribution(settings.humanization.distribution);
    if (this.humanizeSeed && this.humanizeSeed.value !== String(settings.humanization.seed)) {
      this.humanizeSeed.value = String(settings.humanization.seed);
    }
    setText(this.emergencyBtn, `${humanizeCode(settings.input.hotkeys.emergency)} · emergency`);
    setText(this.stopHint, `${humanizeCode(settings.input.hotkeys.stop)} · release keys`);
    this.updateButtonStates();
    this.host.onSettingChange(settings);
    this.refreshHumanization();
  }

  private syncHumanizeDistribution(active: "gaussian" | "uniform"): void {
    const [gaussian, uniform] = this.humanizeDistButtons;
    gaussian?.setAttribute("aria-pressed", String(active === "gaussian"));
    uniform?.setAttribute("aria-pressed", String(active === "uniform"));
  }

  refreshHumanization(): void {
    const stats = this.host.getHumanizationStats?.() ?? null;
    if (!this.humanizeStatsEl) return;
    if (!stats) { setText(this.humanizeStatsEl, "Humanization off — timing is frame-exact."); return; }
    setText(this.humanizeStatsEl,
      `${stats.notes} notes · mean ${stats.meanMs >= 0 ? "+" : ""}${round(stats.meanMs, 2)}ms · ` +
      `sd ${round(stats.sdMs, 2)}ms · range ${round(stats.minMs, 1)}…${round(stats.maxMs, 1)}ms · clamped ${stats.clamped}`);
  }

  setPhase(phase: EnginePhase, reason?: string): void {
    this.phase = phase;
    setDataset(this.statusValue, "phase", phase);
    setText(this.statusValue, this.pendingStart ? "ARMED" : phase);
    if (phase === "ERROR" && reason) this.setNotice("error", reason);
    else if ((phase === "READY" || phase === "RUNNING") && this.noticeEl.dataset.kind === "error") this.clearNotice();
    this.updateButtonStates();
  }

  /** Reflect a queued start even while the engine remains READY/DETECTING. */
  setPendingStart(pending: boolean): void {
    this.pendingStart = pending;
    setText(this.statusValue, pending ? "ARMED" : this.phase);
    this.updateButtonStates();
  }

  private updateButtonStates(): void {
    const enabled = this.settingsManager.all.general.enabled;
    const running = this.phase === "RUNNING";
    const paused = this.phase === "PAUSED";
    setDisabled(this.startBtn, !enabled);
    this.startBtn.title = !enabled ? "Enable autoplay first"
      : running ? "Pause autoplay"
      : this.pendingStart ? "Cancel the queued start"
      : "Start Keyfall's own autoplay";
    setText(this.startLabel, running ? "Pause autoplay" : this.pendingStart ? "Cancel queued start" : paused ? "Resume autoplay" : "Start autoplay");
    const hotkeys = this.settingsManager.all.input.hotkeys;
    const code = running ? hotkeys.pause : this.pendingStart ? hotkeys.stop : hotkeys.start;
    setText(this.startHint, `${humanizeCode(code)} · ${running ? "pause" : this.pendingStart ? "cancel" : paused ? "resume" : "start"}`);
  }

  setChart(chart: ParsedChart | null, analysis: ChartAnalysis | null, mapping: KeyMapping | null): void {
    this.chart = chart;
    this.mapping = mapping;
    this.setAnalysis(analysis);
    for (const metric of Object.values(this.metrics)) setText(metric, "—");
    for (const metric of Object.values(this.quickMetrics)) setText(metric, "—");
    if (!chart) {
      setText(this.heroTitle, "Waiting for gameplay…");
      setText(this.heroSubtitle, "Open a chart to get started");
      setText(this.heroBadge, "— K");
      setText(this.metrics.keys, "—");
      for (const key of ["notes", "accuracy", "score"]) setText(this.quickMetrics[key], "—");
      this.keyboard.setMapping([], 0);
    } else {
      setText(this.heroTitle, chart.label ?? `${chart.keyCount}K chart`);
      setText(this.heroSubtitle, `${chart.keyCount} keys · ${groupDigits(chart.noteCount)} notes${mapping?.source === "user" ? " · custom mapping" : ""}`);
      setText(this.heroBadge, `${chart.keyCount}K`);
      setText(this.metrics.keys, `${chart.keyCount}K`);
      setText(this.metrics.notes, groupDigits(chart.noteCount));
      setText(this.quickMetrics.notes, groupDigits(chart.noteCount));
      this.keyboard.setMapping(mapping?.codes ?? [], chart.keyCount);
    }
    this.renderMappingGrid();
  }

  setAnalysis(analysis: ChartAnalysis | null): void {
    setText(this.analysisEl, analysis
      ? `${groupDigits(analysis.taps)} taps · ${groupDigits(analysis.holds)} holds · ${groupDigits(analysis.chords)} chord notes · ${groupDigits(analysis.jacks)} jacks · peak ${round(analysis.peakNps, 1)} NPS`
      : "Pattern analysis appears when a chart is detected.");
  }

  setStats(stats: EngineStats): void {
    const notes = groupDigits(stats.notesRemaining);
    const accuracy = stats.accuracy === null ? "—" : `${(stats.accuracy * 100).toFixed(2)}%`;
    const score = stats.score === null ? "—" : groupDigits(stats.score);
    setText(this.metrics.notes, notes); setText(this.quickMetrics.notes, notes);
    setText(this.metrics.accuracy, accuracy); setText(this.quickMetrics.accuracy, accuracy);
    setText(this.metrics.score, score); setText(this.quickMetrics.score, score);
    setText(this.metrics.combo, groupDigits(stats.combo));
    setText(this.metrics.actions, groupDigits(stats.actionsFired));
    setText(this.metrics.jitter, `${stats.lastJitter >= 0 ? "+" : ""}${stats.lastJitter.toFixed(1)}ms`);
    setText(this.metrics.time, formatTime(stats.timeElapsed));
  }

  setHeldColumns(held: number[]): void { this.keyboard.setHeld(new Set(held)); }
  setNotice(kind: "ok" | "warn" | "error", text: string, id = ""): void {
    this.noticeId = id;
    this.noticeEl.classList.remove("wom-hidden"); setDataset(this.noticeEl, "kind", kind); setText(this.noticeEl, text);
  }
  clearNotice(id?: string): void {
    if (id && id !== this.noticeId) return;
    this.noticeId = "";
    this.noticeEl.classList.add("wom-hidden"); setText(this.noticeEl, "");
  }
  private setConfirmation(text: string): void {
    // Do not hide a still-active hotkey collision behind a success message.
    if (this.noticeId !== "hotkey-collision") this.setNotice("ok", text);
  }
  setDebugSnapshot(lines: string[]): void { this.debug.setSnapshot(lines); }
  logDebug(level: "info" | "warn" | "error", message: string): void { this.debug.push(level, message); }
  clearDebug(): void { this.debug.clear(); }
  get debugEnabled(): boolean { return this.debug.isEnabled; }

  buildDebugSnapshot(diagnostics: Record<string, unknown>): string[] {
    const chart = diagnostics.chart as any;
    const clock = diagnostics.clock as any;
    const sched = diagnostics.scheduler as any;
    const stats = diagnostics.stats as any;
    const input = diagnostics.input as any;
    const hum = diagnostics.humanization as any;
    const lines = ["[DEBUG]", `Phase: ${diagnostics.phase}`, `Detected via: ${diagnostics.via ?? "—"}`];
    if (chart) {
      lines.push("Chart detected", `Keys: ${chart.keyCount}`, `Notes: ${groupDigits(chart.notes)}`,
        `Actions: ${groupDigits(chart.actions)}`, `Chart: ${chart.label ?? "—"}`);
    } else lines.push("Chart detected: no");
    lines.push(`Current time: ${stats ? formatTime(stats.timeElapsed) : "—"}`);
    if (stats) lines.push(`Next note: ${stats.nextNote ?? "—"}`, `Column: ${stats.nextColumn ?? "—"}`, `Action: ${stats.nextAction ?? "—"}`);
    lines.push(`Clock: slope ${clock?.slope ?? "—"} · err ${clock?.errorMs ?? "—"}ms · samples ${clock?.samples ?? 0} · confident ${clock?.confident ? "yes" : "no"}`);
    lines.push(`Scheduler: cursor ${sched?.cursor ?? 0}/${sched?.total ?? 0} · armed ${sched?.armed ?? 0} · fired ${groupDigits(sched?.fired ?? 0)} · dropped ${sched?.dropped ?? 0}`);
    lines.push(`Jitter: last ${round(sched?.jitter?.last ?? 0, 2)}ms · avg ${round(sched?.jitter?.avg ?? 0, 2)}ms`);
    lines.push(`Input: held ${input?.held ?? 0} · down ${groupDigits(input?.down ?? 0)} · up ${groupDigits(input?.up ?? 0)} · dup ${input?.duplicatesSuppressed ?? 0} · fail ${input?.failures ?? 0}`);
    if (hum?.enabled) {
      lines.push(`Humanize: seed ${hum.seed} · ${hum.distribution} · strength ${hum.strength} · mean ${hum.meanMs}ms · sd ${hum.sdMs}ms · range ${hum.minMs}…${hum.maxMs}ms · clamped ${hum.clamped}`);
      lines.push(`Patterns: ${hum.patterns?.jacks ?? 0} jacks · ${hum.patterns?.streams ?? 0} streams · ${hum.patterns?.chords ?? 0} chord notes · ${hum.patterns?.holds ?? 0} holds · ${hum.patterns?.isolated ?? 0} isolated`);
    } else lines.push("Humanize: off (frame-exact)");
    lines.push(`Site state: ${diagnostics.siteState ?? "—"}`);
    if (diagnostics.lastError) lines.push(`Last error: ${diagnostics.lastError}`);
    return lines;
  }

  dispose(): void {
    this.cancelTabResize();
    this.endRangePointer();
    this.cancelListen();
    for (const dispose of [...this.mappingDisposers.splice(0), ...this.hotkeyDisposers.splice(0), ...this.disposers.splice(0)]) {
      try { dispose(); } catch { /* already gone */ }
    }
    this.keyboard.dispose(); this.debug.dispose(); this.root.remove();
  }
}

export { MAX_KEY_COUNT };
