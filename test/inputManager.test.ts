import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { InputManager, keyFromCode } from "../src/input/InputManager";
import type { InputAction, KeyMapping } from "../src/types";
import { installDom, StubKeyboardEvent, type StubEnvironment } from "./helpers/domStub";

let env: StubEnvironment;

interface Recorded {
  type: string;
  code: string;
  repeat: boolean;
  isTrusted: boolean;
  bubbles: boolean;
  at: number;
}

/**
 * A stand-in for the site's `InputSystem`: listens on `document` for
 * keydown/keyup, maps `event.code` -> column, ignores repeats, and keeps a
 * `pressedColumns` array exactly like the real one.
 */
function installFakeGame(codes: string[]) {
  const pressedColumns = new Array(codes.length).fill(false);
  const events: Recorded[] = [];
  const codeToColumn = new Map(codes.map((code, column) => [code, column]));
  const hits: Array<{ column: number; at: number }> = [];
  const releases: Array<{ column: number; at: number }> = [];

  const onKeyDown = (event: any) => {
    events.push({
      type: event.type,
      code: event.code,
      repeat: event.repeat,
      isTrusted: event.isTrusted,
      bubbles: event.bubbles,
      at: env.now(),
    });
    if (event.repeat) return;
    const column = codeToColumn.get(event.code);
    if (column === undefined) return;
    if (pressedColumns[column]) return; // the real site no-ops on repeats
    pressedColumns[column] = true;
    hits.push({ column, at: env.now() });
  };

  const onKeyUp = (event: any) => {
    events.push({
      type: event.type,
      code: event.code,
      repeat: event.repeat,
      isTrusted: event.isTrusted,
      bubbles: event.bubbles,
      at: env.now(),
    });
    const column = codeToColumn.get(event.code);
    if (column === undefined) return;
    if (!pressedColumns[column]) return;
    pressedColumns[column] = false;
    releases.push({ column, at: env.now() });
  };

  env.document.addEventListener("keydown", onKeyDown);
  env.document.addEventListener("keyup", onKeyUp);

  return { pressedColumns, events, hits, releases };
}

function mapping(codes: string[]): KeyMapping {
  return { codes, keyCount: codes.length, source: "site" };
}

function action(
  time: number,
  type: "down" | "up",
  column: number,
  code: string,
  holdDuration = 0,
): InputAction {
  return { seq: 0, time, type, column, code, simultaneous: false, holdDuration };
}

beforeEach(() => {
  env = installDom({ start: 1000 });
  env.globalsInstalled();
});

afterEach(() => {
  env.globalsRemoved();
});

describe("InputManager", () => {
  it("dispatches keydown/keyup the site can consume", () => {
    const game = installFakeGame(["KeyD", "KeyF", "KeyJ", "KeyK"]);
    const input = new InputManager({ target: env.document, eventCtor: StubKeyboardEvent as any });
    input.setMapping(mapping(["KeyD", "KeyF", "KeyJ", "KeyK"]));

    input.press(1, 1000);
    assert.equal(game.pressedColumns[1], true, "site should register the press");

    input.release(1, 1010);
    assert.equal(game.pressedColumns[1], false, "site should register the release");
    input.dispose();
  });

  it("sets repeat:false, because the site ignores repeats", () => {
    const game = installFakeGame(["KeyD", "KeyF", "KeyJ", "KeyK"]);
    const input = new InputManager({ target: env.document, eventCtor: StubKeyboardEvent as any });
    input.setMapping(mapping(["KeyD", "KeyF", "KeyJ", "KeyK"]));

    input.press(0, 1000);
    const down = game.events.find((e) => e.type === "keydown");
    assert.ok(down);
    assert.equal(down.repeat, false, "repeat must be false or the site drops the press");
    assert.equal(down.bubbles, true);
    assert.equal(down.code, "KeyD");
    input.dispose();
  });

  it("does not spoof isTrusted — synthetic events stay synthetic", () => {
    const game = installFakeGame(["KeyD", "KeyF", "KeyJ", "KeyK"]);
    const input = new InputManager({ target: env.document, eventCtor: StubKeyboardEvent as any });
    input.setMapping(mapping(["KeyD", "KeyF", "KeyJ", "KeyK"]));

    input.press(0, 1000);
    const down = game.events.find((e) => e.type === "keydown");
    assert.ok(down);
    // This is the honest limitation of browser-side automation, and the reason
    // the tool cannot pretend to be physical input.
    assert.equal(down.isTrusted, false);
    input.dispose();
  });

  it("presses all columns of a chord simultaneously", () => {
    const game = installFakeGame(["KeyD", "KeyF", "KeyJ", "KeyK"]);
    const input = new InputManager({
      target: env.document,
      eventCtor: StubKeyboardEvent as any,
      minTapHoldMs: 0,
    });
    input.setMapping(mapping(["KeyD", "KeyF", "KeyJ", "KeyK"]));

    input.applyActions(
      [
        action(1000, "down", 0, "KeyD"),
        action(1000, "down", 1, "KeyF"),
        action(1000, "down", 3, "KeyK"),
      ],
      1000,
    );
    assert.deepEqual(game.pressedColumns, [true, true, false, true]);
    assert.deepEqual(input.heldColumns, [0, 1, 3]);
    input.dispose();
  });

  it("releases all columns of a chord simultaneously", () => {
    const game = installFakeGame(["KeyD", "KeyF", "KeyJ", "KeyK"]);
    const input = new InputManager({
      target: env.document,
      eventCtor: StubKeyboardEvent as any,
      minTapHoldMs: 0,
    });
    input.setMapping(mapping(["KeyD", "KeyF", "KeyJ", "KeyK"]));

    input.applyActions(
      [action(1000, "down", 0, "KeyD"), action(1000, "down", 2, "KeyJ")],
      1000,
    );
    input.applyActions([action(1200, "up", 0, "KeyD"), action(1200, "up", 2, "KeyJ")], 1200);
    assert.deepEqual(game.pressedColumns, [false, false, false, false]);
    assert.equal(input.heldCount, 0);
    input.dispose();
  });

  it("tracks multiple independent holds at once", () => {
    const game = installFakeGame(["KeyD", "KeyF", "KeyJ", "KeyK"]);
    const input = new InputManager({
      target: env.document,
      eventCtor: StubKeyboardEvent as any,
      minTapHoldMs: 12,
      now: () => env.now(),
      scheduleTask: (fn, ms) => env.window.setTimeout(fn, ms),
      cancelTask: (h) => env.window.clearTimeout(h),
    });
    input.setMapping(mapping(["KeyD", "KeyF", "KeyJ", "KeyK"]));

    // Column 0 hold 1000->2000, column 2 tap at 1200, column 3 hold 1000->1800.
    input.applyActions(
      [action(1000, "down", 0, "KeyD"), action(1000, "down", 3, "KeyK")],
      1000,
    );
    assert.deepEqual(game.pressedColumns, [true, false, false, true]);

    input.applyActions([action(1200, "down", 2, "KeyJ"), action(1200, "up", 2, "KeyJ")], 1200);
    // Columns 0 and 3 must still be down while 2 is tapped. Column 2's release
    // is deferred by minTapHoldMs, so it is still down at this instant too.
    assert.equal(game.pressedColumns[0], true);
    assert.equal(game.pressedColumns[3], true);
    assert.equal(game.pressedColumns[2], true);

    env.advance(20);
    assert.equal(game.pressedColumns[2], false, "the tap released");
    assert.equal(game.pressedColumns[0], true, "hold on column 1 unaffected");
    assert.equal(game.pressedColumns[3], true, "hold on column 4 unaffected");

    input.applyActions([action(1800, "up", 3, "KeyK")], 1800);
    assert.equal(game.pressedColumns[3], false);
    assert.equal(game.pressedColumns[0], true, "column 1 hold still running");

    input.applyActions([action(2000, "up", 0, "KeyD")], 2000);
    assert.deepEqual(game.pressedColumns, [false, false, false, false]);
    assert.equal(input.heldCount, 0, "nothing left held");
    input.dispose();
  });

  it("defers a tap release so the key is measurably down", () => {
    const game = installFakeGame(["KeyD", "KeyF", "KeyJ", "KeyK"]);
    const input = new InputManager({
      target: env.document,
      eventCtor: StubKeyboardEvent as any,
      minTapHoldMs: 12,
      now: () => env.now(),
      scheduleTask: (fn, ms) => env.window.setTimeout(fn, ms),
      cancelTask: (h) => env.window.clearTimeout(h),
    });
    input.setMapping(mapping(["KeyD", "KeyF", "KeyJ", "KeyK"]));

    input.applyActions([action(1000, "down", 0, "KeyD"), action(1000, "up", 0, "KeyD")], 1000);
    assert.equal(game.pressedColumns[0], true, "still down immediately after the batch");
    assert.equal(game.releases.length, 0);

    env.advance(20);
    assert.equal(game.pressedColumns[0], false, "released after the deferral");
    assert.equal(game.releases.length, 1);

    const downAt = game.hits[0].at;
    const upAt = game.releases[0].at;
    assert.ok(upAt - downAt >= 12, `key was down for ${upAt - downAt}ms`);
    input.dispose();
  });

  it("does not defer a hold release", () => {
    const game = installFakeGame(["KeyD", "KeyF", "KeyJ", "KeyK"]);
    const input = new InputManager({
      target: env.document,
      eventCtor: StubKeyboardEvent as any,
      minTapHoldMs: 12,
      now: () => env.now(),
      scheduleTask: (fn, ms) => env.window.setTimeout(fn, ms),
      cancelTask: (h) => env.window.clearTimeout(h),
    });
    input.setMapping(mapping(["KeyD", "KeyF", "KeyJ", "KeyK"]));

    input.applyActions([action(1000, "down", 1, "KeyF")], 1000);
    // Release arrives later with a different timestamp: fire immediately.
    input.applyActions([action(1750, "up", 1, "KeyF")], 1750);
    assert.equal(game.pressedColumns[1], false);
    assert.equal(game.releases.length, 1);
    input.dispose();
  });

  it("suppresses a duplicate press instead of double-firing", () => {
    const game = installFakeGame(["KeyD", "KeyF", "KeyJ", "KeyK"]);
    const input = new InputManager({ target: env.document, eventCtor: StubKeyboardEvent as any });
    input.setMapping(mapping(["KeyD", "KeyF", "KeyJ", "KeyK"]));

    input.press(0, 1000);
    input.press(0, 1000);
    assert.equal(input.suppressedDuplicate, 1);
    assert.equal(game.hits.length, 1);
    assert.equal(input.heldCount, 1);
    input.dispose();
  });

  it("releaseAll releases everything, including deferred taps", () => {
    const game = installFakeGame(["KeyD", "KeyF", "KeyJ", "KeyK"]);
    const input = new InputManager({
      target: env.document,
      eventCtor: StubKeyboardEvent as any,
      minTapHoldMs: 50,
      now: () => env.now(),
      scheduleTask: (fn, ms) => env.window.setTimeout(fn, ms),
      cancelTask: (h) => env.window.clearTimeout(h),
    });
    input.setMapping(mapping(["KeyD", "KeyF", "KeyJ", "KeyK"]));

    input.applyActions(
      [
        action(1000, "down", 0, "KeyD"),
        action(1000, "down", 1, "KeyF"),
        action(1000, "down", 2, "KeyJ"),
        action(1000, "up", 2, "KeyJ"), // deferred
      ],
      1000,
    );
    assert.equal(input.heldCount, 3);

    const released = input.releaseAll();
    assert.equal(released, 3);
    assert.deepEqual(game.pressedColumns, [false, false, false, false]);
    assert.equal(input.heldCount, 0);

    // The deferred release must have been cancelled, not fired twice.
    env.advance(100);
    assert.equal(game.releases.length, 3);
    input.dispose();
  });

  it("releaseAll is safe when nothing is held", () => {
    installFakeGame(["KeyD", "KeyF", "KeyJ", "KeyK"]);
    const input = new InputManager({ target: env.document, eventCtor: StubKeyboardEvent as any });
    input.setMapping(mapping(["KeyD", "KeyF", "KeyJ", "KeyK"]));
    assert.equal(input.releaseAll(), 0);
    assert.equal(input.releaseAll(), 0);
    input.dispose();
  });

  it("releases a key even if the press was never recorded", () => {
    const game = installFakeGame(["KeyD", "KeyF", "KeyJ", "KeyK"]);
    const input = new InputManager({ target: env.document, eventCtor: StubKeyboardEvent as any });
    input.setMapping(mapping(["KeyD", "KeyF", "KeyJ", "KeyK"]));

    // Site thinks column 0 is down (e.g. the user held it) but we have no record.
    game.pressedColumns[0] = true;
    input.release(0, 1000);
    assert.equal(game.pressedColumns[0], false, "must still release to avoid a stuck key");
    input.dispose();
  });

  it("dispose releases every held key", () => {
    const game = installFakeGame(["KeyD", "KeyF", "KeyJ", "KeyK"]);
    const input = new InputManager({ target: env.document, eventCtor: StubKeyboardEvent as any });
    input.setMapping(mapping(["KeyD", "KeyF", "KeyJ", "KeyK"]));

    input.press(0, 1000);
    input.press(3, 1000);
    input.dispose();
    assert.deepEqual(game.pressedColumns, [false, false, false, false]);
  });

  it("ignores input after dispose", () => {
    const game = installFakeGame(["KeyD", "KeyF", "KeyJ", "KeyK"]);
    const input = new InputManager({ target: env.document, eventCtor: StubKeyboardEvent as any });
    input.setMapping(mapping(["KeyD", "KeyF", "KeyJ", "KeyK"]));
    input.dispose();
    input.press(0, 1000);
    assert.equal(game.hits.length, 0);
  });

  it("presses both keybinds of a column when configured", () => {
    const game = installFakeGame(["KeyD", "KeyF", "KeyJ", "KeyK"]);
    const input = new InputManager({ target: env.document, eventCtor: StubKeyboardEvent as any });
    // Column 0 is reachable via KeyD; the site also allows a second binding,
    // but here we simulate a rebind where KeyF also maps to column 0.
    input.setMapping(mapping(["KeyD", "KeyF", "KeyJ", "KeyK"]), ["KeyF", null, null, null]);

    input.press(0, 1000);
    assert.equal(game.events.filter((e) => e.type === "keydown").length, 2);
    assert.equal(input.heldCount, 2);

    input.release(0, 1010);
    assert.equal(input.heldCount, 0);
    input.dispose();
  });

  it("tracks held-since chart times for the stuck-key watchdog", () => {
    installFakeGame(["KeyD", "KeyF", "KeyJ", "KeyK"]);
    const input = new InputManager({ target: env.document, eventCtor: StubKeyboardEvent as any });
    input.setMapping(mapping(["KeyD", "KeyF", "KeyJ", "KeyK"]));

    input.press(0, 1000);
    input.press(1, 1200);
    const since = input.heldSinceChart();
    assert.equal(since.get(0), 1000);
    assert.equal(since.get(1), 1200);

    input.release(0, 1500);
    assert.equal(input.heldSinceChart().has(0), false);
    input.dispose();
  });

  it("reports failures instead of throwing when dispatch fails", () => {
    const brokenTarget = {
      dispatchEvent() {
        throw new Error("dispatch blocked");
      },
      addEventListener() {},
      removeEventListener() {},
    };
    const errors: unknown[] = [];
    const input = new InputManager({
      target: brokenTarget as any,
      eventCtor: StubKeyboardEvent as any,
      onError: (err) => errors.push(err),
    });
    input.setMapping(mapping(["KeyD", "KeyF"]));

    input.press(0, 1000);
    assert.equal(input.failures, 1);
    assert.equal(errors.length, 1);
    assert.equal(input.heldCount, 0, "must not record a press that never landed");
    input.dispose();
  });

  it("does not swallow a jack faster than minTapHoldMs", () => {
    // Regression: a tap defers its release by minTapHoldMs. If the next press
    // on that column arrives before the deferral elapses, the naive behaviour
    // is to treat the column as "already held" and drop the press — the site
    // would drop it too, because its own pressedColumns is still true.
    const game = installFakeGame(["KeyD", "KeyF", "KeyJ", "KeyK"]);
    const input = new InputManager({
      target: env.document,
      eventCtor: StubKeyboardEvent as any,
      minTapHoldMs: 12,
      now: () => env.now(),
      scheduleTask: (fn, ms) => env.window.setTimeout(fn, ms),
      cancelTask: (h) => env.window.clearTimeout(h),
    });
    input.setMapping(mapping(["KeyD", "KeyF", "KeyJ", "KeyK"]));

    // Three presses 5ms apart on one column: every one is inside the 12ms
    // deferral window of the previous.
    for (let i = 0; i < 3; i++) {
      const t = 1000 + i * 5;
      input.applyActions([action(t, "down", 1, "KeyF"), action(t, "up", 1, "KeyF")], t);
      env.advance(5);
    }
    // Let the final tap's deferred release elapse.
    env.advance(20);

    assert.equal(game.hits.length, 3, "every jack must register a hit");
    assert.equal(game.releases.length, 3, "and a matching release");
    assert.equal(input.flushedEarlyRelease, 2, "two presses arrived inside a deferral window");
    assert.equal(input.suppressedDuplicate, 0, "none of them should have been dropped");
    assert.equal(game.pressedColumns[1], false, "column must end up released");
    assert.equal(input.heldCount, 0);
    input.dispose();
  });

  it("still suppresses a true duplicate press with no pending release", () => {
    const game = installFakeGame(["KeyD", "KeyF", "KeyJ", "KeyK"]);
    const input = new InputManager({
      target: env.document,
      eventCtor: StubKeyboardEvent as any,
      minTapHoldMs: 12,
      now: () => env.now(),
      scheduleTask: (fn, ms) => env.window.setTimeout(fn, ms),
      cancelTask: (h) => env.window.clearTimeout(h),
    });
    input.setMapping(mapping(["KeyD", "KeyF", "KeyJ", "KeyK"]));

    // A hold: press, then a second press with no release in between.
    input.applyActions([action(1000, "down", 0, "KeyD")], 1000);
    input.applyActions([action(1050, "down", 0, "KeyD")], 1050);
    assert.equal(input.suppressedDuplicate, 1);
    assert.equal(input.flushedEarlyRelease, 0);
    assert.equal(game.hits.length, 1);
    assert.equal(game.pressedColumns[0], true, "the hold stays down");

    input.applyActions([action(1800, "up", 0, "KeyD")], 1800);
    assert.equal(game.pressedColumns[0], false);
    input.dispose();
  });

  it("handles rapid consecutive presses on one column", () => {
    const game = installFakeGame(["KeyD", "KeyF", "KeyJ", "KeyK"]);
    const input = new InputManager({
      target: env.document,
      eventCtor: StubKeyboardEvent as any,
      minTapHoldMs: 0, // fire releases synchronously, worst case for jacks
      now: () => env.now(),
    });
    input.setMapping(mapping(["KeyD", "KeyF", "KeyJ", "KeyK"]));

    for (let i = 0; i < 40; i++) {
      const t = 1000 + i * 30;
      input.applyActions([action(t, "down", 1, "KeyF"), action(t, "up", 1, "KeyF")], t);
    }
    assert.equal(game.hits.length, 40, "every jack must register");
    assert.equal(game.releases.length, 40);
    assert.equal(game.pressedColumns[1], false);
    input.dispose();
  });
});

describe("keyFromCode", () => {
  it("translates the codes the site actually uses", () => {
    assert.equal(keyFromCode("Space"), " ");
    assert.equal(keyFromCode("KeyD"), "d");
    assert.equal(keyFromCode("KeyK"), "k");
    assert.equal(keyFromCode("Digit7"), "7");
    assert.equal(keyFromCode("Semicolon"), ";");
    assert.equal(keyFromCode("F7"), "F7");
    assert.equal(keyFromCode("ArrowLeft"), "Left");
    assert.equal(keyFromCode(""), "");
  });
});
