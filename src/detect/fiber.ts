import type { GameLike } from "../types";

/**
 * React fiber traversal.
 *
 * Web osu!mania is a React (TanStack Start) app. Its live `Game` instance is
 * held in component state, not on `window` — but the site *does* expose
 * `window.__PIXI_APP__` while a game is running (it sets that for the Pixi
 * devtools extension). That Pixi application owns the canvas, and the canvas
 * is a DOM node, and every DOM node React renders carries a fiber pointer.
 *
 * So: __PIXI_APP__ -> canvas -> fiber -> walk up -> find the Game.
 *
 * Everything here is shape-based, never name-based. We look for "an object
 * that quacks like the game", so a rename or a restructure of the site's
 * components does not break us.
 */

interface Fiber {
  child?: Fiber | null;
  sibling?: Fiber | null;
  return?: Fiber | null;
  alternate?: Fiber | null;
  stateNode?: unknown;
  memoizedState?: unknown;
  memoizedProps?: unknown;
}

const FIBER_KEY_CACHE: { prefix: string | null } = { prefix: null };

/** React keys its fiber off DOM nodes with `__reactFiber$<random>`. */
function fiberKey(node: Element): string | null {
  if (FIBER_KEY_CACHE.prefix) {
    const cached = FIBER_KEY_CACHE.prefix;
    if (cached in node) return cached;
  }
  for (const key of Object.keys(node)) {
    if (key.startsWith("__reactFiber$")) {
      FIBER_KEY_CACHE.prefix = key;
      return key;
    }
  }
  return null;
}

/**
 * Does this object look like the site's live `Game`?
 *
 * Requires the handful of fields the engine actually depends on, so we never
 * latch onto a half-constructed instance or some unrelated object.
 */
export function looksLikeGame(value: unknown): value is GameLike {
  if (!value || typeof value !== "object") return false;
  const g = value as Record<string, unknown>;

  const hasHitObjects = Array.isArray(g.hitObjects);
  const hasDifficulty =
    !!g.difficulty &&
    typeof g.difficulty === "object" &&
    typeof (g.difficulty as any).keyCount === "number";
  const hasClock = typeof g.timeElapsed === "number";
  const hasInput = !!g.inputSystem && typeof g.inputSystem === "object";
  const hasState = typeof g.state === "string";

  // Minimum viable contract.
  return hasHitObjects && hasDifficulty && hasClock && (hasInput || hasState);
}

/** Scan a hook chain (`memoizedState` linked list) for a Game. */
function scanHookChain(head: unknown, depthLimit = 64): GameLike | null {
  let hook = head as { memoizedState?: unknown; next?: unknown } | null;
  let depth = 0;

  while (hook && depth < depthLimit) {
    depth++;
    const candidate = hook.memoizedState;
    const found = scanValue(candidate, 3);
    if (found) return found;
    hook = hook.next as typeof hook;
  }
  return null;
}

/**
 * Shallow, cycle-safe scan of a value for a Game.
 * Only descends a couple of levels: hooks store either the object directly or
 * a `[value, setter]` pair, so deep traversal would be wasted work.
 */
function scanValue(value: unknown, depth: number): GameLike | null {
  if (!value || depth < 0) return null;
  if (typeof value !== "object") return null;
  if (looksLikeGame(value)) return value as GameLike;

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = scanValue(item, depth - 1);
      if (found) return found;
    }
    return null;
  }

  // Don't wander into DOM nodes, Pixi objects or React elements.
  if (value instanceof Element) return null;
  const ctorName = (value as any).constructor?.name;
  if (ctorName && /^(Object|Array)$/.test(ctorName) === false) {
    // Still allow a Game subclass, but skip obvious non-plain containers.
    if (!looksLikeGame(value)) return null;
  }

  for (const key of Object.keys(value as Record<string, unknown>)) {
    if (key.startsWith("_") || key === "current" || key === "parent") continue;
    const found = scanValue((value as any)[key], depth - 1);
    if (found) return found;
  }
  return null;
}

/** Walk a fiber subtree breadth-first-ish with a node budget. */
function scanFiberSubtree(root: Fiber, budget = 4000): GameLike | null {
  const stack: Fiber[] = [root];
  let visited = 0;

  while (stack.length > 0 && visited < budget) {
    const fiber = stack.pop()!;
    visited++;

    const fromHooks = scanHookChain(fiber.memoizedState);
    if (fromHooks) return fromHooks;

    const fromStateNode = scanValue(fiber.stateNode, 2);
    if (fromStateNode) return fromStateNode;

    const fromProps = scanValue(fiber.memoizedProps, 2);
    if (fromProps) return fromProps;

    if (fiber.child) stack.push(fiber.child);
    if (fiber.sibling) stack.push(fiber.sibling);
  }
  return null;
}

/**
 * Given any DOM node rendered by the app, find the live Game instance.
 * Walks *up* to the root first, then scans down, because the Game lives in a
 * component above the canvas.
 */
export function findGameFromElement(element: Element | null): GameLike | null {
  if (!element) return null;

  const key = fiberKey(element);
  if (!key) return null;

  let fiber = (element as any)[key] as Fiber | undefined;
  if (!fiber) return null;

  // Climb to the root so the downward scan can see the whole tree.
  const seen = new Set<Fiber>();
  let guard = 0;
  while (fiber.return && guard < 512 && !seen.has(fiber)) {
    seen.add(fiber);
    fiber = fiber.return;
    guard++;
  }

  // Prefer the current tree over the work-in-progress alternate.
  return scanFiberSubtree(fiber) ?? (fiber.alternate ? scanFiberSubtree(fiber.alternate) : null);
}

/**
 * Primary acquisition path: use the site's own devtools global.
 * Returns null cleanly when no game is running (the site nulls it on dispose).
 */
export function findGameViaPixiGlobal(win: Window = window): GameLike | null {
  const app = (win as any).__PIXI_APP__;
  if (!app) return null;

  const canvas: HTMLCanvasElement | undefined = app.canvas ?? app.view;
  if (!canvas || !(canvas instanceof Element)) return null;

  // The canvas may not be React-managed if it was moved; fall back to its parent.
  return findGameFromElement(canvas) ?? findGameFromElement(canvas.parentElement);
}
