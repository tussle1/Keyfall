# The Ashtonk!mania contract

Everything the Ashtonk!mania side of Keyfall depends on is a small set of facts
about how the live game exposes its own state. This document is the companion to
[`SITE-CONTRACT.md`](./SITE-CONTRACT.md), which covers Web osu!mania.

Verified against the public source at
[`ashtonkehler14-glitch/Ashtonk-mania`](https://github.com/ashtonkehler14-glitch/Ashtonk-mania),
commit `cefb270` (`Ranked mods as Ashtonk!mania's players want them`), on
2026-11-03. Ashtonk!mania is a separate codebase: vanilla JavaScript, DOM/Canvas
2D, `AudioContext`, no React or PixiJS. Its build inlines `src/js/*.js` into a
single `index.html`.

The adapter lives in `src/detect/ashtonkAdapter.ts`. It is **read-only**: it
projects the live session onto Keyfall's existing `GameLike` contract so the same
chart parser, clock mapper, timeline, humanizer, scheduler, guards, stats,
settings, overlay and synthetic keyboard path can drive either site. It does not
call the site's Auto (`AT`), `generateAutoInputs(...)`, replay feed, private
judgement engine, `Verified.submit`, or any score-submission endpoint.

---

## 1. Host and exported global

The shipped userscript matches:

```text
https://v2-ashtonkmania.lokaux.workers.dev/*
https://ashtonkmania.lokaux.workers.dev/*
```

These are exact `@match` host patterns: userscript managers only allow an exact
host, `*.domain`, or `*` in the host portion of `@match`. Runtime detection also
recognises `vN-ashtonkmania.lokaux.workers.dev` and subdomains if the plain
bundle is loaded by another method, but the shipped userscript deliberately
injects only on the two known deployments.

`src/js/20-app.js` exports `window.AshtonkMania` with `App`, `Settings`, `Music`,
`AudioManager`, `Screens`, `GameplayScreen`, `Game`, `BeatmapParser`,
`ScoreManager`, `ReplayManager`, `Multiplayer`, and more. Recognition is
shape-based: `readAshtonkApi()` requires `AshtonkMania.GameplayScreen` to be an
object. The global also lets the saved single-file HTML build be recognised even
when its host is not in the known list.

`src/js/12-ui-core.js` sets `Screens.current` / `Screens.currentName` before
calling `enter()`. Gameplay is `Screens.current === GameplayScreen` and
`Screens.currentName === "gameplay"`. A connected `canvas.gp-canvas` is the
fallback liveness marker.

## 2. Live gameplay session

`GameplayScreen.s` is the session object. Fields Keyfall reads:

```text
rec, bm, keys, mods, rate, practice, auto, replay, seed, windows,
accuracyMode, layout, scroll, baseNotes, modConfig, rules, endTime, firstNote,
held, keyMap, keyLabels, down, events, running, finished, failed, mode, mp,
spectate, mapOffset, loopA, loopB, engine, debug
```

`auto` is `mods.includes("AT")`. `mode` is `replay` / `auto` / `practice` /
`play`. `s.feed` is replay or generated Auto input. The site's own Auto mod sets
`AT` and a `generateAutoInputs(...)` feed; Keyfall never enables or reads it for
playback.

`GameplayScreen.loaderGone` gates input (`src/js/15-screen-gameplay.js` lines
around 261, 385, 671, 692 and 1451). `onKeyDown` also requires
`Screens.current === GameplayScreen`, no overlay, `s`, `loaderGone`, `!e.repeat`,
`s.running` and `!s.feed`. Once `s.engine.notes` is prepared, Keyfall can acquire
the session *during* the loader and expose it as `WAIT`; it does not send
keyboard input until the game enters `PLAY`.

## 3. Chart shape

`src/js/03b-mania-convert.js` emits notes as:

```js
{ col, time, end, isLN }
```

`GameplayScreen.s.engine.notes` is the prepared, judgement-ready chart.
`baseNotes` is the original parsed chart. Mods such as mirror, random, inverted
and no-LN are applied when the session is built, so `engine.notes` — not
`baseNotes` — is the authoritative shape for the active run. Practice seeks call
`newEngine(t)` and replace `s.engine`.

The adapter converts each note to Keyfall's `SiteHitObject`:

```text
isLN && end > time  →  { type: "hold", column: col, time, endTime: end }
otherwise            →  { type: "tap",  column: col, time, endTime: time }
```

Ashtonk!mania does **not** store a separate duplicate hold-head tap, so the
timeline's WOM hold-head pre-pass is harmless. `chartSignature` hashes the note
layout plus `s.rec.hash`, key count, mods, seed, practice loop points and the
identity of `s.engine`; this makes `random` retries and practice seeks rebuild
the timeline even when note count and start/end times are unchanged. A cheaper
`chartRevision` tracks session, engine, note-array identity and length: it is
checked for every dispatched batch, while the full fingerprint is checked by
the 100ms monitor to catch in-place changes. Unchanged detection polls avoid
reconverting the chart. The mutable playback rate is intentionally *not* part
of chart identity.

## 4. Chart clock

From `src/js/15-screen-gameplay.js` and `src/js/05-audio.js`:

```text
offsetMs() = Settings.get("audio.offset") + (s.mapOffset || 0)

gameTime(at) = Music.timeAt(at) - offsetMs() * s.rate
               (with a failClock wind-down exception)

inputTime(e) = Music.timeAtCtx(
                 AudioManager.perfToCtx(e.timeStamp || performance.now())
               ) - offsetMs() * s.rate
                 - Settings.get("input.latency") * s.rate
```

`frameTime(ts)` damps the render/loop clock toward that audio truth. `checkEnd()`
uses the loop clock. `audio.offset` is −300..300ms, `input.latency` −50..50ms,
and `mapOffset` comes from the user's saved per-map offset.

Keyfall must expose a `gameTime()`-like **chart clock**, not raw `Music.time`.
`timeElapsed` calls the live `GameplayScreen.inputTime({ timeStamp: perf })`
method when available; the fallback reproduces the same formula using
`Music.timeAt` / `Music.timeAtCtx`, `AudioManager.perfToCtx`, `Settings.get` and
`s.mapOffset`. Note times remain in map milliseconds even when practice speed or
DT/HT changes `s.rate`, because `Music.timeAt*` already returns rate-scaled map
time.

For a prepared Ashtonk session, `chartTimeAtHost(host)` calls the same
`inputTime` mapping with an arbitrary event timestamp. The shared engine samples
it at the current host time and 100 ms ahead to estimate the current slope;
the scheduler retargets an armed batch on each frame and rechecks whether it
is actually due before firing. This supports changing rates such as Wind Up,
Wind Down and Adaptive Speed without treating each rate change as a new chart.
If the site method is unavailable, the engine falls back to the sliding linear
`ClockMapper`. CPU stalls, throttled timers and abrupt rate changes still limit
accuracy; no JavaScript scheduler can dispatch while the main thread is blocked.

## 5. Keybinds and input path

`Settings.keybinds(keys)` returns one code array per column. `s.keyMap` is the
actual `code -> column` map used by `onKeyDown` and takes precedence over saved
settings. Gamepad codes (`PadN` / `🎮…`) are filtered out because Keyfall
dispatches keyboard events; `Escape`, `Backquote`, `Tab`, `F3` and `F4` are
also skipped because the game consumes them before checking its lane map. If an
active map has no usable keyboard binding for a lane, the adapter reports the
missing lane instead of guessing. Explicit Keyfall overrides still must match
the game's own binding.

`GameplayScreen.enter()` installs `window` **capture** `keydown` / `keyup`
listeners. A press:

1. resolves `s.keyMap.get(e.code)`,
2. updates `s.held`, `s.events` and `s.engine.input`,
3. is judged by `GameplayEngine.input()` against `inputTime(e)`.

Keyfall's unchanged `InputManager` dispatches on `win.document` with
`bubbles: true`, `composed: true`, `repeat: false`, and
`isTrusted === false`. In a real browser an event dispatched on `document` still
traverses `window` in the capture phase, so those listeners see it. The DOM stub
used by the integration test models the same `document -> window` path. No
`isTrusted` spoofing is attempted.

High-key Ashtonk!mania default layouts can collide with Keyfall's default
hotkeys (`G`, `B`, `X`, `Z`). `HotkeyManager` surfaces those collisions using the
adapter's resolved keybinds; rebind the action hotkeys in More! → Input. Keyfall
listens on `window` capture so it can receive emergency stop even when the game
stops propagation. If Keyfall was injected *after* the game listener, that
listener may still see a colliding physical key first; avoiding collisions is
safer. Right Shift is reserved for the panel and cannot be rebound.

## 6. State and liveness

The adapter maps the live session to `SiteGameState`:

| State | Condition |
|---|---|
| `PLAY` | gameplay screen, `loaderGone`, `s.running`, no feed, not failed/finished |
| `WAIT` | gameplay screen but the loader has not finished |
| `PAUSE` / `UNPAUSE` | loader finished, `s.running === false`; `UNPAUSE` when a countdown element is present |
| `FAIL` | `s.failed`, `s.finished`, screen left, or an unsupported mode |

`Engine.isGameAlive()` additionally checks `unsupportedReason` and that
`hitObjects` has not vanished. Detection polls keep using one cached adapter per
window, so SPA navigation and practice seeks do not create a second autoplay
engine.

## 7. Score readback

`GameplayEngine`'s score object exposes `counts[6]`, `accuracy`, `score`, `combo`
and `maxCombo`. The adapter maps them into the same keys `engine/stats.ts`
already reads:

```text
counts[0..5] → 320 / 300 / 200 / 100 / 50 / 0
accuracy → 0..1 fraction
combo, score, maxCombo → plain numbers
```

`inputSystem.pressedColumns` is `s.held`, so `verifyInputState()` can detect a
keybind mismatch or a synthetic input path breaking.

## 8. Feed conflicts and score submission

The adapter allows normal/ranked, Practice, multiplayer, daily and changing-rate
gameplay when the site accepts ordinary keyboard input. It returns
`unsupportedReason` (and `state: "FAIL"`) for the built-in `AT` / skin-editor
Auto, replay or spectate feeds, and active lanes without usable keyboard bindings.
The game's `onKeyDown` ignores column input when `s.feed` is active, so those
feeds cannot be driven through this architecture.

`GameplayScreen.complete()` may save or submit a normal play through the game's
own score flow (`Verified.submit`); Keyfall does not call submission endpoints
itself. The server has verification rules, and the browser emits honest
`isTrusted === false` events. **Online score acceptance and connected multiplayer
have not been tested.** No verification bypass is provided. Do not submit or
claim automated leaderboard scores as your own.

Start may be armed manually before gameplay, or `general.autoStart` may be
enabled in More! → Timing (off by default). Stop, emergency stop and the master
switch cancel an armed start and release held keys. The site's own Auto remains
unused.

---

## Offline browser regression

The optional `test/browser-ashtonk.mjs` runs the shipped userscript against a
separate, local checkout of the real game. It generates local 4K and 18K charts
with chords and holds, checks pre-game manual arming, opt-in auto-start, custom
bindings, normal/Practice/daily-configured/multiplayer-configured play, Wind
Up/Down, Adaptive Speed, a Practice seek during a hold, and a trusted emergency
hotkey during an 18K hold. A short main-thread freeze checks that a chord still
inside the hit window is recovered. Another blocks the thread for 2.4 seconds
on a dense 4K No Fail chart, checks that skipped and ongoing holds reconcile,
and verifies all four later notes are hit. Misses during the long freeze are
expected. External requests are blocked. Daily and multiplayer are offline configuration
fixtures, **not** connected sessions; no server scoring is tested.

With Node 22.18+, an existing Chromium/Chrome, and a checkout of the game:

```bash
git clone https://github.com/ashtonkehler14-glitch/Ashtonk-mania.git /tmp/ashtonkmania
node /tmp/ashtonkmania/build.mjs  # rebuild its index.html if needed
ASHTONK_ROOT=/tmp/ashtonkmania CHROME_PATH=/path/to/chromium npm run test:ashtonk
```

The test was developed against Ashtonk commit `cefb2703375cb687dd6ec367ece7b933181ab432`.
`playwright-core` does not download a browser. `KEYFALL_CHROME_ARGS` can supply
additional whitespace-separated Chromium flags when required. The test is
performance-sensitive: a blocked or heavily throttled browser may miss notes.

---

## What breaks if Ashtonk!mania changes

| Site change | Effect | Fix |
|---|---|---|
| Renames / removes `window.AshtonkMania` | `ashtonkGlobal` strategy returns null | Update `ASHTONK_APP_GLOBAL` and `readAshtonkApi()` shape check |
| Moves `GameplayScreen.s` or its fields | Chart/clock/state readback fails | Update `src/detect/ashtonkAdapter.ts` |
| Changes `inputTime` / `offsetMs` / `Music` clock | Timing drift | Update `readChartTime()` fallback and the contract above |
| Moves keybinds out of `Settings.keybinds(keys)` / `s.keyMap` | Mapping falls back | Prefer `s.keyMap`; users can still override in More! → Input |
| Adds `isTrusted` checks to gameplay input | Synthetic events stop registering | No legitimate fix; guards stop safely |
| Moves `window` capture listeners to a shadow root or stopped propagation | Document-dispatched events may not reach them | Verify the event path; `InputManager` target may need a site-aware bridge |
| Changes note shape from `{ col, time, end, isLN }` | Chart parse fails | Update `readHitObjects()` |
| Changes feed/input handling | Keyboard events may be ignored or duplicate another input source | Re-check `unsupportedReason()` against the game's actual input gates |
| Changes score / server verification | The game may reject or submit plays differently | Re-read its rules; do not claim server acceptance without testing |
