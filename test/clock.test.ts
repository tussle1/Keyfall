import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ClockMapper } from "../src/timing/clock";

describe("ClockMapper", () => {
  it("anchors on a single sample", () => {
    const clock = new ClockMapper();
    clock.sample(1000, 500);
    // chart = host - 500
    assert.equal(clock.chartAt(2000), 1500);
    assert.equal(clock.hostAt(1500), 2000);
  });

  it("fits a 1:1 mapping when both clocks advance together", () => {
    const clock = new ClockMapper();
    for (let i = 0; i < 12; i++) {
      clock.sample(1000 + i * 100, 500 + i * 100);
    }
    const state = clock.getState();
    assert.ok(Math.abs(state.slope - 1) < 1e-6, `slope was ${state.slope}`);
    assert.ok(state.error < 1e-6, `residual was ${state.error}`);
    assert.equal(state.confident, true);
    assert.equal(Math.round(clock.chartAt(2200)), 1700);
  });

  it("recovers the playback rate as the slope", () => {
    const clock = new ClockMapper();
    // Chart advances 1.5ms per 1ms of host time (1.5x song speed).
    for (let i = 0; i < 20; i++) {
      clock.sample(1000 + i * 50, 200 + i * 75);
    }
    const state = clock.getState();
    assert.ok(Math.abs(state.slope - 1.5) < 1e-6, `slope was ${state.slope}`);
    // hostAt must invert it: chart 2000 should be reached earlier than chart/1.
    const host = clock.hostAt(2000);
    assert.ok(Math.abs(clock.chartAt(host) - 2000) < 1e-6);
  });

  it("detects a backwards jump as a discontinuity and refits", () => {
    const clock = new ClockMapper();
    for (let i = 0; i < 10; i++) clock.sample(1000 + i * 100, 500 + i * 100);
    const epochBefore = clock.epoch;

    const discontinuity = clock.sample(2000, 300); // seek back
    assert.equal(discontinuity, true);
    assert.equal(clock.epoch, epochBefore + 1);
    assert.equal(clock.getState().samples, 1);
  });

  it("detects a forward seek as a discontinuity", () => {
    const clock = new ClockMapper();
    for (let i = 0; i < 10; i++) clock.sample(1000 + i * 100, 500 + i * 100);
    // One step forward by 60s while host advanced 100ms.
    assert.equal(clock.sample(2000, 60_500), true);
  });

  it("tolerates small negative jitter without calling it a seek", () => {
    const clock = new ClockMapper();
    for (let i = 0; i < 10; i++) clock.sample(1000 + i * 100, 500 + i * 100);
    // Chart time is quantised to whole ms by the site, so -1ms noise is normal.
    assert.equal(clock.sample(2000, 1499), false);
  });

  it("detects a stalled host clock", () => {
    const clock = new ClockMapper();
    for (let i = 0; i < 6; i++) clock.sample(1000 + i * 100, 500 + i * 100);
    // Same host time, chart advanced: the fit would be poisoned.
    assert.equal(clock.sample(1500, 1400), true);
  });

  it("is not confident until it has enough samples", () => {
    const clock = new ClockMapper();
    clock.sample(1000, 500);
    clock.sample(1016, 516);
    assert.equal(clock.getState().confident, false);
    for (let i = 2; i < 10; i++) clock.sample(1000 + i * 16, 500 + i * 16);
    assert.equal(clock.getState().confident, true);
  });

  it("rejects a degenerate fit where all host times are identical", () => {
    const clock = new ClockMapper();
    clock.sample(1000, 500);
    clock.sample(1000.0001, 900);
    clock.sample(1000.0002, 1400);
    // Slope would be absurd; the mapper must not adopt it.
    const state = clock.getState();
    assert.ok(state.slope <= 8, `slope was ${state.slope}`);
  });

  it("ignores non-finite samples", () => {
    const clock = new ClockMapper();
    clock.sample(1000, 500);
    assert.equal(clock.sample(NaN, 600), false);
    assert.equal(clock.sample(1100, NaN), false);
    assert.equal(clock.getState().samples, 1);
  });

  it("reports latestChart without going through the model", () => {
    const clock = new ClockMapper();
    assert.equal(clock.latestChart(), null);
    clock.sample(1000, 500);
    assert.equal(clock.latestChart(), 500);
    clock.sample(1100, 600);
    assert.equal(clock.latestChart(), 600);
  });

  it("hardReset clears the discontinuity counter", () => {
    const clock = new ClockMapper();
    for (let i = 0; i < 6; i++) clock.sample(1000 + i * 100, 500 + i * 100);
    clock.sample(2000, 100); // discontinuity
    assert.ok(clock.discontinuityCount >= 1);
    clock.hardReset();
    assert.equal(clock.discontinuityCount, 0);
    assert.equal(clock.getState().samples, 0);
  });

  it("hostAt never returns NaN", () => {
    const clock = new ClockMapper();
    assert.ok(Number.isFinite(clock.hostAt(1000)));
    clock.sample(1000, 500);
    assert.ok(Number.isFinite(clock.hostAt(1000)));
  });

  it("keeps a bounded sample window", () => {
    const clock = new ClockMapper();
    for (let i = 0; i < 500; i++) clock.sample(1000 + i * 16, 500 + i * 16);
    assert.ok(clock.getState().samples <= 24);
    assert.ok(Math.abs(clock.getState().slope - 1) < 1e-6);
  });
});
