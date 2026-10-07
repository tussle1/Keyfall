import { humanizeCode } from "../util/helpers";
import { el, setText } from "./dom";

/**
 * Keyboard visualiser.
 *
 * Renders one cell per column showing the bound key, and lights a cell while
 * that column is held. It reflects the *automation's* state (what we actually
 * dispatched), which is the useful thing to watch: if a cell is lit but the
 * game's own receptor is not, the mapping is wrong.
 *
 * Cells are created once per key-count change and then only their `data-down`
 * attribute is toggled, so a dense 10K stream costs a handful of attribute
 * writes and no layout thrash.
 */

export class KeyboardView {
  public readonly root: HTMLElement;
  private cells: HTMLElement[] = [];
  private labels: HTMLElement[] = [];
  private keyCount = 0;

  constructor() {
    this.root = el("div", { className: "wom-keys", dataset: { part: "keyboard" } });
  }

  /** Rebuild cells when the key count or mapping changes. */
  setMapping(codes: string[], keyCount: number): void {
    if (this.keyCount === keyCount && this.cells.length === keyCount) {
      // Same shape: just refresh the labels.
      for (let i = 0; i < keyCount; i++) {
        setText(this.labels[i], humanizeCode(codes[i] ?? "?"));
      }
      return;
    }

    this.keyCount = keyCount;
    this.root.replaceChildren();
    this.cells = [];
    this.labels = [];

    for (let i = 0; i < keyCount; i++) {
      const label = el("span", { text: humanizeCode(codes[i] ?? "?") });
      const cell = el("div", {
        className: "wom-key",
        dataset: { down: "0", column: String(i) },
        attrs: { title: `Column ${i + 1} → ${codes[i] ?? "unbound"}` },
      }, [label]);

      // Very wide charts: shrink the font so 18K still fits.
      if (keyCount > 10) cell.style.fontSize = "8.5px";
      if (keyCount > 14) cell.style.height = "24px";

      this.cells.push(cell);
      this.labels.push(label);
      this.root.appendChild(cell);
    }
  }

  /**
   * Light the held columns.
   * `held` is a Set so lookups are O(1); we only write attributes that changed.
   */
  setHeld(held: Set<number>): void {
    for (let i = 0; i < this.cells.length; i++) {
      const cell = this.cells[i];
      const want = held.has(i) ? "1" : "0";
      if (cell.dataset.down !== want) cell.dataset.down = want;
    }
  }

  clear(): void {
    for (const cell of this.cells) {
      if (cell.dataset.down !== "0") cell.dataset.down = "0";
    }
  }

  setVisible(visible: boolean): void {
    this.root.classList.toggle("wom-hidden", !visible);
  }

  dispose(): void {
    this.root.replaceChildren();
    this.cells = [];
    this.labels = [];
    this.keyCount = 0;
  }
}
