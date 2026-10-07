# Safety, scope and honest limitations

## What this tool is

Browser-side gameplay automation for a single-player rhythm game running in
your own browser tab. It reads the chart the page has already loaded and
dispatches ordinary DOM `KeyboardEvent`s on `document`.

It is built entirely from standard, publicly documented browser APIs:
`addEventListener`, `dispatchEvent`, `KeyboardEvent`, `performance.now`,
`requestAnimationFrame`, `setTimeout`, `MessageChannel`, `fetch` observation,
`localStorage`, canvas and DOM inspection.

## What this tool is not

None of the following are implemented, and none are achievable from the
position this tool occupies:

- **No anti-cheat bypass.** Nothing here evades detection. Quite the opposite —
  see the `isTrusted` note below.
- **No `isTrusted` spoofing.** Synthetic events are dispatched honestly and
  remain `isTrusted === false`. There is no attempt to forge trusted input, and
  in a browser there is no legitimate way to.
- **No browser security bypass.** No sandbox escapes, no cross-origin access, no
  CSP circumvention, no privileged APIs.
- **No credential or cookie access.** `document.cookie` is never read. No
  storage belonging to the site is read or written; the tool's own settings live
  under a single namespaced `localStorage` key.
- **No account manipulation.** Nothing submits forms, calls authenticated
  endpoints, or mutates site state.
- **No network modification.** The `.osz` sniffer is strictly read-only:
  responses are `clone()`d and observed, requests are never altered, blocked,
  delayed or replayed.
- **No remote code execution.** No `eval` of remote content, no dynamic remote
  script loading in the shipped bundle.
- **No memory manipulation.** Not possible from JavaScript, and not attempted.

## The honest limitation

Every input this tool produces is `isTrusted === false`. Any site that checks
`event.isTrusted` — a one-line change in `handleKeyDown` — renders this entire
approach inert. Web osu!mania does not check it today, which is the only reason
this works at all.

That asymmetry is worth stating plainly: this tool is not robust against a site
author who decides they do not want it. It is a client-side convenience, not an
adversarial capability.

## Fair play

Web osu!mania keeps **local** high scores. As far as the public source shows,
there is no global leaderboard, no ranked submission and no multiplayer, so
running this does not take anything from another player.

That is the current state of the site, not a permanent property of it. Two
things follow:

1. **The site already ships an Autoplay mod** (Settings → Mods → Autoplay, backed
   by `generateAutoReplay`). If you simply want to watch a map played perfectly,
   use that. It is frame-exact, needs no timing model, and is the developer's
   own sanctioned feature. This tool explicitly refuses to run while that mod is
   enabled.
2. If the site ever adds ranked or shared leaderboards, submitting a score
   produced by automation would be cheating, and would also be trivially
   detectable via `isTrusted`. Do not do it.

Use this for practice reference, pattern study, testing your own charts,
accessibility, or watching a map you cannot yet play. Do not use it to claim a
score as your own.

## Runtime safety

The requirement that mattered most while building this was: **never leave a key
stuck.** A pinned column on a rhythm game is not a cosmetic bug — it drains HP,
breaks the run, and can persist into the next screen. Defences, in layers:

1. **Every teardown path releases first.** `stop()`, `pause()`,
   `emergencyStop()`, `dispose()`, chart completion, play failure, detection
   loss — all call `InputManager.releaseAll()` before anything else.
2. **A 100ms state monitor** (`Engine.checkSiteState`) checks that the game is
   still alive and still in `PLAY`. It runs on a timer rather than on the firing
   path, because a failure between notes would otherwise go unnoticed with a
   hold still down.
3. **A 500ms guards watchdog** (`engine/guards.ts`) cross-checks how long each
   column has been held against the chart clock, and force-releases past
   `STUCK_KEY_TIMEOUT`.
4. **Lifecycle listeners**: `visibilitychange`, `pagehide`, `beforeunload` and
   `blur` all release keys. A backgrounded tab gets throttled timers, which
   would wreck scheduling, so the engine pauses and releases rather than
   firing late.
5. **Input-state verification**: after dispatching, our held set is compared
   against the site's own `inputSystem.pressedColumns`. A persistent mismatch
   means the keybinds changed underneath us, so the engine stops instead of
   playing garbage.
6. **A stuck-key release even without a recorded press.** If the site believes a
   column is down and we have no record of pressing it, we dispatch the release
   anyway. A spurious `keyup` is harmless; a missing one is not.
7. **Bounded everything.** The catch-up loop caps at
   `MAX_CATCHUP_ACTIONS_PER_FRAME` and reports an overrun rather than jamming
   every column at once. The precision spin-wait has both an absolute deadline
   and an iteration cap, so a bad clock prediction cannot freeze the tab.
8. **Errors never escape.** Every strategy, emitter subscriber, scheduled task
   and dispatch is wrapped; a throw degrades to a log line and a safe stop with
   `Autoplay stopped safely.`

## Known failure modes

| Situation | Behaviour |
|---|---|
| Site adds an `isTrusted` check | Input silently stops registering; the desync verifier detects it within ~6 checks and stops safely with an explanatory message |
| `random` mod enabled | Live-game path works. The `.osu` fallback path refuses, because the column permutation is generated at runtime and never persisted |
| Site's Autoplay mod enabled | Refuses to start, with a message telling you to disable it |
| A replay is playing | Refuses to start; the site's `ReplayPlayer` already drives input |
| Beatmap fails to download | No chart detected; overlay reports it, no input is produced |
| Keybind changed mid-run | Desync verifier stops the run rather than playing the wrong columns |
| Tab backgrounded mid-hold | Keys released, engine paused, resumes on return |
| Two columns bound to the same key | Duplicate presses are counted and surfaced in diagnostics instead of double-firing |
