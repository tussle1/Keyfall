import { NAME, VERSION } from "./constants";
import { SettingsManager } from "./core/settings";
import { Engine, SAFE_STOP_MESSAGE } from "./engine/engine";
import { installOszSniffer, isSnifferInstalled } from "./detect/chartSource";
import { NOT_DETECTED_MESSAGE } from "./detect/siteDetection";
import { HotkeyManager } from "./hotkeys";
import { Overlay } from "./ui/overlay";
import { ensureStyle } from "./ui/styles";
import { formatTime, humanizeCode } from "./util/helpers";
import type { EngineStats, HotkeyAction } from "./types";

/**
 * Entry point.
 *
 * Wires detection, engine, overlay and hotkeys together, and exposes a small
 * console API for manual control and diagnostics:
 *
 *   window.WebOsuManiaAutoplay.start()
 *   window.WebOsuManiaAutoplay.stop()
 *   window.WebOsuManiaAutoplay.diagnostics()
 *   window.WebOsuManiaAutoplay.uninstall()
 */

const GLOBAL_NAME = "WebOsuManiaAutoplay";
const INSTANCE_FLAG = "__womAutoplayInstalled__";

interface Bootstrapped {
  engine: Engine;
  overlay: Overlay | null;
  settings: SettingsManager;
  hotkeys: HotkeyManager;
  uninstall: () => void;
}

function boot(win: Window): Bootstrapped | null {
  // Guard against double injection (bookmarklet pressed twice, userscript
  // re-run after SPA navigation, etc.).
  if ((win as any)[INSTANCE_FLAG]) {
    console.warn(`[${NAME}] already running — use ${GLOBAL_NAME}.uninstall() first`);
    return (win as any)[INSTANCE_FLAG] as Bootstrapped;
  }

  const settings = new SettingsManager(undefined, win);
  const engine = new Engine({ settings, win });

  ensureStyle(win.document, settings.all.appearance.accent);

  let overlay: Overlay | null = null;
  let lastStats: EngineStats | null = null;

  /* ------------------------------ overlay ------------------------------ */

  function mountOverlay(): void {
    if (overlay) return;

    overlay = new Overlay(
      {
        onStart: () => engine.start(),
        onPause: () => (engine.currentPhase === "PAUSED" ? engine.resume() : engine.pause()),
        onStop: () => engine.stop(),
        onEmergency: () => engine.emergencyStop("EMERGENCY STOP (button)"),
        onSettingChange: (next) => engine.applySettings(next),
        onRebindMapping: () => {
          // Force a fresh detection pass so the mapping is re-read.
          engine.init();
        },
        getDiagnostics: () => engine.getDiagnostics(),
      },
      settings,
    );

    win.document.documentElement.appendChild(overlay.root);
  }

  function unmountOverlay(): void {
    overlay?.dispose();
    overlay = null;
  }

  /* ------------------------------ hotkeys ------------------------------ */

  const hotkeys = new HotkeyManager({
    onAction: (action: HotkeyAction) => {
      switch (action) {
        case "toggleUI": {
          const next = !settings.all.general.showOverlay;
          settings.set("general.showOverlay", next);
          break;
        }
        case "start":
          engine.start();
          break;
        case "pause":
          if (engine.currentPhase === "PAUSED") engine.resume();
          else engine.pause();
          break;
        case "stop":
          engine.stop();
          break;
        case "emergency":
          engine.emergencyStop("EMERGENCY STOP");
          break;
      }
    },
    getSiteCodes: () => engine.currentMapping?.codes ?? [],
    onCollision: (collisions) => {
      const list = collisions.map((c) => `${c.action}=${humanizeCode(c.code)}`).join(", ");
      console.warn(
        `[${NAME}] hotkey collision with the site's keybinds: ${list}. ` +
          `Rebind them in the overlay's Input settings.`,
      );
      overlay?.setNotice(
        "warn",
        `Hotkey collision with site keybinds: ${list}. Rebind in Settings → Input.`,
      );
    },
  });

  hotkeys.apply(settings.all);
  hotkeys.install();

  /* --------------------------- fallback sniffer ------------------------- */

  // Read-only observation of beatmap downloads. This is the safety net for
  // chart data if the live game instance ever becomes unreachable; it never
  // modifies a request.
  const uninstallSniffer = installOszSniffer(win, {
    onError: (err) => console.debug(`[${NAME}] sniffer`, err),
  });

  /* ------------------------------ wiring ------------------------------- */

  const offs: Array<() => void> = [];

  offs.push(
    engine.on("phase", ({ phase, reason }) => {
      overlay?.setPhase(phase, reason);
      if (settings.all.general.debug) {
        overlay?.logDebug(phase === "ERROR" ? "error" : "info", `phase -> ${phase}${reason ? ` (${reason})` : ""}`);
      }
      if (phase === "ERROR") {
        console.warn(`[${NAME}] ${reason ?? ""} ${SAFE_STOP_MESSAGE}`.trim());
      }
    }),
  );

  offs.push(
    engine.on("site", (check) => {
      if (check.verdict === "unknown") {
        // Spec: show the exact message when the page is not the target site.
        if (!settings.all.general.showOverlay) return;
        mountOverlay();
        overlay?.setPhase("IDLE");
        overlay?.setChart(null, null, null);
        overlay?.setNotice("error", NOT_DETECTED_MESSAGE);
        console.info(`[${NAME}] ${NOT_DETECTED_MESSAGE}`);
      } else if (check.verdict === "probable") {
        overlay?.setNotice("warn", check.message);
      } else {
        overlay?.clearNotice();
      }
    }),
  );

  offs.push(
    engine.on("detected", ({ chart, keyMapping, analysis, via }) => {
      if (settings.all.general.showOverlay) mountOverlay();
      overlay?.setChart(chart, analysis, keyMapping);
      overlay?.setNotice(
        "ok",
        `${chart.keyCount}K · ${chart.noteCount} notes · ${analysis.taps} taps / ${analysis.holds} holds · peak ${analysis.peakNps} NPS`,
      );
      if (settings.all.general.debug) {
        overlay?.logDebug("info", `chart detected via ${via}`);
        overlay?.logDebug("info", `keys ${chart.keyCount}, notes ${chart.noteCount}, actions ${analysis.chords} chord notes`);
        overlay?.logDebug(
          "info",
          `mapping (${keyMapping.source}): ${keyMapping.codes.map((c) => humanizeCode(c)).join(" ")}`,
        );
      }
      hotkeys.apply(settings.all); // re-check collisions now that codes are known
    }),
  );

  offs.push(
    engine.on("lost", ({ reason }) => {
      overlay?.setChart(null, null, null);
      overlay?.setNotice("warn", reason);
      if (settings.all.general.debug) overlay?.logDebug("warn", reason);
    }),
  );

  offs.push(
    engine.on("stats", (stats) => {
      lastStats = stats;
      overlay?.setStats(stats);
      if (settings.all.general.debug) updateDebugSnapshot();
    }),
  );

  offs.push(
    engine.on("keyState", ({ heldColumns }) => {
      overlay?.setHeldColumns(heldColumns);
    }),
  );

  offs.push(
    engine.on("log", ({ level, message }) => {
      if (settings.all.general.debug) overlay?.logDebug(level, message);
    }),
  );

  offs.push(settings.onChange(() => hotkeys.apply(settings.all)));

  /** Refresh the structured `[DEBUG]` snapshot, throttled by the stats loop. */
  let debugThrottle = 0;
  function updateDebugSnapshot(): void {
    const now = performance.now();
    if (now - debugThrottle < 200) return;
    debugThrottle = now;

    if (!overlay) return;
    const diagnostics = engine.getDiagnostics() as Record<string, any>;
    const next = engine.getNextAction();
    diagnostics.stats = {
      ...(lastStats ?? {}),
      timeElapsed: lastStats?.timeElapsed ?? diagnostics.timeElapsed,
      nextNote: next ? formatTime(next.time) : "—",
      nextColumn: next ? next.column + 1 : "—",
      nextAction: next ? next.type.toUpperCase() : "—",
    };
    overlay.setDebugSnapshot(overlay.buildDebugSnapshot(diagnostics));
  }

  /* ------------------------------- boot -------------------------------- */

  if (settings.all.general.showOverlay) mountOverlay();
  engine.init();

  const uninstall = (): void => {
    try {
      engine.emergencyStop("uninstall");
    } catch {
      /* best effort */
    }
    for (const off of offs.splice(0)) {
      try {
        off();
      } catch {
        /* already gone */
      }
    }
    hotkeys.dispose();
    uninstallSniffer();
    unmountOverlay();
    engine.dispose();
    delete (win as any)[INSTANCE_FLAG];
    delete (win as any)[GLOBAL_NAME];
    console.info(`[${NAME}] uninstalled`);
  };

  const api = {
    engine,
    overlay: null as Overlay | null,
    settings,
    hotkeys,
    uninstall,
    /* convenience surface for the console */
    version: VERSION,
    start: () => engine.start(),
    pause: () => engine.pause(),
    resume: () => engine.resume(),
    stop: () => engine.stop(),
    emergencyStop: () => engine.emergencyStop("EMERGENCY STOP (console)"),
    diagnostics: () => engine.getDiagnostics(),
    stats: () => engine.getStats(),
    get phase() {
      return engine.currentPhase;
    },
    get chart() {
      return engine.currentChart;
    },
    get mapping() {
      return engine.currentMapping;
    },
    get overlayElement() {
      return overlay?.root ?? null;
    },
    get snifferInstalled() {
      return isSnifferInstalled();
    },
    showUI: () => settings.set("general.showOverlay", true),
    hideUI: () => settings.set("general.showOverlay", false),
    setDebug: (on: boolean) => settings.set("general.debug", !!on),
    setOffset: (ms: number) => settings.set("timing.offset", ms),
    resetSettings: () => settings.reset(),
  };

  // Keep `api.overlay` live for console users.
  Object.defineProperty(api, "overlay", { get: () => overlay, enumerable: true });

  (win as any)[GLOBAL_NAME] = api;
  (win as any)[INSTANCE_FLAG] = api;

  console.info(
    `%c${NAME}%c v${VERSION} ready — ${settings.all.input.hotkeys.toggleUI} toggles the UI, ${settings.all.input.hotkeys.emergency} emergency-stops. Console API: ${GLOBAL_NAME}`,
    "color:#ff6b9d;font-weight:700",
    "color:inherit",
  );

  return api as unknown as Bootstrapped;
}

/* ------------------------------- bootstrap ------------------------------ */

function main(): void {
  try {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", () => boot(window), { once: true });
    } else {
      boot(window);
    }
  } catch (err) {
    // Never let the tool take the page down with it.
    console.error(`[${NAME}] failed to start`, err);
    try {
      const note = document.createElement("div");
      note.textContent = `${NAME} failed to start. ${SAFE_STOP_MESSAGE}`;
      note.style.cssText =
        "position:fixed;top:12px;left:12px;z-index:2147483000;background:#101117;color:#ffd7de;" +
        "border:1px solid rgba(255,84,112,.5);border-radius:10px;padding:10px 12px;font:12px system-ui,sans-serif";
      document.documentElement.appendChild(note);
      setTimeout(() => note.remove(), 12000);
    } catch {
      /* nothing else we can do */
    }
  }
}

main();
