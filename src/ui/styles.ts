import { NAME } from "../constants";

/**
 * The original, self-contained artwork is embedded by the build so the
 * userscript does not fetch images, fonts, or other resources from a site.
 * A gradient remains usable when these sources are imported directly in tests.
 */
declare const __KEYFALL_COVER__: string;

export const ROOT_CLASS = "wom-ap-root";
export const STYLE_ID = "wom-ap-style";

const MOSAIC = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='150' height='70' viewBox='0 0 150 70'%3E%3Cpath fill='%23fff' fill-opacity='.10' d='M0 0h32L9 27zM32 0h38L48 21zM70 0h32L86 26zM119 0h31v26zM0 39l23-21 21 34-24 18H0zM48 21l25 12-13 37H38zM101 22l23-22 26 34-19 36h-27l10-23z'/%3E%3Cpath fill='%23000' fill-opacity='.15' d='M9 27L32 0l16 21-4 31zM73 33L102 0l12 47-28 23H60zM124 0l26 26v8zM23 18l15 52H20zM114 47l17 23H86z'/%3E%3C/svg%3E";

export function buildCss(accent: string): string {
  const cover = typeof __KEYFALL_COVER__ === "undefined" ? "" : __KEYFALL_COVER__;
  const artwork = cover
    ? `linear-gradient(0deg, rgba(26,20,35,.69), rgba(33,25,43,.12) 68%), url("${cover}")`
    : "linear-gradient(120deg, #a47597, #c2a0b6 38%, #739ba4 75%, #d8b899)";
  return `
.${ROOT_CLASS} {
  --wom-accent: ${accent};
  --wom-bg: #252132;
  --wom-text: #f5f0fb;
  --wom-muted: #b9b4ff;
  --wom-dim: #686391;
  --wom-border: rgba(166, 150, 216, .15);
  --wom-danger: #ff6e9e;
  --wom-ok: #80f2c7;
  --wom-warn: #ffcd80;
  --wom-ease: cubic-bezier(.22, 1, .36, 1);
  position: fixed;
  z-index: 2147483000;
  color: var(--wom-text);
  font: 13px/1.35 "Segoe UI", -apple-system, BlinkMacSystemFont, Arial, sans-serif;
  text-align: left;
  letter-spacing: normal;
  -webkit-font-smoothing: antialiased;
  user-select: none;
  -webkit-user-select: none;
  container-type: inline-size;
}
.${ROOT_CLASS} *, .${ROOT_CLASS} *::before, .${ROOT_CLASS} *::after { box-sizing: border-box; font-family: inherit; }
.${ROOT_CLASS} button, .${ROOT_CLASS} input { font-family: inherit; letter-spacing: normal; }
.${ROOT_CLASS}[data-open="0"] { visibility: hidden; pointer-events: none; transition: visibility 0s .3s; }
.${ROOT_CLASS}[data-open="1"] { visibility: visible; transition: visibility 0s; }

.wom-panel {
  position: relative;
  display: flex;
  flex-direction: column;
  width: 100%;
  overflow: hidden;
  background: var(--wom-bg);
  border-radius: 2px;
  box-shadow: 0 14px 44px rgba(8, 5, 18, .48), 0 0 0 1px rgba(255,255,255,.035);
  transform-origin: 25% 0;
  transform: translateY(0) scale(1);
  opacity: 1;
  transition: opacity .27s var(--wom-ease), transform .4s var(--wom-ease);
}
.${ROOT_CLASS}[data-open="0"] .wom-panel { opacity: 0; transform: translateY(-9px) scale(.985); }

/* Match the compact desktop title bar in the reference. */
.wom-header {
  flex: 0 0 40px;
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 0 10px;
  background: #21182d;
  cursor: grab;
  touch-action: none;
}
.wom-header:active { cursor: grabbing; }
.wom-logo {
  display: grid; place-items: center;
  width: 16px; height: 16px;
  border: 1px solid #ffc1df;
  border-radius: 50%;
  background: #ed66a5;
  color: white;
  font-size: 8px; font-weight: 700; line-height: 1;
}
.wom-title { flex: 1; min-width: 0; font-size: 13px; font-weight: 400; white-space: nowrap; }
.wom-window-controls { display: flex; align-items: center; gap: 32px; padding: 0 7px; color: #fff; font-size: 17px; line-height: 1; pointer-events: none; }

.wom-body {
  min-height: 0;
  overflow-x: hidden;
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-width: thin;
  scrollbar-color: #655778 transparent;
}
.wom-body::-webkit-scrollbar, .wom-drawer-scroll::-webkit-scrollbar, .wom-debug::-webkit-scrollbar { width: 5px; }
.wom-body::-webkit-scrollbar-thumb, .wom-drawer-scroll::-webkit-scrollbar-thumb, .wom-debug::-webkit-scrollbar-thumb { background: #655778; border-radius: 4px; }
.wom-hero-wrap { padding: 0 10px 10px; background: #1d192a; }
.wom-hero {
  position: relative;
  height: 102px;
  overflow: hidden;
  background-color: #a98c9e;
  background-image: ${artwork};
  background-size: cover;
  background-position: center;
}
.wom-hero-copy { position: absolute; left: 8px; right: 66px; bottom: 7px; min-width: 0; color: #fff; text-shadow: 0 1px 5px rgba(0,0,0,.6); }
.wom-hero-title { font-size: 21px; line-height: 1.15; font-weight: 700; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.wom-hero-subtitle { margin-top: 3px; font-size: 12px; font-weight: 600; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.wom-hero-status, .wom-hero-badge { position: absolute; right: 7px; color: #fff; background: rgba(21,18,29,.78); border-radius: 16px; font-variant-numeric: tabular-nums; text-shadow: 0 1px 2px #000; }
.wom-hero-status { top: 7px; max-width: 68%; overflow: hidden; text-overflow: ellipsis; padding: 4px 13px; font-size: 10px; font-weight: 700; letter-spacing: .035em; }
.wom-hero-status[data-phase="RUNNING"] { color: #8cf5cb; }
.wom-hero-status[data-phase="PAUSED"] { color: #ffd48f; }
.wom-hero-status[data-phase="ERROR"] { color: #ff9eb9; }
.wom-hero-badge { bottom: 5px; min-width: 55px; padding: 2px 10px; font-size: 16px; text-align: center; }

/* Flat, thin trainer sliders. The native range control retains accurate
   pointer dragging and keyboard support; only the thumb's hover state eases. */
.wom-quick-sliders { padding: 4px 18px 0; }
.wom-slider-row { display: grid; grid-template-columns: 76px 49px minmax(0, 1fr) 20px; align-items: center; gap: 5px; min-height: 28px; }
.wom-slider-wide { grid-template-columns: minmax(87px, 1fr) 52px minmax(80px, 2fr) 20px; }
.wom-slider-label { color: #b4b0fa; font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.wom-slider-value { color: #e8e7f8; font-size: 13px; font-weight: 600; text-align: left; font-variant-numeric: tabular-nums; white-space: nowrap; }
.${ROOT_CLASS} .wom-range { appearance: none; -webkit-appearance: none; width: 100%; min-width: 0; height: 22px; padding: 0; margin: 0; border: 0; outline: none; background: transparent; cursor: pointer; }
.${ROOT_CLASS} .wom-range::-webkit-slider-runnable-track { height: 4px; border-radius: 2px; background: linear-gradient(to right, #292037 var(--wom-progress, 50%), #1e192b var(--wom-progress, 50%)); }
.${ROOT_CLASS} .wom-range::-moz-range-track { height: 4px; border-radius: 2px; background: #1e192b; }
.${ROOT_CLASS} .wom-range::-moz-range-progress { height: 4px; border-radius: 2px; background: #292037; }
.${ROOT_CLASS} .wom-range::-webkit-slider-thumb { appearance: none; -webkit-appearance: none; width: 16px; height: 16px; margin-top: -6px; border: 1px solid #98a4ff; border-radius: 50%; background: #252132; transition: transform .23s var(--wom-ease), box-shadow .23s var(--wom-ease), background .23s var(--wom-ease); }
.${ROOT_CLASS} .wom-range::-moz-range-thumb { width: 14px; height: 14px; border: 1px solid #98a4ff; border-radius: 50%; background: #252132; transition: transform .23s var(--wom-ease), box-shadow .23s var(--wom-ease), background .23s var(--wom-ease); }
.${ROOT_CLASS} .wom-range:hover::-webkit-slider-thumb, .${ROOT_CLASS} .wom-range:focus-visible::-webkit-slider-thumb { box-shadow: 0 0 0 4px rgba(157,166,255,.14); }
.${ROOT_CLASS} .wom-range:hover::-moz-range-thumb, .${ROOT_CLASS} .wom-range:focus-visible::-moz-range-thumb { box-shadow: 0 0 0 4px rgba(157,166,255,.14); }
.${ROOT_CLASS} .wom-range:active::-webkit-slider-thumb { transform: scale(1.12); background: #34304a; }
.${ROOT_CLASS} .wom-range:active::-moz-range-thumb { transform: scale(1.12); background: #34304a; }
.${ROOT_CLASS} .wom-slider-reset { appearance: none; border: 0; background: transparent; color: #8b859a; padding: 0; font-size: 15px; line-height: 20px; cursor: pointer; transition: color .2s var(--wom-ease), transform .2s var(--wom-ease); }
.${ROOT_CLASS} .wom-slider-reset:hover { color: #fff; transform: rotate(-25deg); }

.wom-quick-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; padding: 6px 20px 5px; }
.wom-quick-readout, .wom-switch { min-height: 28px; display: flex; align-items: center; gap: 8px; }
.wom-quick-label, .wom-switch-label { color: #b7b3fb; font-size: 13px; white-space: nowrap; }
.wom-quick-label { min-width: 76px; }
.wom-quick-value { color: #f2efff; font-weight: 600; font-size: 13px; font-variant-numeric: tabular-nums; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.wom-quick-switches .wom-switch { justify-content: flex-end; }
.wom-switch { position: relative; cursor: pointer; justify-content: space-between; }
.wom-switch-input { position: absolute; width: 1px; height: 1px; opacity: 0; margin: 0; }
.wom-switch-track { flex: 0 0 auto; position: relative; display: block; width: 26px; height: 14px; border: 2px solid var(--wom-accent); border-radius: 10px; background: transparent; transition: background .28s var(--wom-ease), box-shadow .28s var(--wom-ease); }
.wom-switch-knob { position: absolute; top: 2px; left: 2px; width: 6px; height: 6px; border-radius: 50%; background: var(--wom-accent); opacity: .55; transition: transform .32s var(--wom-ease), opacity .2s var(--wom-ease), background .2s var(--wom-ease); }
.wom-switch-input:checked + .wom-switch-track { background: var(--wom-accent); }
.wom-switch-input:checked + .wom-switch-track .wom-switch-knob { transform: translateX(12px); opacity: 1; background: #fff; }
.wom-switch:hover .wom-switch-track, .wom-switch-input:focus-visible + .wom-switch-track { box-shadow: 0 0 0 4px var(--wom-accent-soft); }

.wom-presets { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 5px; padding: 2px 10px 8px; }
.wom-preset { min-width: 0; text-align: center; }
.${ROOT_CLASS} .wom-preset-button { appearance: none; width: 100%; height: 24px; border: 0; border-radius: 4px; padding: 0 3px; color: #fff; background-color: #7950c5; background-image: url("${MOSAIC}"); background-size: 95px 45px; font-size: 11px; cursor: pointer; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; transition: filter .25s var(--wom-ease), transform .25s var(--wom-ease), box-shadow .25s var(--wom-ease); }
.${ROOT_CLASS} .wom-preset-button:hover, .${ROOT_CLASS} .wom-preset-button[aria-pressed="true"] { filter: brightness(1.18); box-shadow: 0 0 0 1px rgba(219,190,255,.45); }
.${ROOT_CLASS} .wom-preset-button:active { transform: scale(.96); }
.wom-preset-caption { display: block; height: 16px; color: #686391; font-size: 10px; line-height: 16px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.wom-more-bar { position: relative; height: 20px; background: #1e192b; }
.${ROOT_CLASS} .wom-more-button { display: block; width: 100%; height: 20px; appearance: none; border: 0; padding: 0; background: transparent; color: #b5acff; font-size: 10px; cursor: pointer; transition: color .2s var(--wom-ease), background .2s var(--wom-ease); }
.${ROOT_CLASS} .wom-more-button:hover { color: #fff; background: rgba(160,142,255,.07); }
.${ROOT_CLASS} .wom-emergency { position: absolute; top: 1px; right: 10px; appearance: none; border: 0; padding: 2px 0 1px 6px; background: transparent; color: #ab7799; font-size: 9px; cursor: pointer; transition: color .2s var(--wom-ease); }
.${ROOT_CLASS} .wom-emergency:hover { color: #ff95bb; }

/* The expandable region uses an Apple-like decelerating motion curve rather
   than an abrupt display:none. inert prevents tabbing into a closed drawer. */
.wom-drawer { display: grid; grid-template-rows: 0fr; opacity: 0; transition: grid-template-rows .38s var(--wom-ease), opacity .25s var(--wom-ease); }
.${ROOT_CLASS}[data-expanded="1"] .wom-drawer { grid-template-rows: 1fr; opacity: 1; }
.wom-drawer-inner { min-height: 0; overflow: hidden; }
.wom-drawer-scroll { max-height: min(360px, 46vh); overflow: auto; padding: 12px 18px 15px; scrollbar-width: thin; scrollbar-color: #655778 transparent; }
.wom-tab-panel { animation: wom-tab-enter .25s var(--wom-ease) both; }
@keyframes wom-tab-enter { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: translateY(0); } }
.wom-section-title { color: #d0c6ff; font-size: 11px; font-weight: 700; letter-spacing: .045em; text-transform: uppercase; margin: 2px 0 7px; }
.wom-section-gap { margin-top: 16px; }
.wom-help { color: #9691b9; margin: 5px 0 8px; font-size: 11px; line-height: 1.45; }
.wom-form-row { display: flex; align-items: center; gap: 7px; min-height: 31px; }
.wom-form-label { flex: 0 0 87px; color: #b7b3fb; font-size: 12px; }
.${ROOT_CLASS} .wom-text { min-width: 0; flex: 1; height: 25px; padding: 3px 7px; border: 1px solid #544568; border-radius: 4px; color: #f5f0fb; background: #1e192b; font-size: 12px; font-variant-numeric: tabular-nums; }
.${ROOT_CLASS} .wom-small-button, .${ROOT_CLASS} .wom-hotkey-key { appearance: none; border: 1px solid #615177; border-radius: 4px; padding: 4px 8px; background: #30273d; color: #e0d8fa; font-size: 11px; cursor: pointer; transition: color .2s var(--wom-ease), background .2s var(--wom-ease), border-color .2s var(--wom-ease), transform .2s var(--wom-ease); }
.${ROOT_CLASS} .wom-small-button:hover, .${ROOT_CLASS} .wom-hotkey-key:hover:not(:disabled) { color: #fff; background: #433451; border-color: #9a85b7; }
.${ROOT_CLASS} .wom-small-button:active, .${ROOT_CLASS} .wom-hotkey-key:active:not(:disabled) { transform: scale(.97); }
.${ROOT_CLASS} .wom-small-button[aria-pressed="true"] { background: #6745a9; border-color: #a88ae2; color: #fff; }
.${ROOT_CLASS} .wom-color { width: 30px; height: 23px; border: 0; padding: 0; background: transparent; cursor: pointer; }
.wom-map-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(42px, 1fr)); gap: 4px; margin: 7px 0; }
.${ROOT_CLASS} .wom-map-cell { appearance: none; min-width: 0; padding: 4px 2px; color: #f2edff; background: #30273d; border: 1px solid #615177; border-radius: 4px; font-size: 11px; cursor: pointer; transition: background .2s var(--wom-ease), border-color .2s var(--wom-ease); }
.${ROOT_CLASS} .wom-map-cell:hover, .${ROOT_CLASS} .wom-map-cell[data-listening="1"] { background: #4b355b; border-color: var(--wom-accent); }
.wom-map-index { display: block; color: #9990b8; font-size: 9px; }
.wom-hotkey { display: flex; justify-content: space-between; align-items: center; min-height: 31px; gap: 8px; }
.wom-hotkey-name { color: #b7b3fb; font-size: 12px; }
.${ROOT_CLASS} .wom-hotkey-key { min-width: 56px; text-align: center; }
.${ROOT_CLASS} .wom-hotkey-key:disabled { opacity: .72; cursor: default; }
.${ROOT_CLASS} .wom-hotkey-key[data-listening="1"] { border-color: var(--wom-accent); color: var(--wom-accent); }
.wom-reset-settings { margin-top: 8px; }

.wom-metrics { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 5px; margin-bottom: 8px; }
.wom-metric { min-width: 0; padding: 5px; background: #1f1a2b; border: 1px solid var(--wom-border); border-radius: 3px; }
.wom-metric-k { color: #9691b9; font-size: 9px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.wom-metric-v { color: #f5f0fb; font-size: 12px; font-weight: 600; font-variant-numeric: tabular-nums; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.wom-keys { display: flex; gap: 3px; justify-content: center; }
.wom-key { flex: 1 1 0; min-width: 0; height: 27px; display: grid; place-items: center; overflow: hidden; border: 1px solid #615177; border-radius: 4px; background: #30273d; color: #c0b8db; font-size: 10px; font-weight: 700; transition: background .055s linear, color .055s linear; }
.wom-key[data-down="1"] { background: var(--wom-accent); color: #21182d; border-color: var(--wom-accent); }
.wom-debug { font: 10px/1.5 ui-monospace, monospace; background: #1a1522; border: 1px solid var(--wom-border); border-radius: 4px; padding: 6px; max-height: 150px; overflow: auto; white-space: pre-wrap; word-break: break-word; color: #b5adc9; }
.wom-debug-line[data-level="warn"] { color: var(--wom-warn); }
.wom-debug-line[data-level="error"] { color: var(--wom-danger); }
.wom-debug-kv { margin-bottom: 5px; }
.wom-notice { margin: 7px 10px 0; padding: 6px 8px; border-radius: 4px; font-size: 11px; line-height: 1.4; color: #d9d4eb; background: #30273d; border: 1px solid #51425f; }
.wom-notice[data-kind="error"] { color: #ffd7e2; border-color: #ad4c70; background: #402336; }
.wom-notice[data-kind="warn"] { color: #ffe6c0; border-color: #947346; background: #3a302e; }
.wom-notice[data-kind="ok"] { color: #d3ffed; border-color: #457f69; background: #243834; }

.wom-footer { display: grid; grid-template-columns: 1fr 2.08fr; gap: 6px; padding: 8px 10px 11px; background: #21182d; flex: 0 0 auto; }
.${ROOT_CLASS} .wom-action { position: relative; appearance: none; display: flex; flex-direction: column; align-items: center; justify-content: center; height: 62px; overflow: hidden; border: 0; border-radius: 4px; padding: 0 5px; color: #fff; cursor: pointer; transition: filter .27s var(--wom-ease), transform .27s var(--wom-ease), box-shadow .27s var(--wom-ease); }
.wom-action-stop { background-color: #3a7aa6; background-image: url("${MOSAIC}"); background-size: 150px 70px; }
.wom-action-start { background-color: #b91870; background-image: url("${MOSAIC}"); background-size: 150px 70px; }
.${ROOT_CLASS} .wom-action:hover:not(:disabled) { filter: brightness(1.16); box-shadow: 0 4px 12px rgba(0,0,0,.16); }
.${ROOT_CLASS} .wom-action:active:not(:disabled) { transform: scale(.975); filter: brightness(1.05); }
.${ROOT_CLASS} .wom-action:disabled { opacity: .45; cursor: not-allowed; }
.wom-action-label { font-size: 16px; line-height: 1.1; }
.wom-action-hint { margin-top: 1px; color: rgba(255,255,255,.68); font-size: 9px; line-height: 1.1; }
.wom-resize { position: absolute; right: 0; bottom: 0; width: 12px; height: 12px; cursor: nwse-resize; touch-action: none; background: linear-gradient(135deg, transparent 65%, rgba(255,255,255,.35) 65% 73%, transparent 73% 82%, rgba(255,255,255,.35) 82% 90%, transparent 90%); }
.${ROOT_CLASS} button:focus-visible, .${ROOT_CLASS} input:focus-visible { outline: 2px solid #cabdff; outline-offset: 2px; }
.wom-hidden { display: none !important; }
@container (max-width: 350px) {
  .wom-slider-row { grid-template-columns: 55px 39px minmax(0,1fr) 18px; gap: 3px; }
  .wom-slider-wide { grid-template-columns: 75px 43px minmax(0,1fr) 18px; }
  .wom-slider-label, .wom-slider-value, .wom-quick-label, .wom-quick-value, .wom-switch-label { font-size: 11px; }
  .wom-quick-label { min-width: 55px; }
  .wom-quick-grid { padding-left: 12px; padding-right: 12px; }
  .wom-metrics { grid-template-columns: repeat(2, minmax(0,1fr)); }
}
@media (prefers-reduced-motion: reduce) {
  .${ROOT_CLASS}, .${ROOT_CLASS} *, .${ROOT_CLASS} *::before, .${ROOT_CLASS} *::after { animation-duration: .01ms !important; animation-iteration-count: 1 !important; transition-duration: .01ms !important; transition-delay: 0ms !important; scroll-behavior: auto !important; }
}
`;
}

export function ensureStyle(doc: Document, accent: string): HTMLStyleElement {
  let style = doc.getElementById(STYLE_ID) as HTMLStyleElement | null;
  if (!style) {
    style = doc.createElement("style");
    style.id = STYLE_ID;
    style.textContent = buildCss(accent);
    (doc.head ?? doc.documentElement).appendChild(style);
  } else {
    style.textContent = buildCss(accent);
  }
  return style;
}

export const PANEL_TITLE = NAME;
