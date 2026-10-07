import {
  DEFAULT_SETTINGS,
  MAX_KEY_COUNT,
  NAME,
  OFFSET_MAX,
  OFFSET_MIN,
  VERSION,
} from "../constants";

/** Display names for the rebindable hotkeys, shared by the list and notices. */
const HOTKEY_LABELS: Record<HotkeyAction, string> = {
  toggleUI: "Toggle UI",
  start: "Start",
  pause: "Pause",
  stop: "Stop",
  emergency: "Emergency stop",
};
import type {
  EnginePhase,
  EngineStats,
  HotkeyAction,
  KeyMapping,
  ParsedChart,
  Settings,
} from "../types";
import type { ChartAnalysis } from "../chart/timeline";
import type { HumanizationStats } from "../humanize/humanizer";
import type { SettingsManager } from "../core/settings";
import { formatTime, groupDigits, humanizeCode, round } from "../util/helpers";
import { DebugPanel } from "./debug";
import { el, hexToRgba, listen, setDataset, setDisabled, setText } from "./dom";
import { KeyboardView } from "./keyboard";
import { ensureStyle, ROOT_CLASS } from "./styles";

/**
 * Overlay panel.
 *
 * One root element, one injected stylesheet, and a disposer list that removes
 * every listener on teardown. DOM writes go through `setText` / `setDataset`,
 * which no-op when the value is unchanged, so the readout costs nothing when
 * the numbers are stable.
 */

export interface OverlayHost {
  onStart: () => void;
  onPause: () => void;
  onStop: () => void;
  onEmergency: () => void;
  onSettingChange: (settings: Settings) => void;
  onRebindMapping: () => void;
  getDiagnostics: () => Record<string, unknown>;
  /**
   * Humanization statistics for the timeline that is actually loaded, or null
   * when humanization is off. Optional so existing hosts keep compiling.
   */
  getHumanizationStats?: () => HumanizationStats | null;
}

type SettingsTab = "general" | "timing" | "humanize" | "input" | "appearance";

const TAB_LABELS: Record<SettingsTab, string> = {
  general: "General",
  timing: "Timing",
  humanize: "Humanize",
  input: "Input",
  appearance: "Appearance",
};

/**
 * Humanization sliders, in render order. `syncPanelInputs` relies on this order
 * matching the order the controls are appended, so keep the two together.
 */
const HUMANIZE_SLIDERS: Array<{
  key: "strength" | "shortTermDrift" | "longTermDrift" | "patternAware" | "holdReleaseVariation" | "fatigue";
  label: string;
  unit: string;
}> = [
  { key: "strength", label: "Strength", unit: "" },
  { key: "shortTermDrift", label: "Short drift", unit: "" },
  { key: "longTermDrift", label: "Long drift", unit: "" },
  { key: "patternAware", label: "Pattern aware", unit: "" },
  { key: "holdReleaseVariation", label: "Hold release", unit: "" },
  { key: "fatigue", label: "Fatigue", unit: "" },
];

export class Overlay {
  public readonly root: HTMLElement;

  private host: OverlayHost;
  private settingsManager: SettingsManager;
  private disposers: Array<() => void> = [];

  private panel!: HTMLElement;
  private header!: HTMLElement;
  private humanizeEnable: HTMLElement | null = null;
  private humanizeSeed: HTMLInputElement | null = null;
  private humanizeDistButtons: HTMLElement[] = [];
  private humanizeStatsEl: HTMLElement | null = null;
  private mini!: HTMLElement;
  private miniDot!: HTMLElement;
  private miniPhase!: HTMLElement;
  /**
   * Kept as a field rather than stashed on the row element. Both survive a
   * settings reset (the row is never rebuilt), but a typed field cannot be
   * silently lost to a rename and needs no cast to read back.
   */
  private timingSlider: HTMLInputElement | null = null;
  private body!: HTMLElement;
  private dot!: HTMLElement;
  private titleEl!: HTMLElement;
  private statusValue!: HTMLElement;
  private mapEl!: HTMLElement;
  private noticeEl!: HTMLElement;
  private startBtn!: HTMLButtonElement;
  private pauseBtn!: HTMLButtonElement;
  private stopBtn!: HTMLButtonElement;
  private emergencyBtn!: HTMLButtonElement;
  private hintEl!: HTMLElement;

  private metrics!: Record<string, HTMLElement>;
  private keyboard = new KeyboardView();
  private debug = new DebugPanel();
  private settingsRoot!: HTMLElement;
  private tabButtons = new Map<SettingsTab, HTMLElement>();
  private tabPanels = new Map<SettingsTab, HTMLElement>();
  private activeTab: SettingsTab = "general";

  private mappingCells: HTMLElement[] = [];
  private hotkeyCells = new Map<HotkeyAction, HTMLElement>();
  private listeningFor: { kind: "mapping" | "hotkey"; index: number } | null = null;
  private listeningCell: HTMLElement | null = null;
  private listenOriginalText: string | null = null;

  private phase: EnginePhase = "IDLE";
  private chart: ParsedChart | null = null;
  private analysis: ChartAnalysis | null = null;
  private mapping: KeyMapping | null = null;
  private notice: { kind: "ok" | "warn" | "error"; text: string } | null = null;

  private dragState: { pointerId: number; offsetX: number; offsetY: number } | null = null;
  private resizeState: { pointerId: number; startX: number; startY: number; startW: number; startH: number } | null = null;

  constructor(host: OverlayHost, settingsManager: SettingsManager) {
    this.host = host;
    this.settingsManager = settingsManager;

    const settings = settingsManager.all;
    ensureStyle(document, settings.appearance.accent);

    this.root = el("div", {
      className: ROOT_CLASS,
      dataset: { part: "root", tool: NAME },
    });
    this.build();
    this.applyAppearance(settings);
    this.bindSettingsSubscription();
    this.syncFromSettings(settings);
  }

  /* ------------------------------ construction ----------------------------- */

  private build(): void {
    this.panel = el("div", { className: "wom-panel", dataset: { part: "panel" } });

    // --- header (drag handle) ---
    this.dot = el("div", { className: "wom-dot", dataset: { phase: "IDLE" } });
    this.titleEl = el("div", { className: "wom-title", text: NAME, attrs: { title: `${NAME} v${VERSION}` } });

    const settingsBtn = el("button", {
      className: "wom-icon-btn",
      text: "⚙",
      attrs: { title: "Settings" },
      type: "button",
    });
    const collapseBtn = el("button", {
      className: "wom-icon-btn",
      text: "–",
      attrs: { title: "Collapse" },
      type: "button",
    });

    this.header = el("div", { className: "wom-header", dataset: { part: "header" } }, [
      this.dot,
      this.titleEl,
      settingsBtn,
      collapseBtn,
    ]);

    // --- collapsed mini bar ---
    // References are kept rather than re-queried: a `querySelector(...)!` here
    // would throw during construction if the selector ever stopped matching,
    // and holding the node is both safer and cheaper.
    const miniDot = el("div", { className: "wom-dot", dataset: { phase: "IDLE", mini: "1" } });
    const miniPhase = el("span", { className: "wom-mini-phase", text: "IDLE" });
    const expandBtn = el("button", {
      className: "wom-icon-btn",
      text: "+",
      type: "button",
      attrs: { title: "Expand" },
    });
    this.miniDot = miniDot;
    this.miniPhase = miniPhase;
    this.mini = el("div", { className: "wom-mini", dataset: { part: "mini" } }, [
      miniDot,
      el("span", { className: "wom-mini-label", text: NAME }),
      miniPhase,
      expandBtn,
    ]);

    // --- body ---
    this.body = el("div", { className: "wom-body", dataset: { part: "body" } });

    this.statusValue = el("span", { className: "wom-status-value", dataset: { phase: "IDLE" }, text: "IDLE" });
    const statusRow = el("div", { className: "wom-status" }, [
      el("span", { className: "wom-status-label", text: "Status" }),
      this.statusValue,
    ]);

    this.mapEl = el("div", { className: "wom-map", text: "Waiting for gameplay…" });
    this.noticeEl = el("div", { className: "wom-notice wom-hidden", dataset: { kind: "warn" } });

    this.startBtn = el("button", { className: "wom-btn", text: "START", type: "button", dataset: { kind: "start" } });
    this.pauseBtn = el("button", { className: "wom-btn", text: "PAUSE", type: "button", dataset: { kind: "pause" } });
    this.stopBtn = el("button", { className: "wom-btn", text: "STOP", type: "button", dataset: { kind: "stop" } });
    const buttons = el("div", { className: "wom-buttons" }, [this.startBtn, this.pauseBtn, this.stopBtn]);

    this.emergencyBtn = el("button", {
      className: "wom-btn wom-btn-stop",
      text: "STOP",
      type: "button",
      attrs: { title: "Emergency stop — release every key immediately" },
    });
    this.hintEl = el("div", {
      className: "wom-hint",
      text: `${humanizeCode(this.settingsManager.all.input.hotkeys.emergency)} emergency stop`,
    });

    // --- metrics ---
    this.metrics = {};
    const metricDefs: Array<[string, string]> = [
      ["notes", "Notes left"],
      ["accuracy", "Accuracy"],
      ["combo", "Combo"],
      ["score", "Score"],
      ["actions", "Actions"],
      ["jitter", "Jitter"],
      ["time", "Time"],
      ["keys", "Keys"],
    ];
    const metricsGrid = el("div", { className: "wom-metrics" });
    for (const [key, label] of metricDefs) {
      const value = el("div", { className: "wom-metric-v", text: "—" });
      this.metrics[key] = value;
      metricsGrid.appendChild(
        el("div", { className: "wom-metric" }, [
          el("div", { className: "wom-metric-k", text: label }),
          value,
        ]),
      );
    }

    // --- settings ---
    this.settingsRoot = el("div", { className: "wom-section wom-hidden", dataset: { part: "settings" } });
    this.buildSettings();

    this.body.append(
      statusRow,
      this.mapEl,
      this.noticeEl,
      buttons,
      this.emergencyBtn,
      this.hintEl,
      metricsGrid,
      this.keyboard.root,
      this.buildTimingRow(),
      this.settingsRoot,
      this.debug.root,
    );

    // --- resize handle ---
    const resize = el("div", { className: "wom-resize", dataset: { part: "resize" }, attrs: { title: "Resize" } });

    this.panel.append(this.header, this.mini, this.body, resize);
    this.root.appendChild(this.panel);

    // --- wiring ---
    this.disposers.push(
      listen(this.startBtn, "click", () => this.host.onStart()),
      listen(this.pauseBtn, "click", () => this.host.onPause()),
      listen(this.stopBtn, "click", () => this.host.onStop()),
      listen(this.emergencyBtn, "click", () => this.host.onEmergency()),
      listen(settingsBtn, "click", () => this.toggleSettings()),
      listen(collapseBtn, "click", () => this.setCollapsed(true)),
      listen(expandBtn, "click", () => this.setCollapsed(false)),
    );

    this.wireDrag(this.header, resize);
    this.wireDrag(this.mini, null);
  }

  private timingRow!: HTMLElement;
  private timingValue!: HTMLElement;

  private buildTimingRow(): HTMLElement {
    const settings = this.settingsManager.all;
    this.timingValue = el("span", { className: "wom-row-value", text: `${settings.timing.offset}ms` });

    const slider = el("input", {
      className: "wom-range",
      type: "range",
      min: String(OFFSET_MIN),
      max: String(OFFSET_MAX),
      step: "1",
      value: String(settings.timing.offset),
      attrs: { title: "Timing offset: negative fires earlier, positive fires later" },
    }) as HTMLInputElement;

    // Fine adjustment: arrow keys move 1ms, shift+arrow 5ms, alt+arrow 0.1ms is
    // not representable in an integer slider so we use a numeric step of 1 and
    // expose a ±1ms nudge pair instead.
    const nudgeDown = el("button", { className: "wom-toggle-btn", text: "−1", type: "button", attrs: { title: "Offset −1ms" } });
    const nudgeUp = el("button", { className: "wom-toggle-btn", text: "+1", type: "button", attrs: { title: "Offset +1ms" } });

    this.disposers.push(
      listen(slider, "input", () => {
        const value = Number(slider.value);
        this.settingsManager.set("timing.offset", value);
      }),
      listen(nudgeDown, "click", () => {
        this.settingsManager.set("timing.offset", this.settingsManager.all.timing.offset - 1);
      }),
      listen(nudgeUp, "click", () => {
        this.settingsManager.set("timing.offset", this.settingsManager.all.timing.offset + 1);
      }),
    );

    this.timingRow = el("div", { className: "wom-section" }, [
      el("div", { className: "wom-section-title", text: "Timing offset" }),
      el("div", { className: "wom-row" }, [
        el("span", { className: "wom-row-label", text: "Offset" }),
        slider,
        this.timingValue,
      ]),
      el("div", { className: "wom-row", cssText: "justify-content:flex-end;gap:4px;margin-top:2px" }, [
        nudgeDown,
        nudgeUp,
      ]),
    ]);

    this.timingSlider = slider;
    return this.timingRow;
  }

  /* ------------------------------- settings ------------------------------- */

  private buildSettings(): void {
    const tabBar = el("div", { className: "wom-row", cssText: "gap:4px;margin-bottom:8px;flex-wrap:wrap" });

    for (const tab of Object.keys(TAB_LABELS) as SettingsTab[]) {
      const button = el("button", {
        className: "wom-toggle-btn",
        text: TAB_LABELS[tab],
        type: "button",
        dataset: { tab },
        ariaPressed: tab === this.activeTab ? "true" : "false",
      } as any);
      this.tabButtons.set(tab, button);
      this.disposers.push(listen(button, "click", () => this.setTab(tab)));
      tabBar.appendChild(button);
    }

    for (const tab of Object.keys(TAB_LABELS) as SettingsTab[]) {
      const panel = el("div", { dataset: { tabPanel: tab } });
      this.tabPanels.set(tab, panel);
      this.buildTabContent(tab, panel);
    }

    const closeBtn = el("button", { className: "wom-toggle-btn", text: "Close", type: "button", cssText: "margin-top:8px" });
    this.disposers.push(listen(closeBtn, "click", () => this.toggleSettings()));

    this.settingsRoot.append(
      el("div", { className: "wom-section-title", text: "Settings" }),
      tabBar,
      ...Array.from(this.tabPanels.values()),
      closeBtn,
    );
  }

  private setTab(tab: SettingsTab): void {
    this.activeTab = tab;
    for (const [key, button] of this.tabButtons) {
      button.setAttribute("aria-pressed", key === tab ? "true" : "false");
    }
    for (const [key, panel] of this.tabPanels) {
      panel.classList.toggle("wom-hidden", key !== tab);
    }
  }

  private buildTabContent(tab: SettingsTab, panel: HTMLElement): void {
    const settings = this.settingsManager.all;

    if (tab === "general") {
      panel.append(
        this.checkbox("Enable autoplay", settings.general.enabled, (v) => this.settingsManager.set("general.enabled", v)),
        this.checkbox("Show overlay", settings.general.showOverlay, (v) => this.settingsManager.set("general.showOverlay", v)),
        this.checkbox("Show keyboard", settings.general.showKeyboard, (v) => this.settingsManager.set("general.showKeyboard", v)),
        this.checkbox("Debug mode", settings.general.debug, (v) => this.settingsManager.set("general.debug", v)),
        el("div", { className: "wom-hint", cssText: "text-align:left;margin-top:6px", text: `v${VERSION}` }),
      );
      panel.classList.toggle("wom-hidden", tab !== this.activeTab);
      return;
    }

    if (tab === "timing") {
      panel.append(
        this.sliderRow("Offset", OFFSET_MIN, OFFSET_MAX, 1, settings.timing.offset, "ms", (v) =>
          this.settingsManager.set("timing.offset", v),
        ),
        this.sliderRow("Lookahead", 20, 500, 5, settings.timing.lookahead, "ms", (v) =>
          this.settingsManager.set("timing.lookahead", v),
        ),
        this.sliderRow("Input delay", -60, 60, 1, settings.timing.inputDelayCompensation, "ms", (v) =>
          this.settingsManager.set("timing.inputDelayCompensation", v),
        ),
        this.sliderRow("Spin window", 0, 20, 0.5, settings.timing.spinThreshold, "ms", (v) =>
          this.settingsManager.set("timing.spinThreshold", v),
        ),
        el("div", {
          className: "wom-hint",
          cssText: "text-align:left;margin-top:6px",
          text: "Lookahead arms precise timers ahead of the playhead. Spin window is the bounded busy-wait used for the final sub-millisecond placement — higher is more accurate, costlier.",
        }),
      );
      panel.classList.toggle("wom-hidden", tab !== this.activeTab);
      return;
    }

    if (tab === "humanize") {
      const h = settings.humanization;

      this.humanizeEnable = this.checkbox("Enable humanization", h.enabled, (v) =>
        this.settingsManager.set("humanization.enabled", v),
      ) as HTMLElement;

      // Seed as a text field rather than a slider: it is an arbitrary integer,
      // and being able to type a value back in is what makes a run reproducible.
      const seedInput = el("input", {
        className: "wom-text",
        type: "text",
        value: String(h.seed),
        attrs: { title: "Same seed + same chart = identical timing", inputmode: "numeric" },
      }) as HTMLInputElement;
      const randomize = el("button", {
        className: "wom-btn",
        type: "button",
        text: "Randomize",
        attrs: { title: "Pick a new seed" },
      });
      this.humanizeSeed = seedInput;

      const commitSeed = (): void => {
        const parsed = Number(seedInput.value);
        const next = Number.isFinite(parsed) ? Math.abs(Math.trunc(parsed)) >>> 0 : 0;
        if (seedInput.value !== String(next)) seedInput.value = String(next);
        this.settingsManager.set("humanization.seed", next);
      };
      this.disposers.push(listen(seedInput, "change", commitSeed));
      this.disposers.push(
        listen(randomize, "click", () => {
          seedInput.value = String((Math.random() * 4294967295) >>> 0);
          commitSeed();
        }),
      );

      const distGauss = el("button", { className: "wom-btn", type: "button", text: "Gaussian" });
      const distUniform = el("button", { className: "wom-btn", type: "button", text: "Uniform" });
      this.humanizeDistButtons = [distGauss, distUniform];
      const setDistribution = (value: "gaussian" | "uniform"): void => {
        this.settingsManager.set("humanization.distribution", value);
        this.syncHumanizeDistribution(value);
      };
      this.disposers.push(listen(distGauss, "click", () => setDistribution("gaussian")));
      this.disposers.push(listen(distUniform, "click", () => setDistribution("uniform")));
      this.syncHumanizeDistribution(h.distribution);

      this.humanizeStatsEl = el("div", { className: "wom-hint", cssText: "text-align:left" });

      panel.append(
        this.humanizeEnable,
        el("div", { className: "wom-section-title", text: "Random source" }),
        el("div", { className: "wom-row" }, [
          el("span", { className: "wom-row-label", text: "Seed" }),
          seedInput,
          randomize,
        ]),
        el("div", { className: "wom-row" }, [
          el("span", { className: "wom-row-label", text: "Distribution" }),
          distGauss,
          distUniform,
        ]),
        el("div", { className: "wom-section-title", text: "Variation" }),
        ...HUMANIZE_SLIDERS.map((def) =>
          this.sliderRow(def.label, 0, 1, 0.05, h[def.key], def.unit, (v) =>
            this.settingsManager.set(`humanization.${def.key}`, v),
          ),
        ),
        this.humanizeStatsEl,
        el("div", {
          className: "wom-hint",
          cssText: "text-align:left;margin-top:6px",
          text:
            "Shifts every note a few milliseconds either side of perfect, reproducibly from the seed. " +
            "Off by default — frame-exact playback is the baseline. This is for timing practice and " +
            "experimentation, not for evading detection: every event this tool sends is isTrusted=false.",
        }),
      );
      panel.classList.toggle("wom-hidden", tab !== this.activeTab);
      return;
    }

    if (tab === "input") {
      const mapSection = el("div", {}, [
        el("div", { className: "wom-section-title", text: "Key mapping" }),
        el("div", { className: "wom-hint", cssText: "text-align:left;margin-bottom:6px", text: "Click a column, then press the key to bind. Read from the site automatically when possible." }),
      ]);
      this.mappingGrid = el("div", { className: "wom-map-grid" });
      mapSection.appendChild(this.mappingGrid);

      const rebind = el("button", { className: "wom-toggle-btn", text: "Re-read from site", type: "button", cssText: "margin-top:6px" });
      this.disposers.push(listen(rebind, "click", () => this.host.onRebindMapping()));
      mapSection.appendChild(rebind);

      const secondary = this.checkbox(
        "Press both keybinds per column",
        settings.input.useSecondaryKeybind,
        (v) => this.settingsManager.set("input.useSecondaryKeybind", v),
      );

      const hotkeySection = el("div", { className: "wom-section" }, [
        el("div", { className: "wom-section-title", text: "Hotkeys" }),
        el("div", {
          className: "wom-hint",
          cssText: "text-align:left;margin-bottom:6px",
          text: "Click a key chip, then press any key to rebind it. Esc cancels. A chip glows while it is listening.",
        }),
      ]);
      this.hotkeyList = el("div", {});
      hotkeySection.appendChild(this.hotkeyList);

      const defaultList = (Object.keys(HOTKEY_LABELS) as HotkeyAction[])
        .map((a) => `${HOTKEY_LABELS[a]}: ${humanizeCode(DEFAULT_SETTINGS.input.hotkeys[a])}`)
        .join(", ");
      const resetHotkeys = el("button", {
        className: "wom-toggle-btn",
        text: "Reset hotkeys to defaults",
        type: "button",
        cssText: "margin-top:6px",
        attrs: { title: defaultList },
      });
      this.disposers.push(
        listen(resetHotkeys, "click", () => {
          this.settingsManager.set("input.hotkeys", { ...DEFAULT_SETTINGS.input.hotkeys });
          this.setNotice("ok", `Hotkeys reset to defaults (${defaultList}).`);
        }),
      );
      hotkeySection.appendChild(resetHotkeys);

      panel.append(mapSection, secondary, hotkeySection);
      panel.classList.toggle("wom-hidden", tab !== this.activeTab);
      this.renderMappingGrid();
      this.renderHotkeyList();
      return;
    }

    // appearance
    panel.append(
      this.sliderRow("UI scale", 0.6, 2, 0.05, settings.appearance.uiScale, "×", (v) =>
        this.settingsManager.set("appearance.uiScale", v),
      ),
      this.sliderRow("Opacity", 0.15, 1, 0.01, settings.appearance.opacity, "", (v) =>
        this.settingsManager.set("appearance.opacity", v),
      ),
      el("div", { className: "wom-row" }, [
        el("span", { className: "wom-row-label", text: "Accent" }),
        (() => {
          const input = el("input", { type: "color", value: settings.appearance.accent, attrs: { title: "Accent colour" } }) as HTMLInputElement;
          input.style.cssText = "width:34px;height:20px;border:1px solid var(--wom-border);border-radius:5px;background:transparent;padding:0;cursor:pointer";
          this.disposers.push(listen(input, "input", () => this.settingsManager.set("appearance.accent", input.value)));
          return input;
        })(),
        el("button", {
          className: "wom-toggle-btn",
          text: "Reset position",
          type: "button",
          onclick: () => this.settingsManager.set("appearance.position", { x: 16, y: 16 }),
        } as any),
      ]),
    );
    panel.classList.toggle("wom-hidden", tab !== this.activeTab);
  }

  private mappingGrid!: HTMLElement;
  private hotkeyList!: HTMLElement;

  private checkbox(label: string, initial: boolean, onChange: (value: boolean) => void): HTMLElement {
    const input = el("input", { type: "checkbox" }) as HTMLInputElement;
    input.checked = initial;
    const row = el("label", { className: "wom-check" }, [input, el("span", { text: label })]);
    this.disposers.push(listen(input, "change", () => onChange(input.checked)));
    (row as any).__input = input;
    return row;
  }

  private sliderRow(
    label: string,
    min: number,
    max: number,
    step: number,
    initial: number,
    unit: string,
    onChange: (value: number) => void,
  ): HTMLElement {
    const value = el("span", { className: "wom-row-value", text: `${round(initial, 2)}${unit}` });
    const input = el("input", {
      className: "wom-range",
      type: "range",
      min: String(min),
      max: String(max),
      step: String(step),
      value: String(initial),
    }) as HTMLInputElement;

    this.disposers.push(
      listen(input, "input", () => {
        const next = Number(input.value);
        setText(value, `${round(next, 2)}${unit}`);
        onChange(next);
      }),
    );

    const row = el("div", { className: "wom-row" }, [
      el("span", { className: "wom-row-label", text: label }),
      input,
      value,
    ]);
    (row as any).__input = input;
    (row as any).__value = value;
    (row as any).__unit = unit;
    return row;
  }

  private renderMappingGrid(): void {
    if (!this.mappingGrid) return;
    const settings = this.settingsManager.all;
    const codes = this.mapping?.codes ?? [];
    const keyCount = this.mapping?.keyCount ?? codes.length ?? 4;
    const source = this.mapping?.source ?? "fallback";
    const override = settings.input.keyMappings[String(keyCount)];

    this.mappingGrid.replaceChildren();
    this.mappingCells = [];

    for (let i = 0; i < keyCount; i++) {
      const code = override?.[i] ?? codes[i] ?? "?";
      const cell = el("div", {
        className: "wom-map-cell",
        dataset: { column: String(i), source: override ? "user" : source, listening: "0" },
        title: override ? `Column ${i + 1} → ${code} (your override)` : `Column ${i + 1} → ${code} (from site)`,
      }, [
        el("span", { className: "wom-map-index", text: String(i + 1) }),
        document.createTextNode(humanizeCode(code)),
      ]);
      this.disposers.push(listen(cell, "click", () => this.beginListen({ kind: "mapping", index: i }, cell)));
      this.mappingCells.push(cell);
      this.mappingGrid.appendChild(cell);
    }
  }

  private renderHotkeyList(): void {
    if (!this.hotkeyList) return;
    const settings = this.settingsManager.all;
    this.hotkeyList.replaceChildren();
    this.hotkeyCells.clear();

    for (const action of Object.keys(HOTKEY_LABELS) as HotkeyAction[]) {
      const key = el("button", {
        className: "wom-hotkey-key",
        text: humanizeCode(settings.input.hotkeys[action]),
        type: "button",
        dataset: { listening: "0" },
        attrs: { title: `${HOTKEY_LABELS[action]} — click to rebind` },
      });
      this.disposers.push(listen(key, "click", () => this.beginListen({ kind: "hotkey", index: action as any }, key)));
      this.hotkeyCells.set(action, key);
      this.hotkeyList.appendChild(
        el("div", { className: "wom-hotkey" }, [el("span", { className: "wom-hotkey-name", text: HOTKEY_LABELS[action] }), key]),
      );
    }
  }

  /* --------------------------- key capture mode --------------------------- */

  private beginListen(target: { kind: "mapping" | "hotkey"; index: number }, cell: HTMLElement): void {
    // Cancel any previous capture first.
    this.cancelListen();
    this.listeningFor = target;
    this.listeningCell = cell;
    this.listenOriginalText = cell.textContent ?? "";
    cell.dataset.listening = "1";
    setText(cell, "press a key…");

    const onKey = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();

      if (event.code === "Escape") {
        this.cancelListen();
        return;
      }

      if (target.kind === "mapping") {
        const column = target.index;
        const settings = this.settingsManager.all;
        const keyCount = this.mapping?.keyCount ?? this.mappingCells.length;
        // Start from the live mapping so a single override doesn't wipe the rest.
        const base = settings.input.keyMappings[String(keyCount)] ?? this.mapping?.codes ?? [];
        const next = base.slice(0, Math.max(keyCount, base.length));
        while (next.length < keyCount) next.push("");
        next[column] = event.code;

        this.settingsManager.set(`input.keyMappings.${keyCount}`, next);
        this.host.onRebindMapping();
      } else {
        const action = target.index as unknown as HotkeyAction;
        const taken = (
          Object.entries(this.settingsManager.all.input.hotkeys) as Array<[HotkeyAction, string]>
        ).find(([other, code]) => code === event.code && other !== action);
        if (taken) {
          // Stay in capture mode so the user can simply press another key.
          this.setNotice(
            "warn",
            `${humanizeCode(event.code)} is already bound to ${HOTKEY_LABELS[taken[0]]}. Press another key, or Esc to cancel.`,
          );
          return;
        }
        this.settingsManager.set(`input.hotkeys.${action}`, event.code);
      }
      // The settings subscription repaints the chip/grid; do not restore the
      // "press a key…" placeholder over the fresh value.
      this.listenOriginalText = null;
      this.cancelListen();
    };

    // Capture phase so the site's own handler and our hotkey handler never see
    // the binding keystroke.
    const disposer = listen(document, "keydown", onKey as EventListener, { capture: true });
    this.listenDisposer = () => {
      disposer();
      cell.dataset.listening = "0";
    };
  }

  private listenDisposer: (() => void) | null = null;

  private cancelListen(): void {
    if (this.listenDisposer) {
      this.listenDisposer();
      this.listenDisposer = null;
    }
    // Put the chip's label back unless a successful bind already repainted it.
    if (this.listeningCell && this.listenOriginalText !== null) {
      setText(this.listeningCell, this.listenOriginalText);
    }
    this.listeningCell = null;
    this.listenOriginalText = null;
    this.listeningFor = null;
  }

  /** True while a rebind capture owns the keyboard (see HotkeyManager). */
  get isCapturing(): boolean {
    return this.listeningFor !== null;
  }

  /* ------------------------------ drag/resize ----------------------------- */

  private wireDrag(handle: HTMLElement, resizeHandle: HTMLElement | null): void {
    this.disposers.push(
      listen(handle, "pointerdown", (event) => this.onDragStart(event as PointerEvent)),
    );

    if (resizeHandle) {
      this.disposers.push(
        listen(resizeHandle, "pointerdown", (event) => this.onResizeStart(event as PointerEvent)),
      );
    }

    this.disposers.push(
      listen(window, "pointermove", (event) => this.onPointerMove(event as PointerEvent)),
      listen(window, "pointerup", (event) => this.onPointerUp(event as PointerEvent)),
      listen(window, "pointercancel", (event) => this.onPointerUp(event as PointerEvent)),
      listen(window, "resize", () => this.clampIntoView()),
    );
  }

  private onDragStart(event: PointerEvent): void {
    // Ignore drags that begin on a control.
    const target = event.target as HTMLElement;
    if (target.closest("button, input, label, select")) return;

    const rect = this.root.getBoundingClientRect();
    this.dragState = {
      pointerId: event.pointerId,
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top,
    };
    event.preventDefault();
  }

  private onResizeStart(event: PointerEvent): void {
    const rect = this.root.getBoundingClientRect();
    this.resizeState = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startW: rect.width,
      startH: rect.height,
    };
    event.preventDefault();
    event.stopPropagation();
  }

  private onPointerMove(event: PointerEvent): void {
    if (this.dragState && this.dragState.pointerId === event.pointerId) {
      const x = event.clientX - this.dragState.offsetX;
      const y = event.clientY - this.dragState.offsetY;
      this.setPosition(x, y, true);
      return;
    }
    if (this.resizeState && this.resizeState.pointerId === event.pointerId) {
      const scale = this.settingsManager.all.appearance.uiScale || 1;
      const dw = (event.clientX - this.resizeState.startX) / scale;
      const dh = (event.clientY - this.resizeState.startY) / scale;
      const w = Math.max(220, Math.min(640, this.resizeState.startW / scale + dw));
      const h = Math.max(0, this.resizeState.startH / scale + dh);
      this.root.style.width = `${w}px`;
      if (h > 120) {
        this.body.style.maxHeight = `${Math.max(120, h - 46)}px`;
        this.settingsManager.set("appearance.size", { w: Math.round(w), h: Math.round(h) });
      } else {
        this.settingsManager.set("appearance.size", { w: Math.round(w), h: 0 });
      }
    }
  }

  private onPointerUp(event: PointerEvent): void {
    if (this.dragState?.pointerId === event.pointerId) {
      const pos = this.readPosition();
      this.settingsManager.set("appearance.position", pos);
      this.dragState = null;
    }
    if (this.resizeState?.pointerId === event.pointerId) {
      this.resizeState = null;
    }
  }

  private readPosition(): { x: number; y: number } {
    const rect = this.root.getBoundingClientRect();
    const scale = this.settingsManager.all.appearance.uiScale || 1;
    return { x: Math.round(rect.left / scale), y: Math.round(rect.top / scale) };
  }

  private setPosition(x: number, y: number, clamp = false): void {
    const rect = this.root.getBoundingClientRect();
    const maxX = window.innerWidth - Math.min(rect.width, 80);
    const maxY = window.innerHeight - 28;
    const nextX = clamp ? Math.max(-rect.width + 80, Math.min(maxX, x)) : x;
    const nextY = clamp ? Math.max(0, Math.min(maxY, y)) : y;
    this.root.style.left = `${nextX}px`;
    this.root.style.top = `${nextY}px`;
  }

  private clampIntoView(): void {
    const rect = this.root.getBoundingClientRect();
    if (rect.left + rect.width < 40 || rect.top > window.innerHeight - 20) {
      this.setPosition(16, 16, true);
      this.settingsManager.set("appearance.position", { x: 16, y: 16 });
    }
  }

  /* ------------------------------- appearance ----------------------------- */

  private applyAppearance(settings: Settings): void {
    const { uiScale, opacity, accent, position, collapsed, size } = settings.appearance;

    this.root.style.transform = `scale(${uiScale})`;
    this.root.style.transformOrigin = "top left";
    this.root.style.opacity = String(opacity);
    this.root.style.setProperty("--wom-accent", accent);
    // Keep the hover ring readable at any accent.
    this.root.style.setProperty("--wom-accent-soft", hexToRgba(accent, 0.35));

    if (size.w > 0) this.root.style.width = `${size.w}px`;
    else this.root.style.width = "296px";
    if (size.h > 120) this.body.style.maxHeight = `${size.h - 46}px`;
    else this.body.style.maxHeight = `${Math.max(220, window.innerHeight - 140)}px`;

    this.setPosition(position.x, position.y, true);
    this.root.classList.toggle("wom-collapsed", collapsed);
  }

  private setCollapsed(collapsed: boolean): void {
    this.root.classList.toggle("wom-collapsed", collapsed);
    this.settingsManager.set("appearance.collapsed", collapsed);
  }

  private toggleSettings(): void {
    const hidden = this.settingsRoot.classList.contains("wom-hidden");
    this.settingsRoot.classList.toggle("wom-hidden", !hidden);
    if (hidden) {
      this.renderMappingGrid();
      this.renderHotkeyList();
    }
  }

  private syncFromSettings(settings: Settings): void {
    this.applyAppearance(settings);
    this.debug.setEnabled(settings.general.debug);
    this.keyboard.setVisible(settings.general.showKeyboard);
    this.root.classList.toggle("wom-hidden", !settings.general.showOverlay);
    setText(this.hintEl, `${settings.input.hotkeys.emergency} emergency stop`);

    // Refresh controls that mirror settings values.
    const slider = this.timingSlider;
    if (slider && slider.value !== String(settings.timing.offset)) {
      slider.value = String(settings.timing.offset);
    }
    setText(this.timingValue, `${settings.timing.offset}ms`);

    for (const [tab, panel] of this.tabPanels) {
      this.syncPanelInputs(tab, panel, settings);
    }

    this.updateButtonStates();
    this.host.onSettingChange(settings);
  }

  /** Push persisted values back into already-built controls. */
  private syncHumanizeDistribution(active: "gaussian" | "uniform"): void {
    const [gauss, uniform] = this.humanizeDistButtons;
    gauss?.classList.toggle("wom-btn-active", active === "gaussian");
    uniform?.classList.toggle("wom-btn-active", active === "uniform");
  }

  /**
   * Live humanization readout. Sourced from the engine's diagnostics rather than
   * recomputed here: these are the deltas actually baked into the timeline that
   * is playing, which is the number worth looking at.
   */
  private renderHumanizeStats(): void {
    const target = this.humanizeStatsEl;
    if (!target) return;
    const stats = this.host.getHumanizationStats?.() ?? null;
    if (!stats) {
      setText(target, "Humanization off — timing is frame-exact.");
      return;
    }
    setText(
      target,
      `${stats.notes} notes · mean ${stats.meanMs >= 0 ? "+" : ""}${round(stats.meanMs, 2)}ms · ` +
        `sd ${round(stats.sdMs, 2)}ms · range ${round(stats.minMs, 1)}…${round(stats.maxMs, 1)}ms · ` +
        `clamped ${stats.clamped}`,
    );
  }

  private syncPanelInputs(tab: SettingsTab, panel: HTMLElement, settings: Settings): void {
    if (tab === "general") {
      const checks = panel.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
      const order: Array<keyof Settings["general"]> = ["enabled", "showOverlay", "showKeyboard", "debug"];
      order.forEach((key, i) => {
        if (checks[i] && checks[i].checked !== settings.general[key]) checks[i].checked = settings.general[key];
      });
      return;
    }

    if (tab === "timing") {
      const ranges = panel.querySelectorAll<HTMLInputElement>('input[type="range"]');
      const values = panel.querySelectorAll<HTMLElement>(".wom-row-value");
      const defs: Array<[keyof Settings["timing"], string]> = [
        ["offset", "ms"],
        ["lookahead", "ms"],
        ["inputDelayCompensation", "ms"],
        ["spinThreshold", "ms"],
      ];
      defs.forEach(([key, unit], i) => {
        const v = settings.timing[key] as number;
        if (ranges[i] && ranges[i].value !== String(v)) ranges[i].value = String(v);
        if (values[i]) setText(values[i], `${round(v, 2)}${unit}`);
      });
      return;
    }

    if (tab === "humanize") {
      const h = settings.humanization;
      const enable = this.humanizeEnable?.querySelector<HTMLInputElement>('input[type="checkbox"]');
      if (enable && enable.checked !== h.enabled) enable.checked = h.enabled;
      if (this.humanizeSeed && this.humanizeSeed.value !== String(h.seed)) {
        this.humanizeSeed.value = String(h.seed);
      }
      this.syncHumanizeDistribution(h.distribution);

      const ranges = panel.querySelectorAll<HTMLInputElement>('input[type="range"]');
      const values = panel.querySelectorAll<HTMLElement>(".wom-row-value");
      HUMANIZE_SLIDERS.forEach((def, i) => {
        const v = h[def.key];
        if (ranges[i] && ranges[i].value !== String(v)) ranges[i].value = String(v);
        if (values[i]) setText(values[i], `${round(v, 2)}${def.unit}`);
      });

      this.renderHumanizeStats();
      return;
    }

    if (tab === "input") {
      const check = panel.querySelector<HTMLInputElement>('input[type="checkbox"]');
      if (check && check.checked !== settings.input.useSecondaryKeybind) {
        check.checked = settings.input.useSecondaryKeybind;
      }
      this.renderMappingGrid();
      for (const [action, cell] of this.hotkeyCells) {
        setText(cell, humanizeCode(settings.input.hotkeys[action]));
      }
      return;
    }

    // appearance
    const ranges = panel.querySelectorAll<HTMLInputElement>('input[type="range"]');
    const values = panel.querySelectorAll<HTMLElement>(".wom-row-value");
    const defs: Array<[number, string]> = [
      [settings.appearance.uiScale, "×"],
      [settings.appearance.opacity, ""],
    ];
    defs.forEach(([v, unit], i) => {
      if (ranges[i] && ranges[i].value !== String(v)) ranges[i].value = String(v);
      if (values[i]) setText(values[i], `${round(v, 2)}${unit}`);
    });
    const color = panel.querySelector<HTMLInputElement>('input[type="color"]');
    if (color && color.value.toLowerCase() !== settings.appearance.accent.toLowerCase()) {
      color.value = settings.appearance.accent;
    }
  }

  private bindSettingsSubscription(): void {
    this.disposers.push(this.settingsManager.onChange(({ settings }) => this.syncFromSettings(settings)));
  }

  /* -------------------------------- updates ------------------------------- */

  setPhase(phase: EnginePhase, reason?: string): void {
    this.phase = phase;
    setDataset(this.dot, "phase", phase);
    setDataset(this.statusValue, "phase", phase);
    setText(this.statusValue, phase);

    setDataset(this.miniDot, "phase", phase);
    setText(this.miniPhase, phase);

    if (phase === "ERROR" && reason) this.setNotice("error", reason);
    else if (phase === "READY" || phase === "RUNNING") this.clearNotice();

    this.updateButtonStates();
  }

  private updateButtonStates(): void {
    const running = this.phase === "RUNNING";
    const paused = this.phase === "PAUSED";
    const ready = this.phase === "READY";

    setDisabled(this.startBtn, running);
    setText(this.startBtn, paused ? "RESUME" : "START");
    setDisabled(this.pauseBtn, !running);
    setDisabled(this.stopBtn, !(running || paused));
    this.startBtn.dataset.kind = "start";
    void ready;
  }

  setChart(chart: ParsedChart | null, analysis: ChartAnalysis | null, mapping: KeyMapping | null): void {
    this.chart = chart;
    this.analysis = analysis;
    this.mapping = mapping;

    if (!chart) {
      setText(this.mapEl, "Waiting for gameplay…");
      setText(this.metrics.keys, "—");
      this.keyboard.setMapping([], 0);
      return;
    }

    const sourceNote =
      mapping?.source === "site"
        ? ""
        : mapping?.source === "user"
          ? " · your mapping"
          : " · fallback mapping";

    this.mapEl.replaceChildren();
    this.mapEl.append(
      el("b", { text: `${chart.keyCount}K` }),
      document.createTextNode(` · ${groupDigits(chart.noteCount)} notes`),
      document.createTextNode(chart.label ? ` · ${chart.label}` : ""),
      document.createTextNode(sourceNote),
    );

    setText(this.metrics.keys, `${chart.keyCount}K`);
    this.keyboard.setMapping(mapping?.codes ?? [], chart.keyCount);
    if (this.mappingGrid) this.renderMappingGrid();
  }

  setStats(stats: EngineStats): void {
    setText(this.metrics.notes, groupDigits(stats.notesRemaining));
    setText(
      this.metrics.accuracy,
      stats.accuracy === null ? "—" : `${(stats.accuracy * 100).toFixed(2)}%`,
    );
    setText(this.metrics.combo, groupDigits(stats.combo));
    setText(this.metrics.score, stats.score === null ? "—" : groupDigits(stats.score));
    setText(this.metrics.actions, groupDigits(stats.actionsFired));
    setText(this.metrics.jitter, `${stats.lastJitter >= 0 ? "+" : ""}${stats.lastJitter.toFixed(1)}ms`);
    setText(this.metrics.time, formatTime(stats.timeElapsed));
  }

  setHeldColumns(held: number[]): void {
    this.keyboard.setHeld(new Set(held));
  }

  setNotice(kind: "ok" | "warn" | "error", text: string): void {
    this.notice = { kind, text };
    this.noticeEl.classList.remove("wom-hidden");
    setDataset(this.noticeEl, "kind", kind);
    setText(this.noticeEl, text);
  }

  clearNotice(): void {
    this.notice = null;
    this.noticeEl.classList.add("wom-hidden");
    setText(this.noticeEl, "");
  }

  /** Debug: structured snapshot lines. */
  setDebugSnapshot(lines: string[]): void {
    this.debug.setSnapshot(lines);
  }

  logDebug(level: "info" | "warn" | "error", message: string): void {
    this.debug.push(level, message);
  }

  clearDebug(): void {
    this.debug.clear();
  }

  get debugEnabled(): boolean {
    return this.debug.isEnabled;
  }

  /** Build the `[DEBUG]` block described in the spec. */
  buildDebugSnapshot(diagnostics: Record<string, unknown>): string[] {
    const chart = diagnostics.chart as any;
    const clock = diagnostics.clock as any;
    const sched = diagnostics.scheduler as any;
    const stats = diagnostics.stats as any;

    const lines = ["[DEBUG]"];
    lines.push(`Phase: ${diagnostics.phase}`);
    lines.push(`Detected via: ${diagnostics.via ?? "—"}`);
    if (chart) {
      lines.push(`Chart detected`);
      lines.push(`Keys: ${chart.keyCount}`);
      lines.push(`Notes: ${groupDigits(chart.notes)}`);
      lines.push(`Actions: ${groupDigits(chart.actions)}`);
      lines.push(`Chart: ${chart.label ?? "—"}`);
    } else {
      lines.push("Chart detected: no");
    }
    lines.push(`Current time: ${stats ? formatTime(stats.timeElapsed) : "—"}`);
    if (stats) {
      lines.push(`Next note: ${stats.nextNote ?? "—"}`);
      lines.push(`Column: ${stats.nextColumn ?? "—"}`);
      lines.push(`Action: ${stats.nextAction ?? "—"}`);
    }
    lines.push(
      `Clock: slope ${clock?.slope ?? "—"} · err ${clock?.errorMs ?? "—"}ms · samples ${clock?.samples ?? 0} · confident ${clock?.confident ? "yes" : "no"}`,
    );
    lines.push(
      `Scheduler: cursor ${sched?.cursor ?? 0}/${sched?.total ?? 0} · armed ${sched?.armed ?? 0} · fired ${groupDigits(sched?.fired ?? 0)} · dropped ${sched?.dropped ?? 0}`,
    );
    lines.push(`Jitter: last ${round(sched?.jitter?.last ?? 0, 2)}ms · avg ${round(sched?.jitter?.avg ?? 0, 2)}ms`);
    const input = diagnostics.input as any;
    lines.push(
      `Input: held ${input?.held ?? 0} · down ${groupDigits(input?.down ?? 0)} · up ${groupDigits(input?.up ?? 0)} · dup ${input?.duplicatesSuppressed ?? 0} · fail ${input?.failures ?? 0}`,
    );
    const hum = diagnostics.humanization as any;
    if (hum?.enabled) {
      lines.push(
        `Humanize: seed ${hum.seed} · ${hum.distribution} · strength ${hum.strength} · ` +
          `mean ${hum.meanMs}ms · sd ${hum.sdMs}ms · range ${hum.minMs}…${hum.maxMs}ms · clamped ${hum.clamped}`,
      );
      lines.push(
        `Patterns: ${hum.patterns?.jacks ?? 0} jacks · ${hum.patterns?.streams ?? 0} streams · ` +
          `${hum.patterns?.chords ?? 0} chord notes · ${hum.patterns?.holds ?? 0} holds · ${hum.patterns?.isolated ?? 0} isolated`,
      );
    } else {
      lines.push("Humanize: off (frame-exact)");
    }
    lines.push(`Site state: ${diagnostics.siteState ?? "—"}`);
    if (diagnostics.lastError) lines.push(`Last error: ${diagnostics.lastError}`);
    return lines;
  }

  /* -------------------------------- teardown ------------------------------ */

  dispose(): void {
    this.cancelListen();
    for (const dispose of this.disposers.splice(0)) {
      try {
        dispose();
      } catch {
        /* already gone */
      }
    }
    this.keyboard.dispose();
    this.debug.dispose();
    this.root.remove();
    this.disposers.length = 0;
  }
}

export { MAX_KEY_COUNT };
