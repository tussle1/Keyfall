# Web osu!mania Autoplay

Browser-side gameplay automation for [webosumania.com](https://webosumania.com/).
It detects the running game, reads the loaded chart, and drives the site's own
input path with synthetic keyboard events — no separate game, no renderer
recreation, no modification of the site.

Ships as a **userscript** (preferred), a plain script, or a **bookmarklet**.

> **Read this first.** The site already has a built-in Autoplay mod
> (Settings → Mods → Autoplay). If all you want is to watch a map played
> perfectly, use that — it is frame-exact and needs no timing model. This tool
> exists for the cases that mod does not cover: configurable key mappings,
> timing offsets, speed adjustment, live diagnostics, pattern analysis, and a
> control surface you can tune while a map runs. It refuses to start while the
> site's own Autoplay is enabled. See [`docs/SAFETY.md`](docs/SAFETY.md).

---

## Install

`dist/` is a build output and is gitignored, so build it first:

```bash
npm install && npm run build
```

That produces `dist/autoplay.user.js`, `dist/autoplay.js`, `dist/bookmarklet.txt`
and `dist/bookmarklet-loader.txt`.

### Userscript (recommended)

1. Install [Tampermonkey](https://www.tampermonkey.net/) or Violentmonkey.
2. Open `dist/autoplay.user.js` and accept the install prompt — or drag it onto
   the extension's dashboard.
3. Load `webosumania.com`. The overlay appears in the top-left.

### Plain script

Load `dist/autoplay.js` however you like (a devtools snippet, a local
extension, a `<script>` tag on a page you control). It exposes a console API:

```js
WebOsuManiaAutoplay.start();
WebOsuManiaAutoplay.diagnostics();
```

### Bookmarklet

`dist/bookmarklet.txt` is the whole tool as a `javascript:` URL — but at ~131 KB
most browsers will truncate it (the practical limit is around 64 KB). Two
workable options:

- **Hosted loader.** Put `dist/autoplay.js` somewhere you control, replace
  `RAW_URL_HERE` in `dist/bookmarklet-loader.txt`, and use that ~300-byte URL.
- **Use the userscript.** It has no size limit and survives navigation.

## Use

Open a beatmap and start playing. The overlay picks the game up on its own.

| Key | Action |
|---|---|
| `F6` | Toggle the UI (panel ⇄ mini bar ⇄ hidden) |
| `F7` | Start |
| `F8` | Pause / resume |
| `F9` | Stop |
| `F10` | **Emergency stop** — releases every key immediately, full reset |

All five are reconfigurable in Settings → General. The manager warns you if you
bind a hotkey to a code the site also uses as a column keybind.

The panel shows status, notes remaining, accuracy, combo and score (read from
the site's own score system), a timing-offset slider, speed, and a live keyboard
indicator that lights up as the automation presses columns. It is draggable
(title bar), resizable (bottom-right corner), collapsible to a mini bar, and
adjustable for opacity and scale.

**Timing Offset** shifts every input earlier or later, −200ms to +200ms in 1ms
steps. Positive fires earlier. Use it to correct for output latency or to
practise against an offset.

**Debug Mode** opens a log panel with structured `[DEBUG]` output — acquisition
strategy, clock fit and residual, scheduler arming, input dispatch, and every
guard trigger.

## Try it without the site

`npm run demo` serves a sandbox at <http://localhost:5173/> containing a stub
that implements the documented site contract (`demo/stub-game.js`) and the real,
unmodified `dist/autoplay.js` running against it. Pick a chart (4K with holds
and chords, a 7K stream, a 10K map), press **Play**, then press **F7**.

It is a demonstration harness, not a port of the game — the stub exists so the
bundle's detection, clock fitting, scheduling and input paths can be exercised
end to end without the live site.

## How it works

```
detect  →  window.__PIXI_APP__ → canvas → React fiber → the live Game
chart   →  game.hitObjects (holds arrive as head-tap + hold; the head is dropped)
mapping →  game.columnKeybinds, the site's own resolved keybinds for this run
clock   →  least-squares fit of chart time against performance.now()
schedule→  one rAF loop, look-ahead arming, one timer per same-timestamp batch
input   →  document.dispatchEvent(new KeyboardEvent("keydown", { code, repeat: false }))
verify  →  our held set is compared against the site's inputSystem.pressedColumns
```

The site's `InputSystem` listens for `keydown`/`keyup` on `document`, matches on
`event.code`, ignores `event.repeat`, and does not check `event.isTrusted` — so
synthetic events are judged by the site's own scoring against the site's own
clock. Nothing calls into private scoring code and nothing spoofs trust.

Full detail in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md). The site facts
this depends on, with source references, are in
[`docs/SITE-CONTRACT.md`](docs/SITE-CONTRACT.md).

### Key counts

Nothing is hardcoded to 4K. The key count comes from `game.difficulty.keyCount`,
cross-checked against `columnKeybinds.length` and the highest column referenced
by the chart, and the mapping is read from the site's own keybinds for that
count. 1K through 10K+ all work; a chart referencing a column beyond the
detected count raises the effective count rather than dropping notes. If the
site's keybinds cannot be read, a generated layout is used and you can override
any column by clicking it in Settings → Input and pressing a key.

### Timing

The site judges against `game.timeElapsed = Math.round(song.seek() * 1000)`,
which quantises to 1ms, only advances on rendered frames, has a slope equal to
the playback-rate mod, and jumps on seek or retry. So rather than assuming a
relationship, `timing/clock.ts` fits one: least squares over a sliding window,
with its own residual reported and a `confident` flag. Timers are armed against
the inverted model, then a bounded busy-spin closes the last few milliseconds.

One `requestAnimationFrame` loop drives everything. There is no timer per note.
A frame flushes whatever is overdue (bounded, with an overrun report rather than
jamming every column at once) and arms at most one timer for the next batch.

Seeks and stalls are told apart by the clock model, not by the scheduler,
because only the model sees both clocks. A frame stall recovering produces a
large forward jump that is *proportional* to elapsed host time — those notes are
genuinely due and must be played. Only a disproportionate jump is a seek.

### Safety

Never leaving a key stuck is the hard requirement, and it is defended in layers:
every teardown path releases first; a 100ms state monitor watches for the play
failing or the game closing (including between notes, where nothing would fire);
a 500ms watchdog force-releases anything held past a timeout; lifecycle
listeners release on tab-hide, blur and unload; and the input-state verifier
stops the run rather than playing the wrong columns if the site's keybinds
change underneath it. Every failure path ends with `Autoplay stopped safely.`

## Develop

```bash
npm install
npm run build      # → dist/autoplay.js, dist/autoplay.user.js, dist/bookmarklet.txt
npm run watch
npm test           # 156 unit + integration tests
npm run smoke      # builds, then runs the SHIPPED BUNDLE against a stubbed site
npm run verify     # typecheck + test + smoke
npm run demo       # sandbox at http://localhost:5173/
```

Tests run on `node --test` with Node's native type stripping — no test framework
and no transform step. `test/helpers/domStub.ts` provides a minimal DOM and a
**manual clock**: nothing runs until `advance()` is called, so timing assertions
are exact rather than flaky.

The smoke test is worth running after any change. It loads the actual bundled
bytes through the real bootstrap path, which is how the hold-head bug below was
found — the unit tests all passed while the shipped bundle released every hold
12ms after starting it.

## Notable bugs found and fixed

Two are recorded here because both were invisible in normal use and both had
regression tests written before the fix.

**A hold was released milliseconds after it started.** The site stores every
hold as two objects: a head `tap` carrying the hold's `endTime`, plus the `hold`.
`buildChartFromGame` "normalised" taps by setting `endTime = time`, which
destroyed the only marker identifying the head. The timeline then treated it as
a real tap at the hold's start — a duplicate press, and a deferred release that
let go of the hold ~12ms in. Every hold on every map was broken. The fix keeps
the site's `endTime` and makes the deduplication a Set lookup that does not care
which way the pair sorts.

**The timing offset did nothing.** It was applied inside the engine's clock
prediction, which only the armed-timer path consults. Any note fired by the
catch-up path compared raw chart time and ignored the offset entirely, so the
slider appeared to work sometimes and not others. The offset now lives in the
scheduler and is applied through a single `dueTime()` used by every path.

More in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md#design-decisions-worth-knowing).

## Documentation

| File | What it covers |
|---|---|
| [`docs/SITE-CONTRACT.md`](docs/SITE-CONTRACT.md) | The site facts this depends on, with source references, and what breaks if each one changes |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Module responsibilities and the reasoning behind the design decisions |
| [`docs/SAFETY.md`](docs/SAFETY.md) | Scope, fair play, the `isTrusted` limitation, and the runtime safety layers |
| [`docs/UPDATING.md`](docs/UPDATING.md) | Triage guide for when the site changes |

## Scope

Standard browser APIs only: `addEventListener`, `dispatchEvent`,
`KeyboardEvent`, `performance.now`, `requestAnimationFrame`, `setTimeout`,
`MessageChannel`, `localStorage`, and read-only observation of network responses
for the fallback chart parser.

No anti-cheat bypass, no detection evasion, no `isTrusted` spoofing, no browser
security bypass, no credential or cookie access, no account manipulation, no
network modification, no remote code execution, no memory manipulation. See
[`docs/SAFETY.md`](docs/SAFETY.md) for what each of those means concretely here.
