/** Tiny DOM helpers shared by the UI modules. */

/**
 * Props accepted by {@link el}.
 *
 * Kept as an intersection of the element's own partial type with our extras so
 * that native IDL properties (`type`, `checked`, `value`, `min`, …) type-check
 * normally. `style` is overridden to also accept a plain CSS string, which is
 * what nearly every call site wants.
 */
export type ElProps<K extends keyof HTMLElementTagNameMap> = Partial<
  HTMLElementTagNameMap[K]
> & {
  className?: string;
  text?: string;
  dataset?: Record<string, string>;
  /**
   * Inline CSS as a string, applied via `style.cssText`.
   *
   * A separate name rather than overriding `style`, because intersecting with
   * `Partial<HTMLElement>` would narrow `style` to
   * `CSSStyleDeclaration & string` and reject plain strings.
   */
  cssText?: string;
  /** Attributes not exposed as IDL properties (e.g. `aria-pressed`, `title`). */
  attrs?: Record<string, string | number | boolean | null | undefined>;
};

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: ElProps<K> = {},
  children: (Node | string | null | undefined)[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  const { className, text, dataset, cssText, attrs, ...rest } = props as Record<string, any>;

  if (className !== undefined) node.className = className;
  if (text !== undefined) node.textContent = text;
  if (cssText !== undefined) node.style.cssText = cssText;
  if (dataset) {
    for (const [k, v] of Object.entries(dataset)) {
      if (v !== undefined && v !== null) node.dataset[k] = String(v);
    }
  }
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v !== undefined && v !== null) node.setAttribute(k, String(v));
    }
  }
  for (const [k, v] of Object.entries(rest)) {
    if (v === undefined || v === null) continue;
    (node as any)[k] = v;
  }
  for (const child of children) {
    if (child === null || child === undefined) continue;
    node.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return node;
}

/** Attach a listener and return its disposer, so teardown is exhaustive. */
export function listen(
  target: EventTarget,
  type: string,
  handler: EventListenerOrEventListenerObject,
  options?: AddEventListenerOptions,
): () => void {
  target.addEventListener(type, handler, options);
  return () => target.removeEventListener(type, handler, options);
}

/**
 * Write text only when it changed.
 *
 * The readout updates several times a second; assigning `textContent`
 * unconditionally forces layout work every time. This keeps DOM writes
 * proportional to actual change.
 */
export function setText(node: HTMLElement | null, value: string): void {
  if (!node || node.textContent === value) return;
  node.textContent = value;
}

export function setDataset(node: HTMLElement | null, key: string, value: string): void {
  if (!node) return;
  if (node.dataset[key] === value) return;
  node.dataset[key] = value;
}

export function setDisabled(node: HTMLButtonElement | null, disabled: boolean): void {
  if (!node || node.disabled === disabled) return;
  node.disabled = disabled;
}

/** Convert "#rrggbb" (+ optional alpha) to an rgba() string. */
export function hexToRgba(hex: string, alpha: number): string {
  let value = hex.replace("#", "").trim();
  if (value.length === 3) {
    value = value
      .split("")
      .map((c) => c + c)
      .join("");
  }
  if (!/^[0-9a-f]{6}([0-9a-f]{2})?$/i.test(value)) {
    return `rgba(255, 107, 157, ${alpha})`;
  }
  const r = parseInt(value.slice(0, 2), 16);
  const g = parseInt(value.slice(2, 4), 16);
  const b = parseInt(value.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
