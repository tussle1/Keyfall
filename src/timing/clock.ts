/**
 * Host clock <-> chart clock mapping.
 *
 * Why this exists
 * ---------------
 * `performance.now()` is the only high-resolution clock a script can read, but
 * the site judges input against its own `timeElapsed`, which is
 * `Math.round(song.seek() * 1000)` — the audio element's position, sampled
 * once per rendered frame. The two clocks drift apart for several reasons:
 *
 *   - audio output latency (the site subtracts `outputLatency` itself)
 *   - the `playbackRate` mod (song speed changes the chart clock's slope)
 *   - frame pacing (chart time only advances when a frame renders)
 *   - seeking, pausing, resuming, retrying
 *
 * So we fit a linear model  chartTime = slope * hostTime + intercept  from
 * recent samples, and use it to *predict* when a note's chart time will occur
 * in host-clock terms. That prediction is what the scheduler arms timers
 * against.
 *
 * The model is continuously refit and instantly discarded on discontinuity
 * (seek/pause/retry), which is detected by chart time jumping backwards or by
 * a slope that no longer matches observation.
 */

export interface ClockSample {
  host: number;
  chart: number;
}

export interface ClockState {
  /** chart = slope * host + intercept */
  slope: number;
  intercept: number;
  samples: number;
  /** Root-mean-square residual of the fit, ms. */
  error: number;
  /** True when the fit is good enough to schedule precisely against. */
  confident: boolean;
}

const WINDOW_SIZE = 24;
/** A chart-time jump backwards by more than this is a seek/pause/retry. */
const BACKWARD_JUMP_TOLERANCE = 2;
/** Slopes outside this range are treated as invalid observations. */
const SLOPE_MIN = 0.05;
const SLOPE_MAX = 8;

/**
 * Forward-seek detection limits.
 *
 * `SEEK_RATIO_LIMIT` is the most chart-ms-per-host-ms we accept as normal
 * playback. The site's own speed mod tops out well below this, so anything
 * past it means the playhead was moved rather than played.
 *
 * `SEEK_ABSOLUTE_FLOOR` stops an ordinary frame step plus a bit of scheduling
 * slack from being misread as a seek: a jump has to be at least this far ahead
 * of host time to count.
 */
const SEEK_RATIO_LIMIT = 4;
const SEEK_ABSOLUTE_FLOOR = 500;

export class ClockMapper {
  private samples: ClockSample[] = [];
  private slope = 1;
  private intercept = 0;
  private rms = Infinity;
  private last: ClockSample | null = null;
  private discontinuities = 0;

  /** Bumped whenever the model is reset; lets consumers detect a re-sync. */
  public epoch = 0;

  /**
   * Record one observation. Returns true if a discontinuity was detected
   * (caller should treat any already-armed timers as suspect).
   */
  sample(host: number, chart: number): boolean {
    if (!Number.isFinite(host) || !Number.isFinite(chart)) return false;

    let discontinuity = false;

    if (this.last) {
      const dChart = chart - this.last.chart;
      const dHost = host - this.last.host;

      // Chart time went backwards -> seek back, retry, or restart.
      if (dChart < -BACKWARD_JUMP_TOLERANCE) discontinuity = true;

      // Host clock stalled (tab throttled) while chart advanced: the fit would
      // be poisoned, so drop rather than trust it.
      if (dHost <= 0 && dChart > 1) discontinuity = true;

      // Forward seek: the chart clock moves *disproportionately* to host time.
      //
      // This must be a ratio test, not "big jump". A frame stall recovering
      // also produces a big jump — but proportionally (400ms of host time,
      // 400ms of chart time), and those notes really are due, so they must be
      // played rather than skipped. A seek moves the playhead without moving
      // the wall clock.
      //
      // The absolute floor keeps a normal 16ms frame step with ordinary
      // scheduling slack from being mistaken for a seek.
      const plausibleChartAdvance = Math.max(dHost * SEEK_RATIO_LIMIT, dHost + SEEK_ABSOLUTE_FLOOR);
      if (dChart > plausibleChartAdvance) discontinuity = true;
    }

    if (discontinuity) {
      this.reset();
      this.discontinuities++;
    }

    this.samples.push({ host, chart });
    if (this.samples.length > WINDOW_SIZE) this.samples.shift();
    this.last = { host, chart };

    this.refit();
    return discontinuity;
  }

  /** Least-squares fit over the sample window. */
  private refit(): void {
    const n = this.samples.length;
    if (n < 2) {
      // Not enough to fit a line; anchor on the single observation.
      if (n === 1) {
        const s = this.samples[0];
        this.slope = 1;
        this.intercept = s.chart - s.host;
        this.rms = Infinity;
      }
      return;
    }

    let sumX = 0;
    let sumY = 0;
    for (let i = 0; i < n; i++) {
      sumX += this.samples[i].host;
      sumY += this.samples[i].chart;
    }
    const meanX = sumX / n;
    const meanY = sumY / n;

    let num = 0;
    let den = 0;
    for (let i = 0; i < n; i++) {
      const dx = this.samples[i].host - meanX;
      num += dx * (this.samples[i].chart - meanY);
      den += dx * dx;
    }

    const slope = den > 1e-9 ? num / den : this.slope;
    if (!Number.isFinite(slope) || slope < SLOPE_MIN || slope > SLOPE_MAX) {
      // Degenerate fit (all samples at the same host time, or nonsense).
      return;
    }

    this.slope = slope;
    this.intercept = meanY - slope * meanX;

    let sq = 0;
    for (let i = 0; i < n; i++) {
      const predicted = slope * this.samples[i].host + this.intercept;
      const residual = this.samples[i].chart - predicted;
      sq += residual * residual;
    }
    this.rms = Math.sqrt(sq / n);
  }

  /** Predict chart time at a given host time. */
  chartAt(host: number): number {
    return this.slope * host + this.intercept;
  }

  /**
   * Predict the host time at which chart time `target` will occur.
   * This is what timers are armed against.
   */
  hostAt(target: number): number {
    if (Math.abs(this.slope) < 1e-9) return performance.now();
    return (target - this.intercept) / this.slope;
  }

  /** Latest observed chart time, without going through the model. */
  latestChart(): number | null {
    return this.last?.chart ?? null;
  }

  getState(): ClockState {
    return {
      slope: this.slope,
      intercept: this.intercept,
      samples: this.samples.length,
      error: this.rms,
      // Trust the fit once we have a reasonable window and a tight residual.
      confident: this.samples.length >= 6 && this.rms < 12,
    };
  }

  get discontinuityCount(): number {
    return this.discontinuities;
  }

  reset(): void {
    this.samples.length = 0;
    this.last = null;
    this.slope = 1;
    this.intercept = 0;
    this.rms = Infinity;
    this.epoch++;
  }

  /** Hard reset including the discontinuity counter (new beatmap). */
  hardReset(): void {
    this.reset();
    this.discontinuities = 0;
  }
}
