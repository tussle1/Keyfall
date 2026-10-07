/**
 * Deterministic random number generation.
 *
 * `Math.random()` is not usable here: a run must be reproducible from a seed so
 * that the same chart with the same seed produces byte-identical input timing,
 * which is what makes humanised runs comparable and debuggable. Everything in
 * this module is pure integer/float arithmetic with no external dependency.
 */

/**
 * mulberry32 — a small, fast 32-bit PRNG.
 *
 * Deliberately chosen for having almost no moving parts: one state word, five
 * operations. An earlier version of this file used sfc32, which has four state
 * words and 32-bit wraparound arithmetic on every step; it was ported
 * incorrectly twice (the counter was left out of the output, then an `imul`
 * term was dropped), and both mistakes produced output that *looked* random but
 * failed a bucket-uniformity test and a mean test. A generator this small can be
 * read and verified at a glance, which is worth more here than sfc32's longer
 * period — a beatmap consumes a few thousand samples, not 2^128 of them.
 */
export class SeededRandom {
  private state: number;
  readonly seed: number;

  constructor(seed: number) {
    this.seed = seed >>> 0;
    // Run the seed through a mixing pass so that nearby seeds do not produce
    // nearby first outputs (mulberry32's own avalanche is per-call, not at
    // initialisation).
    this.state = SeededRandom.mix(this.seed);
  }

  /** Avalanche a 32-bit value, so `seed` and `seed + 1` diverge immediately. */
  private static mix(value: number): number {
    let z = (value + 0x9e3779b9) >>> 0;
    z = Math.imul(z ^ (z >>> 16), 0x21f0aaad) >>> 0;
    z = Math.imul(z ^ (z >>> 15), 0x735a2d97) >>> 0;
    return (z ^ (z >>> 15)) >>> 0;
  }

  /**
   * Rewind to a seed. Used when a timeline is rebuilt so that the same seed and
   * the same chart always produce the same timing, not just on the first build.
   *
   * This must clear `spare` as well as the state. The Gaussian generator caches
   * one value per pair (Marsaglia polar), and an odd number of `gaussian()` calls
   * leaves a cached sample behind. Rewinding only `state` makes consecutive runs
   * *alternate* between two different sequences rather than repeat one — the
   * second run starts by handing back the first run's leftover spare. That is
   * exactly the kind of bug a determinism test catches and a "looks random"
   * eyeball never does.
   */
  reseed(seed: number): void {
    this.state = SeededRandom.mix(seed >>> 0);
    this.spare = null;
  }

  /** Raw 32-bit unsigned integer. */
  nextUint32(): number {
    // `state` is kept as a 32-bit *unsigned* value; the addition is allowed to
    // exceed 2^32 (doubles are exact well past that) and is folded back with
    // `>>> 0`. Everything after that stays within 32-bit integer range.
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0);
  }

  /** Uniform float in [0, 1). */
  uniform(): number {
    return this.nextUint32() / 4294967296;
  }

  /** Uniform float in [min, max). */
  range(min: number, max: number): number {
    return min + (max - min) * this.uniform();
  }

  /**
   * Standard normal sample via Box–Muller.
   *
   * The transform is guarded against `uniform()` returning exactly 0, which
   * would make `Math.log(0)` `-Infinity`. The second of each pair is cached so
   * the trig is amortised.
   */
  private spare: number | null = null;

  gaussian(): number {
    if (this.spare !== null) {
      const value = this.spare;
      this.spare = null;
      return value;
    }
    let u = 0;
    let v = 0;
    let s = 0;
    // Marsaglia polar method: rejection-samples inside the unit disc, which
    // avoids the `log(0)` and `cos/sin` cost of naive Box–Muller.
    do {
      u = this.uniform() * 2 - 1;
      v = this.uniform() * 2 - 1;
      s = u * u + v * v;
    } while (s === 0 || s >= 1);

    const mul = Math.sqrt((-2 * Math.log(s)) / s);
    this.spare = v * mul;
    return u * mul;
  }

  /** Normal sample with the given mean and standard deviation. */
  normal(mean: number, sd: number): number {
    return mean + this.gaussian() * sd;
  }

  /** Integer in [min, max], inclusive. */
  int(min: number, max: number): number {
    return min + Math.floor(this.uniform() * (max - min + 1));
  }

  /**
   * A stable 32-bit hash of a string, for deriving a seed from a chart
   * signature so that "random per chart" is still reproducible per chart.
   */
  static hash(text: string): number {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }
}
