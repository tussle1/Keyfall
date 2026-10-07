import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { DEFAULT_SETTINGS, OFFSET_MAX, OFFSET_MIN, STORAGE_KEY } from "../src/constants";
import { findHotkeyCollisions, SettingsManager } from "../src/core/settings";
import {
  clamp,
  deepMerge,
  formatTime,
  groupDigits,
  hashString,
  humanizeCode,
  lowerBound,
  round,
  stableSortBy,
} from "../src/util/helpers";
import { installDom, type StubEnvironment } from "./helpers/domStub";

let env: StubEnvironment;

beforeEach(() => {
  env = installDom();
  env.globalsInstalled();
});

afterEach(() => {
  env.globalsRemoved();
});

describe("SettingsManager", () => {
  it("starts from defaults", () => {
    const settings = new SettingsManager(undefined, env.window);
    assert.deepEqual(settings.all, DEFAULT_SETTINGS);
    settings.dispose();
  });

  it("sets a nested value by path", () => {
    const settings = new SettingsManager(undefined, env.window);
    settings.set("timing.offset", -15);
    assert.equal(settings.all.timing.offset, -15);
    settings.set("general.debug", true);
    assert.equal(settings.all.general.debug, true);
    settings.dispose();
  });

  it("clamps the timing offset to the specified range", () => {
    const settings = new SettingsManager(undefined, env.window);
    settings.set("timing.offset", -99999);
    assert.equal(settings.all.timing.offset, OFFSET_MIN);
    settings.set("timing.offset", 99999);
    assert.equal(settings.all.timing.offset, OFFSET_MAX);
    settings.dispose();
  });

  it("clamps lookahead, scale and opacity", () => {
    const settings = new SettingsManager(undefined, env.window);
    settings.set("timing.lookahead", 100000);
    assert.ok(settings.all.timing.lookahead <= 500);
    settings.set("appearance.uiScale", 99);
    assert.ok(settings.all.appearance.uiScale <= 2);
    settings.set("appearance.opacity", -5);
    assert.ok(settings.all.appearance.opacity >= 0.15);
    settings.dispose();
  });

  it("rejects an invalid accent colour", () => {
    const settings = new SettingsManager(undefined, env.window);
    settings.set("appearance.accent", "not-a-colour");
    assert.equal(settings.all.appearance.accent, DEFAULT_SETTINGS.appearance.accent);
    settings.set("appearance.accent", "#00ff88");
    assert.equal(settings.all.appearance.accent, "#00ff88");
    settings.dispose();
  });

  it("drops malformed key mappings", () => {
    const settings = new SettingsManager(undefined, env.window);
    settings.set("input.keyMappings", {
      "4": ["KeyD", "KeyF", "KeyJ", "KeyK"], // valid
      "7": ["KeyD"], // wrong length
      abc: ["KeyD"], // not a number
      "99": new Array(99).fill("KeyD"), // out of range key count
    });
    assert.deepEqual(Object.keys(settings.all.input.keyMappings), ["4"]);
    settings.dispose();
  });

  it("emits change events", () => {
    const settings = new SettingsManager(undefined, env.window);
    const seen: string[] = [];
    settings.onChange(({ path }) => seen.push(path));
    settings.set("timing.offset", 10);
    settings.set("general.debug", true);
    assert.deepEqual(seen, ["timing.offset", "general.debug"]);
    settings.dispose();
  });

  it("unsubscribes from change events", () => {
    const settings = new SettingsManager(undefined, env.window);
    let calls = 0;
    const off = settings.onChange(() => calls++);
    settings.set("timing.offset", 5);
    off();
    settings.set("timing.offset", 6);
    assert.equal(calls, 1);
    settings.dispose();
  });

  it("persists to localStorage and reloads", () => {
    const first = new SettingsManager(undefined, env.window);
    first.set("timing.offset", -42);
    first.set("general.debug", true);
    first.set("appearance.accent", "#123456");
    first.dispose();

    // Writes are coalesced on a timer.
    env.advance(400);

    const second = new SettingsManager(undefined, env.window);
    assert.equal(second.all.timing.offset, -42);
    assert.equal(second.all.general.debug, true);
    assert.equal(second.all.appearance.accent, "#123456");
    second.dispose();
  });

  it("survives corrupt stored JSON", () => {
    env.window.localStorage.setItem(STORAGE_KEY, "{not json");
    const settings = new SettingsManager(undefined, env.window);
    assert.deepEqual(settings.all, DEFAULT_SETTINGS);
    settings.dispose();
  });

  it("survives stored settings of the wrong shape", () => {
    env.window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ timing: { offset: "banana", lookahead: null }, general: 42 }),
    );
    const settings = new SettingsManager(undefined, env.window);
    assert.equal(typeof settings.all.timing.offset, "number");
    assert.equal(settings.all.timing.offset, 0);
    assert.equal(typeof settings.all.general.debug, "boolean");
    settings.dispose();
  });

  it("works when storage is unavailable", () => {
    const noStorageWindow = { ...env.window, localStorage: undefined };
    Object.defineProperty(noStorageWindow, "localStorage", {
      get() {
        throw new Error("blocked");
      },
    });
    const settings = new SettingsManager(undefined, noStorageWindow as any);
    settings.set("timing.offset", 12);
    assert.equal(settings.all.timing.offset, 12);
    settings.dispose();
  });

  it("reset returns to defaults", () => {
    const settings = new SettingsManager(undefined, env.window);
    settings.set("timing.offset", 99);
    settings.set("general.debug", true);
    settings.reset();
    assert.equal(settings.all.timing.offset, DEFAULT_SETTINGS.timing.offset);
    assert.equal(settings.all.general.debug, false);
    settings.dispose();
  });

  it("toggleGeneral flips and persists", () => {
    const settings = new SettingsManager(undefined, env.window);
    assert.equal(settings.toggleGeneral("showKeyboard"), false);
    assert.equal(settings.all.general.showKeyboard, false);
    assert.equal(settings.toggleGeneral("showKeyboard"), true);
    settings.dispose();
  });
});

describe("SettingsManager: humanization", () => {
  it("defaults to off so playback is frame-exact out of the box", () => {
    const manager = new SettingsManager(undefined, env.window);
    assert.equal(manager.all.humanization.enabled, false);
    assert.deepEqual(manager.all.humanization, DEFAULT_SETTINGS.humanization);
  });

  it("persists a humanization change across instances", () => {
    const manager = new SettingsManager(undefined, env.window);
    manager.set("humanization.enabled", true);
    manager.set("humanization.seed", 424242);
    manager.set("humanization.strength", 0.8);
    manager.set("humanization.distribution", "uniform");
    manager.dispose();

    // Writes are coalesced on a timer, so advance past it before reloading.
    env.advance(400);

    const reloaded = new SettingsManager(undefined, env.window);
    assert.equal(reloaded.all.humanization.enabled, true);
    assert.equal(reloaded.all.humanization.seed, 424242);
    assert.equal(reloaded.all.humanization.strength, 0.8);
    assert.equal(reloaded.all.humanization.distribution, "uniform");
  });

  it("clamps out-of-range weights read back from storage", () => {
    const manager = new SettingsManager(undefined, env.window);
    manager.set("humanization.strength", 99);
    manager.set("humanization.fatigue", -5);
    assert.equal(manager.all.humanization.strength, 1);
    assert.equal(manager.all.humanization.fatigue, 0);
  });

  it("survives corrupted persisted JSON", () => {
    env.window.localStorage.setItem(STORAGE_KEY, "{not json");
    const manager = new SettingsManager(undefined, env.window);
    assert.deepEqual(manager.all.humanization, DEFAULT_SETTINGS.humanization);
  });

  it("survives a persisted humanization block of the wrong shape", () => {
    env.window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ humanization: { enabled: "yes", strength: "lots", seed: null, distribution: 7 } }),
    );
    const manager = new SettingsManager(undefined, env.window);
    const h = manager.all.humanization;
    assert.equal(h.enabled, false, "a non-boolean must not enable it");
    assert.equal(h.distribution, "gaussian");
    assert.ok(h.strength >= 0 && h.strength <= 1);
    assert.ok(Number.isInteger(h.seed) && h.seed >= 0);
  });

  it("reset() restores humanization defaults", () => {
    const manager = new SettingsManager(undefined, env.window);
    manager.set("humanization.enabled", true);
    manager.set("humanization.strength", 1);
    manager.reset();
    assert.deepEqual(manager.all.humanization, DEFAULT_SETTINGS.humanization);
  });

  it("patch() merges humanization without dropping sibling keys", () => {
    const manager = new SettingsManager(undefined, env.window);
    manager.patch({ humanization: { strength: 0.9 } } as never);
    assert.equal(manager.all.humanization.strength, 0.9);
    assert.equal(
      manager.all.humanization.distribution,
      DEFAULT_SETTINGS.humanization.distribution,
      "an untouched sibling must survive the merge",
    );
  });
});

describe("findHotkeyCollisions", () => {
  it("reports a hotkey bound to a gameplay key", () => {
    const settings = new SettingsManager(undefined, env.window);
    settings.set("input.hotkeys.start", "KeyD");
    const collisions = findHotkeyCollisions(settings.all, ["KeyD", "KeyF", "KeyJ", "KeyK"]);
    assert.equal(collisions.length, 1);
    assert.equal(collisions[0].action, "start");
    assert.equal(collisions[0].code, "KeyD");
    settings.dispose();
  });

  it("reports no collision for the default function keys", () => {
    const settings = new SettingsManager(undefined, env.window);
    const collisions = findHotkeyCollisions(settings.all, ["KeyD", "KeyF", "KeyJ", "KeyK"]);
    assert.equal(collisions.length, 0);
    settings.dispose();
  });
});

describe("helpers", () => {
  it("clamp bounds a value", () => {
    assert.equal(clamp(5, 0, 10), 5);
    assert.equal(clamp(-5, 0, 10), 0);
    assert.equal(clamp(50, 0, 10), 10);
  });

  it("lowerBound finds the first index at or after a target", () => {
    const arr = [1, 3, 3, 5, 8];
    assert.equal(lowerBound(arr, 0, (x) => x), 0);
    assert.equal(lowerBound(arr, 3, (x) => x), 1);
    assert.equal(lowerBound(arr, 4, (x) => x), 3);
    assert.equal(lowerBound(arr, 9, (x) => x), 5);
  });

  it("lowerBound respects a start offset", () => {
    const arr = [1, 3, 5, 8];
    assert.equal(lowerBound(arr, 1, (x) => x, 2), 2);
  });

  it("lowerBound is correct on a large sorted array", () => {
    const arr = Array.from({ length: 10_000 }, (_, i) => i * 2);
    for (const target of [0, 1, 2, 999, 19_998, 19_999, 20_000]) {
      const index = lowerBound(arr, target, (x) => x);
      assert.ok(index === arr.length || arr[index] >= target);
      assert.ok(index === 0 || arr[index - 1] < target);
    }
  });

  it("stableSortBy preserves insertion order for ties", () => {
    const items = [
      { id: "a", k: 1 },
      { id: "b", k: 0 },
      { id: "c", k: 1 },
      { id: "d", k: 0 },
    ];
    assert.deepEqual(
      stableSortBy(items, (i) => i.k).map((i) => i.id),
      ["b", "d", "a", "c"],
    );
  });

  it("formatTime renders mm:ss.mmm", () => {
    assert.equal(formatTime(0), "0:00.000");
    assert.equal(formatTime(1000), "0:01.000");
    assert.equal(formatTime(182_340), "3:02.340");
    assert.equal(formatTime(-1500), "-0:01.500");
    assert.equal(formatTime(NaN), "--:--");
  });

  it("groupDigits inserts thousands separators", () => {
    assert.equal(groupDigits(0), "0");
    assert.equal(groupDigits(999), "999");
    assert.equal(groupDigits(2481), "2,481");
    assert.equal(groupDigits(1_000_000), "1,000,000");
  });

  it("humanizeCode renders readable key names", () => {
    assert.equal(humanizeCode("KeyD"), "D");
    assert.equal(humanizeCode("Space"), "␣");
    assert.equal(humanizeCode("Semicolon"), ";");
    assert.equal(humanizeCode("Digit7"), "7");
    assert.equal(humanizeCode("F7"), "F7");
    assert.equal(humanizeCode(""), "?");
  });

  it("hashString is stable and discriminating", () => {
    assert.equal(hashString("abc"), hashString("abc"));
    assert.notEqual(hashString("abc"), hashString("abd"));
    assert.equal(hashString(""), hashString(""));
  });

  it("round avoids floating point noise", () => {
    assert.equal(round(0.1 + 0.2, 2), 0.3);
    assert.equal(round(2.675, 1), 2.7);
    assert.equal(round(1.5, 0), 2);
    // 1.005 is stored as 1.00499999999999989, so half-up rounding gives 1.
    // Asserting the real behaviour rather than the intuitive one.
    assert.equal(round(1.005, 2), 1);
  });

  it("deepMerge does not mutate the base", () => {
    const base = { a: 1, nested: { b: 2, c: 3 } };
    const merged = deepMerge(base, { nested: { b: 99 } });
    assert.equal(merged.nested.b, 99);
    assert.equal(merged.nested.c, 3);
    assert.equal(base.nested.b, 2, "base must be untouched");
  });

  it("deepMerge tolerates junk patches", () => {
    const base = { a: 1 };
    assert.deepEqual(deepMerge(base, null), base);
    assert.deepEqual(deepMerge(base, undefined), base);
    assert.deepEqual(deepMerge(base, "string"), base);
  });
});
