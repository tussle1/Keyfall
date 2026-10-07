import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SeededRandom } from "../src/util/rng";

describe("SeededRandom", () => {
  it("is deterministic for a given seed", () => {
    const a = new SeededRandom(12345);
    const b = new SeededRandom(12345);
    for (let i = 0; i < 500; i++) {
      assert.equal(a.uniform(), b.uniform(), `diverged at ${i}`);
    }
  });

  it("produces different sequences for different seeds", () => {
    const a = new SeededRandom(1);
    const b = new SeededRandom(2);
    const seqA = Array.from({ length: 20 }, () => a.uniform());
    const seqB = Array.from({ length: 20 }, () => b.uniform());
    assert.notDeepEqual(seqA, seqB);
  });

  it("does not correlate nearby seeds", () => {
    // A weak seeder would make seed 1 and seed 2 start almost identically.
    const a = new SeededRandom(1);
    const b = new SeededRandom(2);
    assert.ok(Math.abs(a.uniform() - b.uniform()) > 0.01);
  });

  it("keeps uniform() inside [0, 1)", () => {
    const rng = new SeededRandom(99);
    for (let i = 0; i < 20000; i++) {
      const v = rng.uniform();
      assert.ok(v >= 0 && v < 1, `out of range: ${v}`);
    }
  });

  it("produces a roughly uniform distribution", () => {
    const rng = new SeededRandom(7);
    const buckets = new Array(10).fill(0);
    const n = 50000;
    for (let i = 0; i < n; i++) buckets[Math.floor(rng.uniform() * 10)]++;
    const expected = n / 10;
    for (const count of buckets) {
      // Generous: this is a sanity check on the generator, not a chi-squared test.
      assert.ok(Math.abs(count - expected) < expected * 0.08, `bucket off: ${count}`);
    }
  });

  it("has a mean near 0.5", () => {
    const rng = new SeededRandom(4242);
    let sum = 0;
    const n = 50000;
    for (let i = 0; i < n; i++) sum += rng.uniform();
    const mean = sum / n;
    assert.ok(Math.abs(mean - 0.5) < 0.01, `mean ${mean}`);
  });

  it("produces a standard normal from gaussian()", () => {
    const rng = new SeededRandom(2024);
    let sum = 0;
    let sumSq = 0;
    const n = 50000;
    for (let i = 0; i < n; i++) {
      const v = rng.gaussian();
      assert.ok(Number.isFinite(v), "gaussian returned a non-finite value");
      sum += v;
      sumSq += v * v;
    }
    const mean = sum / n;
    const variance = sumSq / n - mean * mean;
    assert.ok(Math.abs(mean) < 0.03, `mean ${mean}`);
    assert.ok(Math.abs(variance - 1) < 0.06, `variance ${variance}`);
  });

  it("never returns Infinity or NaN from gaussian()", () => {
    // The Marsaglia polar method divides by the sampled radius; seed 0 and a
    // large sweep must not hit the degenerate case.
    for (const seed of [0, 1, 2, 4294967295]) {
      const rng = new SeededRandom(seed);
      for (let i = 0; i < 5000; i++) {
        const v = rng.gaussian();
        assert.ok(Number.isFinite(v), `seed ${seed} produced ${v}`);
      }
    }
  });

  it("scales gaussian by the requested mean and sd", () => {
    const rng = new SeededRandom(31337);
    let sum = 0;
    let sumSq = 0;
    const n = 40000;
    const mean = 5;
    const sd = 2.5;
    for (let i = 0; i < n; i++) {
      const v = rng.normal(mean, sd);
      sum += v;
      sumSq += (v - mean) * (v - mean);
    }
    assert.ok(Math.abs(sum / n - mean) < 0.08, `mean ${sum / n}`);
    assert.ok(Math.abs(Math.sqrt(sumSq / n) - sd) < 0.12, `sd ${Math.sqrt(sumSq / n)}`);
  });

  it("keeps range() inside its bounds", () => {
    const rng = new SeededRandom(555);
    for (let i = 0; i < 10000; i++) {
      const v = rng.range(-3.5, 7.25);
      assert.ok(v >= -3.5 && v < 7.25, `out of range: ${v}`);
    }
  });

  it("keeps int() inside its inclusive bounds", () => {
    const rng = new SeededRandom(808);
    const seen = new Set<number>();
    for (let i = 0; i < 5000; i++) {
      const v = rng.int(2, 5);
      assert.ok(Number.isInteger(v) && v >= 2 && v <= 5, `bad int ${v}`);
      seen.add(v);
    }
    assert.equal(seen.size, 4, "every value in the inclusive range should appear");
  });

  it("hashes strings stably and distinctly", () => {
    assert.equal(SeededRandom.hash("abc"), SeededRandom.hash("abc"));
    assert.notEqual(SeededRandom.hash("abc"), SeededRandom.hash("abd"));
    assert.equal(typeof SeededRandom.hash(""), "number");
    assert.ok(Number.isFinite(SeededRandom.hash("")), "empty string must not produce NaN");
  });

  it("normalises a negative or fractional seed", () => {
    // Seeds arrive from user input; the generator must not produce NaN.
    for (const seed of [-1, -0.5, 1.9, Number.MAX_SAFE_INTEGER]) {
      const rng = new SeededRandom(seed);
      for (let i = 0; i < 100; i++) {
        assert.ok(Number.isFinite(rng.uniform()), `seed ${seed} produced a non-finite value`);
      }
    }
  });

  it("interleaves gaussian() without losing the cached spare", () => {
    // gaussian() caches one value per pair. Calling it an odd number of times
    // then continuing must not skip or duplicate a sample.
    const a = new SeededRandom(1234);
    const b = new SeededRandom(1234);
    const seqA: number[] = [];
    const seqB: number[] = [];
    for (let i = 0; i < 11; i++) seqA.push(a.gaussian());
    for (let i = 0; i < 11; i++) seqB.push(b.gaussian());
    assert.deepEqual(seqA, seqB);
    // And consuming other values in between must not corrupt the spare.
    const c = new SeededRandom(1234);
    c.gaussian();
    c.uniform();
    const d = new SeededRandom(1234);
    d.gaussian();
    d.uniform();
    assert.equal(c.gaussian(), d.gaussian());
  });
});
