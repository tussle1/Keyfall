/**
 * Minimal DOM stub.
 *
 * Enough of `document`, `window`, `KeyboardEvent`, `performance` and
 * `localStorage` for the modules that touch the DOM to run under `node --test`.
 * Deliberately tiny: we only exercise our own logic, not a browser engine.
 */

type Listener = (event: any) => void;

export class StubEventTarget {
  private listeners = new Map<string, Set<Listener>>();

  addEventListener(type: string, handler: Listener): void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(handler);
  }

  removeEventListener(type: string, handler: Listener): void {
    this.listeners.get(type)?.delete(handler);
  }

  /** Dispatch, honouring the bubbling chain via `parentNode` when present. */
  dispatchEvent(event: any): boolean {
    const path: StubEventTarget[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let node: any = this;
    while (node) {
      path.push(node);
      node = event.bubbles ? node.parentNode ?? node.__parent ?? null : null;
    }

    for (const target of path) {
      const set = (target as StubEventTarget)["listeners" as keyof StubEventTarget] as
        | Map<string, Set<Listener>>
        | undefined;
      const handlers = set?.get(event.type);
      if (!handlers) continue;
      for (const handler of Array.from(handlers)) {
        handler(event);
        if (event.__propagationStopped) return !event.defaultPrevented;
      }
    }
    return !event.defaultPrevented;
  }

  listenerCount(type: string): number {
    return (this["listeners" as keyof StubEventTarget] as Map<string, Set<Listener>>).get(type)?.size ?? 0;
  }
}

export class StubKeyboardEvent {
  readonly type: string;
  readonly code: string;
  readonly key: string;
  readonly repeat: boolean;
  readonly bubbles: boolean;
  readonly cancelable: boolean;
  readonly composed: boolean;
  readonly location: number;
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
  /** Synthetic events are never trusted, exactly like in a real browser. */
  readonly isTrusted = false;
  defaultPrevented = false;
  __propagationStopped = false;

  constructor(type: string, init: Record<string, unknown> = {}) {
    this.type = type;
    this.code = String(init.code ?? "");
    this.key = String(init.key ?? "");
    this.repeat = Boolean(init.repeat);
    this.bubbles = init.bubbles !== false;
    this.cancelable = Boolean(init.cancelable);
    this.composed = Boolean(init.composed);
    this.location = Number(init.location ?? 0);
    this.altKey = Boolean(init.altKey);
    this.ctrlKey = Boolean(init.ctrlKey);
    this.metaKey = Boolean(init.metaKey);
    this.shiftKey = Boolean(init.shiftKey);
  }

  preventDefault(): void {
    this.defaultPrevented = true;
  }

  stopPropagation(): void {
    this.__propagationStopped = true;
  }
}

function camel(name: string): string {
  return name.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
}

/**
 * A CSSStyleDeclaration-shaped stand-in. Supports the parts this codebase
 * uses: `cssText`, direct camelCase property writes, and custom properties via
 * `setProperty` / `removeProperty`.
 */
class StubStyle {
  cssText = "";
  private custom = new Map<string, string>();
  [key: string]: unknown;

  setProperty(name: string, value: string): void {
    if (name.startsWith("--")) this.custom.set(name, String(value));
    else (this as any)[camel(name)] = String(value);
  }

  getPropertyValue(name: string): string {
    if (name.startsWith("--")) return this.custom.get(name) ?? "";
    return String((this as any)[camel(name)] ?? "");
  }

  removeProperty(name: string): void {
    if (name.startsWith("--")) this.custom.delete(name);
    else delete (this as any)[camel(name)];
  }
}

export class StubElement extends StubEventTarget {
  tagName: string;
  className = "";
  textContent = "";
  dataset: Record<string, string> = {};
  style: StubStyle = new StubStyle();
  children: StubElement[] = [];
  parentNode: StubElement | null = null;
  disabled = false;
  isConnected = true;
  scrollTop = 0;
  scrollHeight = 0;
  private attributes = new Map<string, string>();

  constructor(tagName: string) {
    super();
    this.tagName = tagName.toUpperCase();
  }

  appendChild<T extends StubElement>(child: T): T {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  append(...nodes: Array<StubElement | string>): void {
    for (const node of nodes) {
      if (typeof node === "string") this.textContent += node;
      else this.appendChild(node);
    }
  }

  replaceChildren(...nodes: StubElement[]): void {
    for (const child of this.children) child.parentNode = null;
    this.children = [];
    for (const node of nodes) this.appendChild(node);
  }

  remove(): void {
    if (!this.parentNode) return;
    this.parentNode.children = this.parentNode.children.filter((c) => c !== this);
    this.parentNode = null;
    this.isConnected = false;
  }

  id = "";

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
    if (name.startsWith("data-")) {
      const key = name
        .slice(5)
        .replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
      this.dataset[key] = value;
    }
    if (name === "class") this.className = value;
    if (name === "id") this.id = value;
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  getBoundingClientRect(): { left: number; top: number; width: number; height: number; right: number; bottom: number } {
    const left = parseFloat(String(this.style.left ?? "0")) || 0;
    const top = parseFloat(String(this.style.top ?? "0")) || 0;
    const width = parseFloat(String(this.style.width ?? "300")) || 300;
    const height = parseFloat(String(this.style.height ?? "200")) || 200;
    return { left, top, width, height, right: left + width, bottom: top + height };
  }

  querySelector(selector: string): StubElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  /** Matches a single compound selector: `tag`, `.class`, `#id`, `[attr=v]`. */
  private matchesSimple(selector: string, node: StubElement): boolean {
    const part = selector.trim();
    if (!part) return false;
    if (part.startsWith(".")) return node.className.split(/\s+/).includes(part.slice(1));
    if (part.startsWith("#")) return node.id === part.slice(1);
    if (part.startsWith("[")) {
      const inner = part.slice(1, -1);
      const eq = inner.indexOf("=");
      if (eq < 0) return node.getAttribute(inner) !== null || inner.replace(/^data-/, "") in node.dataset;
      const name = inner.slice(0, eq);
      const value = inner.slice(eq + 1).replace(/^["']|["']$/g, "");
      const dataKey = name.startsWith("data-") ? camel(name.slice(5)) : null;
      return (
        node.getAttribute(name) === value ||
        (dataKey !== null && node.dataset[dataKey] === value)
      );
    }
    return node.tagName === part.toUpperCase();
  }

  /**
   * Supports the selector forms this codebase uses: comma-separated lists and
   * descendant combinators, each part being a simple selector. Enough to behave
   * like a real DOM for the overlay's queries.
   */
  querySelectorAll(selector: string): StubElement[] {
    const out: StubElement[] = [];
    const groups = selector.split(",").map((g) => g.trim().split(/\s+/).filter(Boolean));

    const walk = (node: StubElement): void => {
      for (const child of node.children) {
        for (const parts of groups) {
          if (parts.length === 0) continue;
          if (!this.matchesSimple(parts[parts.length - 1], child)) continue;
          // Walk the remaining ancestor parts upwards.
          let ancestor: StubElement | null = child.parentNode;
          let index = parts.length - 2;
          while (index >= 0 && ancestor && ancestor !== this) {
            if (this.matchesSimple(parts[index], ancestor)) index--;
            ancestor = ancestor.parentNode;
          }
          if (index < 0) {
            if (!out.includes(child)) out.push(child);
            break;
          }
        }
        walk(child);
      }
    };
    walk(this);
    return out;
  }

  /** Supports the selector forms this codebase uses: tag, .class, and lists. */
  matches(selector: string): boolean {
    return selector
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean)
      .some((part) => {
        if (part.startsWith(".")) return this.className.split(/\s+/).includes(part.slice(1));
        if (part.startsWith("#")) return this.id === part.slice(1);
        return this.tagName === part.toUpperCase();
      });
  }

  closest(selector: string): StubElement | null {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let node: StubElement | null = this;
    while (node) {
      if (node.matches(selector)) return node;
      node = node.parentNode;
    }
    return null;
  }

  get classList() {
    const self = this;
    return {
      add(...names: string[]) {
        const set = new Set(self.className.split(/\s+/).filter(Boolean));
        for (const n of names) set.add(n);
        self.className = Array.from(set).join(" ");
      },
      remove(...names: string[]) {
        const set = new Set(self.className.split(/\s+/).filter(Boolean));
        for (const n of names) set.delete(n);
        self.className = Array.from(set).join(" ");
      },
      toggle(name: string, force?: boolean) {
        const has = self.className.split(/\s+/).includes(name);
        const want = force === undefined ? !has : force;
        if (want) this.add(name);
        else this.remove(name);
        return want;
      },
      contains(name: string) {
        return self.className.split(/\s+/).includes(name);
      },
    };
  }
}

export class StubDocument extends StubElement {
  head: StubElement;
  body: StubElement;
  documentElement: StubElement;
  hidden = false;
  readyState = "complete";

  constructor() {
    super("#document");
    this.documentElement = new StubElement("html");
    this.head = new StubElement("head");
    this.body = new StubElement("body");
    this.documentElement.parentNode = this;
    this.appendChild(this.documentElement);
    this.documentElement.appendChild(this.head);
    this.documentElement.appendChild(this.body);
  }

  createElement(tag: string): StubElement {
    return new StubElement(tag);
  }

  createTextNode(text: string): StubElement {
    const node = new StubElement("#text");
    node.textContent = text;
    return node;
  }

  createDocumentFragment(): StubElement {
    return new StubElement("#fragment");
  }

  getElementById(id: string): StubElement | null {
    let found: StubElement | null = null;
    const walk = (node: StubElement): void => {
      if (found) return;
      for (const child of node.children) {
        if (child.id === id) {
          found = child;
          return;
        }
        walk(child);
      }
    };
    walk(this);
    return found;
  }
}

export interface StubEnvironment {
  window: any;
  document: StubDocument;
  /** Advance the fake clock and run anything scheduled up to that point. */
  advance: (ms: number) => void;
  /** Run one animation frame callback. */
  frame: (ms?: number) => void;
  now: () => number;
  globalsInstalled: () => void;
  globalsRemoved: () => void;
}

interface ScheduledTask {
  at: number;
  fn: () => void;
  id: number;
  interval: number | null;
}

/**
 * Install a fake DOM + fake clock on `globalThis`.
 * The clock is manual: nothing runs until `advance()` is called, which makes
 * timing assertions exact rather than flaky.
 */
export function installDom(options: { start?: number } = {}): StubEnvironment {
  const document = new StubDocument();
  let clock = options.start ?? 1000;
  const tasks = new Map<number, ScheduledTask>();
  let nextTaskId = 1;
  const rafQueue: Array<{ id: number; fn: (t: number) => void }> = [];
  let nextRafId = 1;

  const store = new Map<string, string>();

  const window: any = {
    document,
    innerWidth: 1920,
    innerHeight: 1080,
    location: { hostname: "webosumania.com", href: "https://webosumania.com/" },
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, String(v)),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
    },
    devicePixelRatio: 1,
    addEventListener: (type: string, handler: Listener) => window.__et.addEventListener(type, handler),
    removeEventListener: (type: string, handler: Listener) => window.__et.removeEventListener(type, handler),
    dispatchEvent: (event: any) => window.__et.dispatchEvent(event),
    requestAnimationFrame: (fn: (t: number) => void) => {
      const id = nextRafId++;
      rafQueue.push({ id, fn });
      return id;
    },
    cancelAnimationFrame: (id: number) => {
      const index = rafQueue.findIndex((entry) => entry.id === id);
      if (index >= 0) rafQueue.splice(index, 1);
    },
    setTimeout: (fn: () => void, ms = 0) => {
      const id = nextTaskId++;
      tasks.set(id, { at: clock + Math.max(0, ms), fn, id, interval: null });
      return id;
    },
    clearTimeout: (id: number) => void tasks.delete(id),
    setInterval: (fn: () => void, ms = 1) => {
      const id = nextTaskId++;
      tasks.set(id, { at: clock + Math.max(1, ms), fn, id, interval: Math.max(1, ms) });
      return id;
    },
    clearInterval: (id: number) => void tasks.delete(id),
    performance: { now: () => clock },
    navigator: { getGamepads: () => [] },
    KeyboardEvent: StubKeyboardEvent,
    Element: StubElement,
    Node: StubElement,
    __et: new StubEventTarget(),
    __tasks: tasks,
  };
  window.window = window;
  window.self = window;

  function advance(ms: number): void {
    const target = clock + ms;
    // Run due tasks in time order, repeatedly, because a task can schedule more.
    for (;;) {
      const due = Array.from(tasks.values())
        .filter((task) => task.at <= target)
        .sort((a, b) => a.at - b.at || a.id - b.id);
      if (due.length === 0) break;
      const task = due[0];
      clock = Math.max(clock, task.at);
      if (task.interval !== null) task.at = clock + task.interval;
      else tasks.delete(task.id);
      task.fn();
    }
    clock = target;
  }

  function frame(): void {
    const entry = rafQueue.shift();
    if (!entry) return;
    entry.fn(clock);
  }

  const globals: Array<[string, unknown]> = [
    ["window", window],
    ["document", document],
    ["performance", window.performance],
    ["KeyboardEvent", StubKeyboardEvent],
    ["localStorage", window.localStorage],
    ["requestAnimationFrame", window.requestAnimationFrame],
    ["cancelAnimationFrame", window.cancelAnimationFrame],
    ["setTimeout", window.setTimeout],
    ["clearTimeout", window.clearTimeout],
    ["setInterval", window.setInterval],
    ["clearInterval", window.clearInterval],
    ["Element", StubElement],
  ];

  const previous = new Map<string, unknown>();
  /** Globals that resisted assignment (Node 22 makes `navigator` getter-only). */
  const forced = new Map<string, PropertyDescriptor | undefined>();

  function define(name: string, value: unknown): boolean {
    try {
      (globalThis as any)[name] = value;
      if ((globalThis as any)[name] === value) return true;
    } catch {
      /* fall through to defineProperty */
    }
    try {
      forced.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
      Object.defineProperty(globalThis, name, {
        value,
        writable: true,
        configurable: true,
        enumerable: true,
      });
      return true;
    } catch {
      return false;
    }
  }

  return {
    window,
    document,
    advance,
    frame,
    now: () => clock,
    globalsInstalled() {
      for (const [name, value] of globals) {
        previous.set(name, (globalThis as any)[name]);
        define(name, value);
      }
      // `navigator` is optional for these tests; skip it if it cannot be
      // replaced rather than failing every test in the file.
      previous.set("navigator", (globalThis as any).navigator);
      define("navigator", window.navigator);
    },
    globalsRemoved() {
      for (const [name, value] of previous) {
        const descriptor = forced.get(name);
        if (descriptor) {
          try {
            Object.defineProperty(globalThis, name, descriptor);
          } catch {
            /* ignore */
          }
          forced.delete(name);
          continue;
        }
        try {
          if (value === undefined) delete (globalThis as any)[name];
          else (globalThis as any)[name] = value;
        } catch {
          /* ignore */
        }
      }
      previous.clear();
    },
  };
}
