import { DEBUG_FLUSH_INTERVAL } from "../constants";
import { el } from "./dom";

/**
 * Debug panel.
 *
 * When debug mode is OFF this does literally nothing: no buffering, no DOM, no
 * timers. That is a hard requirement ("allow debug mode to be disabled
 * completely") — a debug facility that silently costs frames when disabled is
 * worse than none.
 *
 * When ON, log lines are buffered and flushed on a fixed interval rather than
 * per event, because a dense chart produces far more lines than the DOM should
 * be asked to insert.
 */

export interface DebugLine {
  level: "info" | "warn" | "error";
  message: string;
  at: number;
}

const MAX_BUFFERED = 400;
const MAX_RENDERED = 120;

export class DebugPanel {
  public readonly root: HTMLElement;
  private logEl: HTMLElement;
  private kvEl: HTMLElement;

  private enabled = false;
  private buffer: DebugLine[] = [];
  private flushHandle: number | null = null;
  private kvSnapshot = "";

  constructor() {
    this.kvEl = el("div", { className: "wom-debug wom-debug-kv", dataset: { part: "debug-kv" } });
    this.logEl = el("div", { className: "wom-debug", dataset: { part: "debug-log" } });
    this.root = el("div", { className: "wom-section wom-hidden", dataset: { part: "debug" } }, [
      el("div", { className: "wom-section-title", text: "Debug" }),
      this.kvEl,
      this.logEl,
    ]);
  }

  setEnabled(enabled: boolean): void {
    if (enabled === this.enabled) return;
    this.enabled = enabled;
    this.root.classList.toggle("wom-hidden", !enabled);

    if (enabled) {
      this.startFlushing();
    } else {
      this.stopFlushing();
      // Drop everything so a disabled panel holds no memory.
      this.buffer.length = 0;
      this.logEl.replaceChildren();
      this.kvSnapshot = "";
      this.kvEl.textContent = "";
    }
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  push(level: DebugLine["level"], message: string): void {
    if (!this.enabled) return;
    this.buffer.push({ level, message, at: performance.now() });
    if (this.buffer.length > MAX_BUFFERED) {
      this.buffer.splice(0, this.buffer.length - MAX_BUFFERED);
    }
  }

  /** Key/value snapshot lines, e.g. `Keys: 7`, `Next note: 42.201`. */
  setSnapshot(lines: string[]): void {
    if (!this.enabled) return;
    const next = lines.join("\n");
    if (next === this.kvSnapshot) return;
    this.kvSnapshot = next;
    this.kvEl.textContent = next;
  }

  clear(): void {
    this.buffer.length = 0;
    this.logEl.replaceChildren();
  }

  private startFlushing(): void {
    if (this.flushHandle !== null) return;
    this.flushHandle = setInterval(() => this.flush(), DEBUG_FLUSH_INTERVAL) as unknown as number;
  }

  private stopFlushing(): void {
    if (this.flushHandle !== null) {
      clearInterval(this.flushHandle);
      this.flushHandle = null;
    }
  }

  private flush(): void {
    if (!this.enabled || this.buffer.length === 0) return;

    const fragment = document.createDocumentFragment();
    // Render only the newest lines; the buffer keeps more for context.
    const start = Math.max(0, this.buffer.length - MAX_RENDERED);
    for (let i = start; i < this.buffer.length; i++) {
      const line = this.buffer[i];
      fragment.appendChild(
        el("div", {
          className: "wom-debug-line",
          dataset: { level: line.level },
          text: line.message,
        }),
      );
    }

    this.logEl.replaceChildren(fragment);
    this.logEl.scrollTop = this.logEl.scrollHeight;
    this.buffer.length = 0;
  }

  dispose(): void {
    this.stopFlushing();
    this.buffer.length = 0;
    this.root.replaceChildren();
  }
}
