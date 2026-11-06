import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { Guards } from "../src/engine/guards";
import { installDom, type StubEnvironment } from "./helpers/domStub";

let env: StubEnvironment;
beforeEach(() => { env = installDom({ start: 0 }); env.globalsInstalled(); });
afterEach(() => env.globalsRemoved());

function setup() {
  let chart = 0;
  let pending: number | null = null;
  let released = 0;
  const reasons: string[] = [];
  const held = new Map([[0, 1000]]);
  const guards = new Guards({
    releaseAll: () => { released++; held.clear(); },
    onPanic: (reason) => reasons.push(reason),
    isGameAlive: () => true,
    chartTime: () => chart,
    heldColumns: () => [...held.keys()],
    heldSince: () => held,
    pendingReleaseAt: () => pending,
  }, { win: env.window, stuckKeyTimeout: 20_000, watchdogInterval: 500 });
  guards.install();
  return {
    guards, held, reasons,
    setChart: (value: number) => { chart = value; },
    setPending: (value: number | null) => { pending = value; },
    get released() { return released; },
  };
}

describe("stuck-key watchdog during stalls", () => {
  it("does not interrupt a legitimate long hold with a scheduled future tail", () => {
    const h = setup();
    h.setChart(25_000); h.setPending(45_000); env.advance(500);
    assert.deepEqual(h.reasons, []);
    assert.equal(h.released, 0);
    h.guards.dispose();
  });

  it("gives an overdue scheduled release one watchdog cycle to recover after a long stall", () => {
    const h = setup();
    h.setChart(50_000); h.setPending(2000); env.advance(500);
    assert.deepEqual(h.reasons, [], "the watchdog may wake before the scheduler");
    h.held.clear(); // the delayed scheduler/tap-release timer caught up
    env.advance(500);
    assert.deepEqual(h.reasons, []);
    h.guards.dispose();
  });

  it("still stops and releases when an overdue scheduled tail never recovers", () => {
    const h = setup();
    h.setChart(50_000); h.setPending(2000); env.advance(500);
    assert.deepEqual(h.reasons, []);
    env.advance(500);
    assert.match(h.reasons[0], /Stuck key/);
    assert.equal(h.released, 1);
    h.guards.dispose();
  });

  it("still panics immediately for a stuck key without any scheduled release", () => {
    const h = setup();
    h.setChart(25_000); env.advance(500);
    assert.match(h.reasons[0], /Stuck key/);
    assert.equal(h.released, 1);
    h.guards.dispose();
  });
});
