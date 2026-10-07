import { PIXI_APP_GLOBAL } from "../constants";
import type { GameLike } from "../types";
import { findGameFromElement, findGameViaPixiGlobal } from "./fiber";

/**
 * Acquisition strategies, ordered by reliability.
 *
 * Each strategy is independent and returns `GameLike | null`, so a site change
 * that breaks one path leaves the others working. New paths are added by
 * pushing another function onto `STRATEGIES` — nothing else needs to change.
 */

/** Strategy 1: the site's own `window.__PIXI_APP__` devtools global. */
function viaPixiGlobal(win: Window): GameLike | null {
  return findGameViaPixiGlobal(win);
}

/**
 * Strategy 2: scan for the gameplay canvas directly.
 *
 * Works even if the site stops setting the devtools global. The game canvas is
 * appended to a full-screen absolutely-positioned container, which distinguishes
 * it from any decorative canvas elsewhere on the page.
 */
function viaCanvasScan(win: Window): GameLike | null {
  const doc = win.document;
  const canvases = doc.querySelectorAll("canvas");
  if (canvases.length === 0) return null;

  const viewArea = win.innerWidth * win.innerHeight;

  for (const canvas of canvases) {
    const rect = canvas.getBoundingClientRect();
    // The gameplay canvas covers essentially the whole viewport.
    if (rect.width * rect.height < viewArea * 0.5) continue;

    const game = findGameFromElement(canvas);
    if (game) return game;
  }
  return null;
}

/**
 * Strategy 3: probe upward from any element that has a React fiber.
 * Slowest and least targeted; only used when the first two fail.
 * Budgeted so it can never stall the tab.
 */
function viaAnyFiber(win: Window): GameLike | null {
  const doc = win.document;
  // Start from likely containers rather than every element on the page.
  const roots = doc.querySelectorAll("body > div, #root, #app, [data-radix-popper-content-wrapper]");
  for (const root of roots) {
    const game = findGameFromElement(root);
    if (game) return game;
    // One level of children; deeper scans are handled by the subtree walk.
    for (const child of Array.from(root.children).slice(0, 12)) {
      const nested = findGameFromElement(child);
      if (nested) return nested;
    }
  }
  return null;
}

export interface Strategy {
  name: string;
  /** Relative cost; used only for diagnostics ordering. */
  cost: "low" | "medium" | "high";
  run: (win: Window) => GameLike | null;
}

export const STRATEGIES: Strategy[] = [
  { name: "pixiGlobal", cost: "low", run: viaPixiGlobal },
  { name: "canvasScan", cost: "medium", run: viaCanvasScan },
  { name: "fiberProbe", cost: "high", run: viaAnyFiber },
];

/**
 * Try every strategy in order, returning the first hit.
 * Errors in one strategy never prevent the others from running.
 */
export function acquireGame(
  win: Window = window,
): { game: GameLike; via: string } | null {
  // Fast path first: if the global is present we almost certainly win.
  const hasGlobal = (win as any)[PIXI_APP_GLOBAL] != null;

  const ordered = hasGlobal
    ? STRATEGIES
    : // Skip the global strategy when it is known to be absent.
      STRATEGIES.filter((s) => s.name !== "pixiGlobal");

  for (const strategy of ordered) {
    try {
      const game = strategy.run(win);
      if (game) return { game, via: strategy.name };
    } catch (err) {
      // A strategy throwing (e.g. a cross-origin frame, a hostile getter)
      // must not abort detection.
      console.warn(`[Autoplay] strategy "${strategy.name}" failed`, err);
    }
  }
  return null;
}
