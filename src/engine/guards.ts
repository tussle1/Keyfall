import { STUCK_KEY_TIMEOUT } from "../constants";
import type { GameLike } from "../types";

/**
 * Safety guards.
 *
 * The single hard requirement this module exists to satisfy: **never leave a
 * key stuck**, under any failure mode — tab hidden, game disposed mid-hold,
 * beatmap changed, chart data lost, an exception in the input path, or the
 * user closing the tab.
 *
 * Every guard here is independent and idempotent, and every one of them routes
 * to the same `onPanic` callback so the engine performs one safe shutdown.
 */

export interface GuardHooks {
  /** Release all held keys right now. Must be safe to call at any time. */
  releaseAll: () => void;
  /** Full safe shutdown with a user-visible reason. */
  onPanic: (reason: string) => void;
  /** Cheap liveness probe: is the detected game still the live one? */
  isGameAlive: () => boolean;
  /** Current chart time, or null when unknown. */
  chartTime: () => number | null;
  /** Currently held columns, for the stuck-key watchdog. */
  heldColumns: () => number[];
  /** When each held column was pressed, in chart time. */
  heldSince: () => Map<number, number>;
  log?: (message: string) => void;
}

export interface GuardOptions {
  /** How often the watchdog runs. Deliberately slow — it is a backstop. */
  watchdogInterval?: number;
  /** A hold longer than this with no scheduled release is considered stuck. */
  stuckKeyTimeout?: number;
  win?: Window;
}

export class Guards {
  private hooks: GuardHooks;
  private opts: Required<Omit<GuardOptions, "win">> & { win: Window };
  private watchdogHandle: number | null = null;
  private installed = false;
  private disposers: Array<() => void> = [];

  /** Consecutive failed liveness probes before we escalate. */
  private deadProbeCount = 0;
  private static readonly DEAD_PROBE_LIMIT = 3;

  constructor(hooks: GuardHooks, options: GuardOptions = {}) {
    this.hooks = hooks;
    const win = options.win ?? window;
    this.opts = {
      watchdogInterval: options.watchdogInterval ?? 500,
      stuckKeyTimeout: options.stuckKeyTimeout ?? STUCK_KEY_TIMEOUT,
      win,
    };
  }

  /** Install every guard. Idempotent. */
  install(): void {
    if (this.installed) return;
    this.installed = true;
    const win = this.opts.win;

    // Tab hidden: the site pauses itself on `visibilitychange`, and background
    // tabs get their timers throttled, which would wreck scheduling. Release
    // keys and let the engine pause cleanly.
    this.add(
      win.document,
      "visibilitychange",
      () => {
        if (win.document.hidden) {
          this.hooks.log?.("tab hidden — releasing keys");
          this.hooks.releaseAll();
          this.hooks.onPanic("Tab hidden");
        }
      },
      { passive: true },
    );

    // Navigating away or closing the tab: browsers do not reliably fire keyup
    // for synthetic presses, and a held key can survive into the next page in
    // some configurations. Release on the way out.
    this.add(win, "pagehide", () => this.hooks.releaseAll());
    this.add(win, "beforeunload", () => this.hooks.releaseAll());

    // Losing focus means real keyup events will never arrive for keys the user
    // physically held, and our own scheduling is no longer trustworthy.
    this.add(win, "blur", () => {
      this.hooks.log?.("window blurred — releasing keys");
      this.hooks.releaseAll();
    });

    // Any uncaught error anywhere in the tool: stop safely rather than
    // continue driving input from a possibly inconsistent state.
    const onError = (event: ErrorEvent) => {
      const message = event?.message ?? "Unknown error";
      // Only react to our own errors; the host page's errors are not ours to
      // handle, and panicking on them would be rude.
      if (typeof event?.filename === "string" && event.filename.length > 0) {
        // Injected scripts usually report the page URL or a blob/inline source.
        // We cannot reliably attribute, so we log and only panic if the engine
        // is actively running and the game is gone.
        this.hooks.log?.(`window error observed: ${message}`);
        if (!this.hooks.isGameAlive()) {
          this.hooks.onPanic(`Uncaught error: ${message}`);
        }
        return;
      }
      this.hooks.onPanic(`Uncaught error: ${message}`);
    };
    this.add(win, "error", onError as EventListener);

    this.add(win, "unhandledrejection", ((event: PromiseRejectionEvent) => {
      this.hooks.log?.(`unhandled rejection: ${String(event?.reason)?.slice(0, 200)}`);
    }) as EventListener);

    this.startWatchdog();
  }

  /** Start the slow backstop loop. Only runs while installed. */
  startWatchdog(): void {
    if (this.watchdogHandle !== null) return;
    this.watchdogHandle = setInterval(() => this.tick(), this.opts.watchdogInterval) as unknown as number;
  }

  stopWatchdog(): void {
    if (this.watchdogHandle !== null) {
      clearInterval(this.watchdogHandle);
      this.watchdogHandle = null;
    }
  }

  private tick(): void {
    if (!this.installed) return;

    // 1. Liveness: did the game go away (closed, retried, disposed)?
    if (!this.hooks.isGameAlive()) {
      this.deadProbeCount++;
      if (this.deadProbeCount >= Guards.DEAD_PROBE_LIMIT) {
        this.deadProbeCount = 0;
        this.hooks.releaseAll();
        this.hooks.onPanic("Gameplay ended");
      }
      return;
    }
    this.deadProbeCount = 0;

    // 2. Stuck keys: held far longer than any real hold note, with the chart
    //    clock still advancing (so it is not merely a pause).
    const chartTime = this.hooks.chartTime();
    if (chartTime === null) return;

    const heldSince = this.hooks.heldSince();
    if (heldSince.size === 0) return;

    for (const [column, since] of heldSince) {
      const heldFor = chartTime - since;
      if (heldFor > this.opts.stuckKeyTimeout) {
        this.hooks.log?.(
          `column ${column} held ${heldFor.toFixed(0)}ms with no release — forcing`,
        );
        this.hooks.releaseAll();
        this.hooks.onPanic(`Stuck key detected on column ${column + 1}`);
        return;
      }
    }
  }

  private add(
    target: EventTarget,
    type: string,
    handler: EventListener,
    options?: AddEventListenerOptions,
  ): void {
    try {
      target.addEventListener(type, handler, options);
      this.disposers.push(() => {
        try {
          target.removeEventListener(type, handler, options);
        } catch {
          /* already detached */
        }
      });
    } catch (err) {
      this.hooks.log?.(`could not install "${type}" guard: ${String(err)}`);
    }
  }

  /** Remove every listener this module added. No stale listeners remain. */
  dispose(): void {
    this.stopWatchdog();
    for (const dispose of this.disposers.splice(0)) {
      dispose();
    }
    this.installed = false;
  }
}

/**
 * Cross-check our view of held keys against the site's own.
 *
 * `game.inputSystem.pressedColumns` is the site's authoritative record of what
 * it believes is down. If we think a column is up but the site thinks it is
 * down (or vice versa) for several consecutive checks, our input path has
 * desynced — most likely because the keybinds changed mid-run — and continuing
 * would produce garbage. Returns a recommended action rather than acting, so
 * the caller stays in control.
 */
export function verifyInputState(
  game: GameLike | null,
  ourHeldColumns: Set<number>,
): { ok: boolean; stuckInSite: number[]; stuckInOurs: number[] } {
  const pressed = game?.inputSystem?.pressedColumns;
  if (!Array.isArray(pressed)) {
    return { ok: true, stuckInSite: [], stuckInOurs: [] };
  }

  const stuckInSite: number[] = [];
  const stuckInOurs: number[] = [];

  for (let column = 0; column < pressed.length; column++) {
    const siteSaysDown = pressed[column] === true;
    const weSayDown = ourHeldColumns.has(column);
    if (siteSaysDown && !weSayDown) stuckInSite.push(column);
    if (!siteSaysDown && weSayDown) stuckInOurs.push(column);
  }

  return { ok: stuckInSite.length === 0 && stuckInOurs.length === 0, stuckInSite, stuckInOurs };
}
