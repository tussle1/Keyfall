import { NAME } from "../constants";

/**
 * All styling lives in one injected <style> element.
 *
 * Scoped under a single root class so the site's Tailwind stylesheet can never
 * leak into the overlay (and ours can never leak out). No external fonts, no
 * images, no CSS that depends on site markup.
 */

export const ROOT_CLASS = "wom-ap-root";
export const STYLE_ID = "wom-ap-style";

export function buildCss(accent: string): string {
  return `
.${ROOT_CLASS} {
  --wom-accent: ${accent};
  --wom-bg: rgba(16, 17, 23, 0.86);
  --wom-bg-solid: #101117;
  --wom-panel: rgba(255, 255, 255, 0.045);
  --wom-border: rgba(255, 255, 255, 0.09);
  --wom-text: #e8e9ef;
  --wom-muted: #9a9cab;
  --wom-dim: #6b6d7b;
  --wom-danger: #ff5470;
  --wom-ok: #3ddc97;
  --wom-warn: #ffc857;
  --wom-radius: 12px;
  --wom-scale: 1;

  position: fixed;
  z-index: 2147483000;
  font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto,
    "Helvetica Neue", Arial, sans-serif;
  font-size: 12px;
  line-height: 1.45;
  color: var(--wom-text);
  -webkit-font-smoothing: antialiased;
  user-select: none;
  -webkit-user-select: none;
}

.${ROOT_CLASS} *, .${ROOT_CLASS} *::before, .${ROOT_CLASS} *::after {
  box-sizing: border-box;
  font-family: inherit;
}

.wom-panel {
  width: 100%;
  background: var(--wom-bg);
  backdrop-filter: blur(14px) saturate(140%);
  -webkit-backdrop-filter: blur(14px) saturate(140%);
  border: 1px solid var(--wom-border);
  border-radius: var(--wom-radius);
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.55), 0 0 0 1px rgba(0,0,0,0.25);
  overflow: hidden;
  display: flex;
  flex-direction: column;
  transition: opacity 140ms ease, box-shadow 140ms ease;
}

.wom-panel:hover { box-shadow: 0 14px 46px rgba(0,0,0,0.62), 0 0 0 1px var(--wom-accent); }

/* ---------------- header ---------------- */
.wom-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 9px 10px;
  cursor: grab;
  background: linear-gradient(180deg, rgba(255,255,255,0.05), rgba(255,255,255,0));
  border-bottom: 1px solid var(--wom-border);
  touch-action: none;
}
.wom-header:active { cursor: grabbing; }

.wom-dot {
  width: 7px; height: 7px; border-radius: 50%;
  background: var(--wom-dim);
  flex: 0 0 auto;
  transition: background 160ms ease, box-shadow 160ms ease;
}
.wom-dot[data-phase="RUNNING"] { background: var(--wom-ok); box-shadow: 0 0 8px var(--wom-ok); }
.wom-dot[data-phase="READY"]   { background: var(--wom-accent); }
.wom-dot[data-phase="PAUSED"]  { background: var(--wom-warn); }
.wom-dot[data-phase="ERROR"]   { background: var(--wom-danger); box-shadow: 0 0 8px var(--wom-danger); }
.wom-dot[data-phase="DETECTING"] { background: var(--wom-dim); animation: wom-pulse 1.1s ease-in-out infinite; }

@keyframes wom-pulse { 0%,100% { opacity: .35 } 50% { opacity: 1 } }

.wom-title {
  font-weight: 650;
  letter-spacing: 0.02em;
  font-size: 11.5px;
  text-transform: uppercase;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  flex: 1 1 auto;
}

.wom-icon-btn {
  background: transparent;
  border: 1px solid transparent;
  color: var(--wom-muted);
  width: 20px; height: 20px;
  border-radius: 6px;
  display: grid; place-items: center;
  cursor: pointer;
  padding: 0;
  font-size: 13px;
  line-height: 1;
  flex: 0 0 auto;
  transition: background 120ms ease, color 120ms ease, border-color 120ms ease;
}
.wom-icon-btn:hover { background: var(--wom-panel); color: var(--wom-text); border-color: var(--wom-border); }

/* ---------------- body ---------------- */
.wom-body {
  padding: 10px;
  display: flex;
  flex-direction: column;
  gap: 9px;
  overflow-y: auto;
  overflow-x: hidden;
  scrollbar-width: thin;
  scrollbar-color: rgba(255,255,255,0.16) transparent;
}
.wom-body::-webkit-scrollbar { width: 8px; }
.wom-body::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.16); border-radius: 8px; }
.wom-body::-webkit-scrollbar-track { background: transparent; }

.wom-collapsed .wom-body, .wom-collapsed .wom-resize { display: none; }

/* ---------------- status ---------------- */
.wom-status {
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
  padding: 7px 9px;
  background: var(--wom-panel);
  border: 1px solid var(--wom-border);
  border-radius: 9px;
}
.wom-status-label { color: var(--wom-muted); font-size: 10.5px; text-transform: uppercase; letter-spacing: .06em; }
.wom-status-value { font-weight: 650; font-variant-numeric: tabular-nums; }
.wom-status-value[data-phase="RUNNING"] { color: var(--wom-ok); }
.wom-status-value[data-phase="ERROR"] { color: var(--wom-danger); }
.wom-status-value[data-phase="PAUSED"] { color: var(--wom-warn); }
.wom-status-value[data-phase="READY"] { color: var(--wom-accent); }

.wom-map { color: var(--wom-muted); font-size: 11px; word-break: break-word; }
.wom-map b { color: var(--wom-text); font-weight: 600; }

/* ---------------- buttons ---------------- */
.wom-buttons { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; }

.wom-btn {
  appearance: none;
  border: 1px solid var(--wom-border);
  background: var(--wom-panel);
  color: var(--wom-text);
  border-radius: 8px;
  padding: 7px 4px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: .04em;
  cursor: pointer;
  transition: background 120ms ease, border-color 120ms ease, transform 60ms ease, opacity 120ms ease;
}
.wom-btn:hover:not(:disabled) { background: rgba(255,255,255,0.09); border-color: rgba(255,255,255,0.18); }
.wom-btn:active:not(:disabled) { transform: translateY(1px); }
.wom-btn:disabled { opacity: .38; cursor: not-allowed; }

/* Selected state for a small toggle group (e.g. the distribution picker). */
.wom-btn-active {
  border-color: color-mix(in srgb, var(--wom-accent) 55%, transparent);
  background: color-mix(in srgb, var(--wom-accent) 16%, transparent);
  color: var(--wom-text);
}

/* Free-text field (the humanization seed). Same metrics as .wom-btn so a row
   mixing a field and a button lines up. */
.wom-text {
  flex: 1 1 auto;
  min-width: 0;
  padding: 4px 7px;
  border-radius: 6px;
  border: 1px solid var(--wom-border);
  background: rgba(0,0,0,0.28);
  color: var(--wom-text);
  font: inherit;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}
.wom-text:focus {
  outline: none;
  border-color: color-mix(in srgb, var(--wom-accent) 55%, transparent);
}

.wom-btn[data-kind="start"] { border-color: color-mix(in srgb, var(--wom-accent) 45%, transparent); }
.wom-btn[data-kind="start"]:hover:not(:disabled) { background: color-mix(in srgb, var(--wom-accent) 20%, transparent); }

.wom-btn-stop {
  grid-column: 1 / -1;
  background: linear-gradient(180deg, rgba(255,84,112,0.22), rgba(255,84,112,0.12));
  border: 1px solid rgba(255,84,112,0.5);
  color: #ffd7de;
  padding: 11px 4px;
  font-size: 13px;
  font-weight: 800;
  letter-spacing: .16em;
  text-transform: uppercase;
}
.wom-btn-stop:hover:not(:disabled) {
  background: linear-gradient(180deg, rgba(255,84,112,0.38), rgba(255,84,112,0.2));
  border-color: var(--wom-danger);
}

.wom-hint { color: var(--wom-dim); font-size: 10px; text-align: center; margin-top: -3px; }

/* ---------------- metrics ---------------- */
.wom-metrics { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
.wom-metric {
  background: var(--wom-panel);
  border: 1px solid var(--wom-border);
  border-radius: 8px;
  padding: 6px 8px;
  min-width: 0;
}
.wom-metric-k { color: var(--wom-muted); font-size: 9.5px; text-transform: uppercase; letter-spacing: .07em; white-space: nowrap; }
.wom-metric-v { font-size: 13px; font-weight: 650; font-variant-numeric: tabular-nums; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

/* ---------------- keyboard ---------------- */
.wom-keys {
  display: flex;
  gap: 3px;
  align-items: stretch;
  justify-content: center;
  flex-wrap: nowrap;
}
.wom-key {
  flex: 1 1 0;
  min-width: 0;
  height: 30px;
  display: grid;
  place-items: center;
  border-radius: 6px;
  border: 1px solid var(--wom-border);
  background: rgba(255,255,255,0.035);
  color: var(--wom-muted);
  font-size: 10px;
  font-weight: 700;
  letter-spacing: .02em;
  transition: background 55ms linear, color 55ms linear, box-shadow 55ms linear, transform 55ms linear;
  overflow: hidden;
}
.wom-key[data-down="1"] {
  background: var(--wom-accent);
  color: #14141a;
  border-color: var(--wom-accent);
  box-shadow: 0 0 12px color-mix(in srgb, var(--wom-accent) 60%, transparent);
  transform: translateY(1px);
}

/* ---------------- sliders / rows ---------------- */
.wom-row { display: flex; align-items: center; gap: 8px; }
.wom-row-label { color: var(--wom-muted); font-size: 10.5px; flex: 0 0 auto; min-width: 74px; }
.wom-row-value { font-variant-numeric: tabular-nums; font-size: 10.5px; color: var(--wom-text); flex: 0 0 auto; min-width: 46px; text-align: right; }

.wom-range {
  -webkit-appearance: none; appearance: none;
  flex: 1 1 auto; min-width: 0;
  height: 16px; background: transparent; cursor: pointer;
}
.wom-range::-webkit-slider-runnable-track { height: 3px; border-radius: 3px; background: rgba(255,255,255,0.15); }
.wom-range::-moz-range-track { height: 3px; border-radius: 3px; background: rgba(255,255,255,0.15); }
.wom-range::-webkit-slider-thumb {
  -webkit-appearance: none; appearance: none;
  width: 11px; height: 11px; border-radius: 50%;
  background: var(--wom-accent); margin-top: -4px;
  border: none; box-shadow: 0 0 0 2px rgba(0,0,0,0.35);
}
.wom-range::-moz-range-thumb {
  width: 11px; height: 11px; border-radius: 50%;
  background: var(--wom-accent); border: none;
}

.wom-check { display: flex; align-items: center; gap: 7px; cursor: pointer; padding: 3px 0; }
.wom-check input { accent-color: var(--wom-accent); width: 13px; height: 13px; cursor: pointer; margin: 0; }
.wom-check span { font-size: 11px; color: var(--wom-text); }

.wom-section { border-top: 1px solid var(--wom-border); padding-top: 8px; margin-top: 1px; }
.wom-section-title {
  color: var(--wom-dim); font-size: 9.5px; font-weight: 700;
  text-transform: uppercase; letter-spacing: .1em; margin-bottom: 6px;
}

.wom-toggle-btn {
  background: transparent; border: 1px solid var(--wom-border);
  color: var(--wom-muted); border-radius: 7px; padding: 4px 8px;
  font-size: 10px; cursor: pointer; transition: color 120ms, border-color 120ms;
}
.wom-toggle-btn:hover { color: var(--wom-text); border-color: rgba(255,255,255,0.2); }
.wom-toggle-btn[aria-pressed="true"] { color: var(--wom-accent); border-color: color-mix(in srgb, var(--wom-accent) 50%, transparent); }

/* ---------------- mapping editor ---------------- */
.wom-map-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(48px, 1fr)); gap: 4px; }
.wom-map-cell {
  background: var(--wom-panel); border: 1px solid var(--wom-border);
  border-radius: 6px; padding: 4px 2px; text-align: center; cursor: pointer;
  font-size: 10px; font-weight: 700; color: var(--wom-muted);
  transition: border-color 120ms, color 120ms;
}
.wom-map-cell:hover { border-color: rgba(255,255,255,0.22); color: var(--wom-text); }
.wom-map-cell[data-listening="1"] { border-color: var(--wom-accent); color: var(--wom-accent); }
.wom-map-cell[data-source="site"] { color: var(--wom-text); }
.wom-map-index { display: block; font-size: 8px; color: var(--wom-dim); font-weight: 600; }

/* ---------------- hotkey editor ---------------- */
.wom-hotkey { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 3px 0; }
.wom-hotkey-name { font-size: 11px; color: var(--wom-muted); }
.wom-hotkey-key {
  background: var(--wom-panel); border: 1px solid var(--wom-border);
  border-radius: 6px; padding: 2px 8px; font-size: 10px; font-weight: 700;
  color: var(--wom-text); cursor: pointer; min-width: 44px; text-align: center;
}
.wom-hotkey-key[data-listening="1"] { border-color: var(--wom-accent); color: var(--wom-accent); }

/* ---------------- debug ---------------- */
.wom-debug {
  font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
  font-size: 10px;
  line-height: 1.5;
  background: rgba(0,0,0,0.42);
  border: 1px solid var(--wom-border);
  border-radius: 8px;
  padding: 6px 7px;
  max-height: 168px;
  overflow-y: auto;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--wom-muted);
  scrollbar-width: thin;
}
.wom-debug-line[data-level="warn"] { color: var(--wom-warn); }
.wom-debug-line[data-level="error"] { color: var(--wom-danger); }
.wom-debug-line[data-level="info"] { color: #b9bcc9; }
.wom-debug-kv { color: var(--wom-dim); }
.wom-debug-kv b { color: var(--wom-accent); font-weight: 600; }

/* ---------------- toast / notices ---------------- */
.wom-notice {
  padding: 7px 9px; border-radius: 8px; font-size: 10.5px; line-height: 1.4;
  border: 1px solid var(--wom-border); background: var(--wom-panel); color: var(--wom-muted);
}
.wom-notice[data-kind="error"] { border-color: rgba(255,84,112,0.45); background: rgba(255,84,112,0.1); color: #ffd7de; }
.wom-notice[data-kind="warn"]  { border-color: rgba(255,200,87,0.4);  background: rgba(255,200,87,0.09); color: #ffeec2; }
.wom-notice[data-kind="ok"]    { border-color: rgba(61,220,151,0.4);  background: rgba(61,220,151,0.09); color: #ccffe9; }

/* ---------------- resize handle ---------------- */
.wom-resize {
  position: absolute; right: 0; bottom: 0;
  width: 16px; height: 16px; cursor: nwse-resize;
  touch-action: none;
  background:
    linear-gradient(135deg, transparent 0 50%, rgba(255,255,255,0.22) 50% 60%, transparent 60% 72%, rgba(255,255,255,0.22) 72% 82%, transparent 82%);
  border-bottom-right-radius: var(--wom-radius);
}

/* ---------------- mini (collapsed) ---------------- */
.wom-mini {
  display: none;
  align-items: center; gap: 7px;
  padding: 7px 10px; cursor: grab; touch-action: none;
}
.wom-collapsed .wom-mini { display: flex; }
.wom-collapsed .wom-header { display: none; }
.wom-mini-label { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .07em; color: var(--wom-muted); }
.wom-mini-phase { font-size: 10px; font-weight: 700; font-variant-numeric: tabular-nums; }

.wom-hidden { display: none !important; }

@media (max-width: 520px) {
  .${ROOT_CLASS} { font-size: 11px; }
  .wom-metrics { grid-template-columns: 1fr; }
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
