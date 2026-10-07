/**
 * Minimal typed event emitter.
 *
 * Used for the engine lifecycle so the UI, guards and detection layer can
 * react without holding direct references to each other (and without leaking
 * listeners — `off` returns are tracked so teardown is complete).
 */

type Handler<T> = (payload: T) => void;

/**
 * `Events` is a map of event name -> payload type. The constraint is left open
 * (rather than `extends Record<string, unknown>`) so plain interfaces satisfy
 * it without needing an index signature.
 */
export class Emitter<Events> {
  private map = new Map<keyof Events, Set<Handler<any>>>();
  private disposers: Array<() => void> = [];

  on<K extends keyof Events>(type: K, handler: Handler<Events[K]>): () => void {
    let set = this.map.get(type);
    if (!set) {
      set = new Set();
      this.map.set(type, set);
    }
    set.add(handler);

    const off = () => this.off(type, handler);
    this.disposers.push(off);
    return off;
  }

  once<K extends keyof Events>(type: K, handler: Handler<Events[K]>): () => void {
    const off = this.on(type, (payload) => {
      off();
      handler(payload);
    });
    return off;
  }

  off<K extends keyof Events>(type: K, handler: Handler<Events[K]>): void {
    this.map.get(type)?.delete(handler);
  }

  emit<K extends keyof Events>(type: K, payload: Events[K]): void {
    const set = this.map.get(type);
    if (!set || set.size === 0) return;
    // Copy first: a handler may unsubscribe during emit.
    for (const handler of Array.from(set)) {
      try {
        handler(payload);
      } catch (err) {
        // A broken subscriber must never take the engine down.
        console.error(`[Autoplay] emitter error on "${String(type)}"`, err);
      }
    }
  }

  /** Remove every listener registered through this emitter. */
  dispose(): void {
    for (const off of this.disposers) {
      try {
        off();
      } catch {
        /* already gone */
      }
    }
    this.disposers.length = 0;
    this.map.clear();
  }

  listenerCount<K extends keyof Events>(type: K): number {
    return this.map.get(type)?.size ?? 0;
  }
}
