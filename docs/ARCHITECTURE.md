# Keyfall architecture

```
                    ┌──────────────────────────────────────────┐
                    │              src/main.ts                 │
                    │  bootstrap · console API · wiring        │
                    └───────────────┬──────────────────────────┘
                                    │
        ┌───────────────────────────┼───────────────────────────┐
        │                           │                           │
┌───────▼────────┐         ┌────────▼────────┐         ┌────────▼────────┐
│  core/settings │         │  engine/engine  │         │  ui/overlay     │
│  persistence   │◄────────┤  state machine  ├────────►│  keyboard       │
│  validation    │         │  orchestration  │  events │  debug          │
└────────────────┘         └───┬────┬────┬───┘         └─────────────────┘
                               │    │    │
                 ┌─────────────┘    │    └──────────────┐
                 │                  │                   │
        ┌────────▼───────┐  ┌───────▼────────┐  ┌───────▼────────┐
        │    detect/     │  │    timing/     │  │    input/      │
        │ siteDetection  │  │ clock          │  │ InputManager   │
        │ pixiHook       │  │ scheduler      │  └───────┬────────┘
        │ fiber          │  └───────▲────────┘          │
        │ buildContext   │          │                   │
        │ chartSource    │  ┌───────┴────────┐          │
        │ osuFileParser  │  │  chart/        │          │
        └────────┬───────┘  │  timeline      │          │
                 │          └────────────────┘          │
                 └──────────────────────────────────────┘
                                │
                    ┌───────────▼────────────┐
                    │  document.dispatchEvent │
                    │  KeyboardEvent(code)    │
                    └───────────┬────────────┘
                                │
                    ┌───────────▼────────────┐
                    │   Web osu!mania's own   │
                    │   InputSystem → scoring │
                    └────────────────────────┘
```

Data flow for one beatmap:

```
Game detected → ParsedChart ─┐
                             ├→ Humanizer.prepare()   (optional; per-note deltas
ChartAnalysis ◄──────────────┘                          and release ceilings)
                             │
                             ▼
                    Timeline (InputAction[])
                             │
                             ▼
                        Scheduler ────► ClockMapper (host ↔ chart time)
                             │
                             ▼
                       InputManager
                             │
                             ▼
                 document KeyboardEvents
                             │
                             ▼
            site's InputSystem.hit/release
                             │
                             ▼
            site's ScoreSystem → stats readback
```

Humanization sits between the parsed chart and the timeline rather than between
the timeline and the scheduler. See
[Humanization](#humanization-why-it-is-baked-into-the-timeline) below.

## Module responsibilities

| Module | Owns | Deliberately does *not* do |
|---|---|---|
| `detect/siteDetection` | "is this Web osu!mania?" | Anything about gameplay |
| `detect/pixiHook` | Ordered acquisition strategies | Interpreting the game it finds |
| `detect/fiber` | React fiber traversal, shape-based `Game` recognition | Any name-based coupling |
| `detect/buildContext` | `Game` → `ParsedChart` + `KeyMapping` | Scheduling or input |
| `detect/osuFileParser` | `.osu` text → chart (fallback) | Reading the live game |
| `detect/chartSource` | Read-only `.osz` observation + minimal ZIP reader | Modifying any request |
| `chart/timeline` | Chart → ordered `InputAction[]`, pattern analysis | Timing or input |
| `humanize/humanizer` | Reproducible per-note timing deltas and release ceilings | Knowing what a key is |
| `util/rng` | Seeded PRNG, uniform and normal sampling | Any policy decision |
| `timing/clock` | `performance.now()` ↔ chart-time linear model | Deciding what to fire |
| `timing/scheduler` | Look-ahead arming, catch-up, batching, cursor | Knowing what a note is |
| `input/InputManager` | Synthetic key events, held-state tracking | Deciding *when* |
| `engine/guards` | Stuck-key, liveness, lifecycle safety | Gameplay logic |
| `engine/stats` | Reading the site's own score/combo/accuracy | Recomputing accuracy |
| `engine/engine` | Phase machine, wiring, teardown | Any of the above directly |
| `ui/*` | Overlay, keyboard view, debug panel | Touching the engine's internals |
| `core/settings` | Persistence, validation, clamping | Knowing what settings mean |

The rule throughout: **each layer only sees the types of the layer below it.**
Nothing downstream of `buildContext` ever touches a site object, which is what
makes the detection strategies independently replaceable.

## Design decisions worth knowing

### Why `performance.now()` needs a model, not a constant

The site judges input against `game.timeElapsed = Math.round(song.seek() * 1000)`.
That clock:

- quantises to whole milliseconds,
- only advances when a frame renders,
- has a slope equal to the playback-rate mod,
- jumps discontinuously on seek, pause, retry and restart,
- already includes the site's `audioOffset` and `outputLatency` corrections.

So `timing/clock.ts` fits `chart = slope × host + intercept` over a sliding
24-sample window by least squares, reports its own residual, and declares
`confident` only once it has enough samples and a tight fit. `hostAt(target)`
inverts the model, and that prediction is what timers are armed against.

Discontinuity detection is the subtle part. A **backward** chart jump is always
a seek. A **forward** jump is ambiguous: a frame stall recovering also produces
a large forward jump, but proportionally to elapsed host time, and those notes
are genuinely due. Only a *disproportionate* forward jump is a seek:

```ts
const plausibleChartAdvance = Math.max(dHost * SEEK_RATIO_LIMIT, dHost + SEEK_ABSOLUTE_FLOOR);
if (dChart > plausibleChartAdvance) discontinuity = true;
```

An earlier version used `dChart > dHost * 8 + 250`, which misclassified a
400ms stall as a seek and skipped real notes. There is a regression test.

### Why one rAF loop and not one timer per note

The scheduler keeps a single `requestAnimationFrame` heartbeat. Each frame it:

1. samples the clock (and lets the clock model request a cursor resync),
2. flushes anything already overdue, bounded by `MAX_CATCHUP_ACTIONS_PER_FRAME`,
3. arms at most **one** timer for the next same-timestamp batch inside the
   lookahead window.

That timer fires `spinThreshold` ms early, then busy-waits the remainder against
an absolute deadline. Two independent budgets guard the spin: the deadline and a
hard iteration cap, because the deadline derives from a *predicted* clock.

An earlier version computed the spin as `while (now() < now() + remaining)`.
That reads as bounded but is not: if the clock does not advance (a frozen or
stubbed `performance.now`), neither side of the comparison moves and the loop
never exits. The comparison must be against an absolute target captured once.
There is a regression test.

### Why the timing offset lives in the scheduler

The offset has to shift when an action is *due*. There are two paths that
decide that — the armed-timer path and the catch-up path — and they must agree.
An earlier version applied the offset only inside `hostTimeForChart`, which
affects the armed path alone; any note fired by catch-up ignored the offset
entirely. `Scheduler.setActionOffset` now owns it and applies it uniformly via
`dueTime(index)`, and changing it rebases the cursor.

### Why action ordering matches the site exactly

`ReplayPlayer` builds `[column, time, isDown]` tuples and sorts by time alone,
relying on a stable sort to preserve construction order (press then release, per
hit object). `chart/timeline.ts` reproduces that: construction order then a
stable sort on time, with **no** type tiebreaker.

Adding `up < down` at equal times looks like an improvement and is not — it
would diverge from the site's own replay semantics. The ordering that actually
matters falls out of construction order for free: a hold ending at the same
instant the next note on that column begins emits its release first, so the
press is not swallowed by the site's `if (this.pressedColumns[column]) return`.

### Why hold heads are dropped in a pre-pass

The site stores each hold as two objects. The head tap can sort either before or
after the hold depending on the comparator, so a "compare with the previous
note" check is order-dependent and silently breaks. Pass 1 collects every hold's
`time:column:endTime` into a `Set`; pass 2 skips any tap that matches. Order
independent, and it also honours an explicit `isHoldHead` flag when present.

### Why a tap's release is deferred

The site's own autoplay emits a tap's press and release at the same timestamp.
Dispatching both in one synchronous batch is faithful but leaves zero key-down
time. `InputManager` defers the release by `minTapHoldMs` (12ms default) — far
inside the tightest judgement window (~±22ms), and closer to how a physical key
behaves.

That creates a trap: a **jack faster than the deferral** would find the column
still held and drop the press, and the site would drop it too because its own
`pressedColumns` is still `true`. So `keyDown`, on finding a pending deferred
release, cancels it, emits the release immediately, then presses — reproducing
what a physical key does. Counted as `flushedEarlyRelease` in diagnostics.
Regression tested.

### Why the state monitor is not on the firing path

If a play fails between notes, nothing fires, so a check inside the fire
callback would never run — with a hold still pinned. `checkSiteState()` runs on
its own 100ms timer and covers `RUNNING`, `PAUSED` and `READY` (a play can fail
after the last action, while the site transitions to its results screen).

### Why stats are read, not computed

`game.scoreSystem` already exposes `score`, `combo`, `accuracy` and per-judgement
counts as plain numbers. Reading them is a few property accesses and is exactly
what the results screen will show. Re-deriving accuracy would risk disagreeing
with the site.

### Why the UI writes through `setText` / `setDataset`

The readout updates several times a second. Assigning `textContent`
unconditionally forces work every time even when nothing changed; both helpers
no-op on an unchanged value, so DOM writes are proportional to actual change.
The debug panel buffers and flushes on an interval instead of appending per
event, and when debug mode is off it allocates nothing at all.

### Humanization: why it is baked into the timeline

It would be simpler to perturb each action at fire time. That does not work, for
two reasons that are both about *ordering* rather than timing:

- A chord is several notes at one timestamp. Perturbing each action
  independently spreads them apart, turning a chord into a rapid arpeggio. The
  delta has to be computed per *timestamp* and shared.
- The timeline's sort is what guarantees a hold ending exactly where the next
  note on that column begins releases before pressing. Perturbing after the sort
  cannot preserve that.

So deltas are applied before the sort, and `chart/timeline.ts` runs three passes:
collect hold keys, select the playable notes, emit actions.

The selection pass matters more than it looks. The humanizer must see exactly the
notes that will be played, in order, and nothing else — a dropped hold head would
otherwise consume a drift sample and shift everything after it.

**Two passes inside the humanizer, too.** A hold's release has to be clamped
against the *next* press on that column, and that press's shifted time is not
known until every note delta exists. A single streaming pass cannot do this: it
would clamp against a ceiling that has not been computed yet, and a late release
would swallow the next note — the site's `hit()` early-returns while the column is
down, so the press is dropped and the key stays pinned. `prepare()` therefore
computes every delta and every release ceiling up front, and reading an edge
afterwards is a pure lookup. That also makes the result independent of call
ordering.

**Determinism has one non-obvious failure mode.** The Gaussian sampler caches one
value per pair (Marsaglia polar). Rewinding only the PRNG state on `reseed()`
left that spare behind, so consecutive runs *alternated* between two sequences
instead of repeating one. It surfaced as fatigue-dependent non-reproducibility,
because fatigue happens to draw an odd number of samples for many chart lengths.
`reseed()` clears the spare; there is a regression test that sweeps both
parities.

**Drift is bounded, not just mean-reverting.** An Ornstein–Uhlenbeck process
returns to zero in expectation, which is not a guarantee on any finite run. Both
drift processes get a hard clamp, because "the wobble cannot become an accidental
offset" is a property worth enforcing rather than assuming — that is what the
Timing Offset control is for.

**Pattern awareness tightens intervals, not just variance.** Reducing the sd
inside a jack is not enough: what a player keeps consistent in a repeated pattern
is the *interval* between hits, not the absolute offset. So a jack blends toward
the previous note's delta at `patternAware` weight. At full pattern awareness a
perfect jack keeps its spacing almost exactly while the run as a whole still
wanders.

**Chords are not a pattern.** Classification looks backwards at one note's own
column, so it cannot see a group property. `chord` was removed from the pattern
enum: chords are handled by delta sharing and counted separately as
`chordMembers`. An earlier version tried to reclassify a chord's first member
retrospectively, which made the counts depend on arrival order.

## Testing

229 tests, `node --test`, no test framework dependency, plus a 28-check smoke test
that runs the shipped bundle.

Node strips TypeScript types natively (≥22.18) but still requires fully
specified ESM paths, while the source uses extensionless imports (correct for a
bundler and for `tsc`). `test/helpers/tsLoader.mjs` is a resolve hook that adds
the missing `.ts`; nothing is transformed.

`test/helpers/domStub.ts` is a hand-rolled minimal DOM plus a **manual clock**.
Nothing runs until `advance()` is called, so every timing assertion is exact
rather than flaky.

Coverage: `.osu` parsing (1K–18K, holds, mirror, holdOff, delay, audio offset,
playback rate, malformed input, rejection cases), timeline ordering and
deduplication, clock fitting and discontinuity classification, scheduler
ordering/batching/catch-up/seek/pause/stop, input dispatch including the jack
regression, settings validation and persistence, seeded RNG distributions,
humanization determinism and its ordering invariants, and 32 end-to-end tests that
drive a stubbed site through the real engine — including "no stuck keys" on stop,
emergency stop, dispose, play failure and game disappearance, and humanized
playback across five seeds with holds, release variation, fatigue and drift all
at maximum.

The humanization tests are written to fail on the silent breakages rather than the
audible ones. "Every press was released" and "presses and releases alternate per
column" are asserted across seeds; "the timing sounds human" is not asserted at
all, because nothing can check that and a test that pretends to would only hide a
regression.
