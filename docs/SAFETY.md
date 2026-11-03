# Safety, scope and honest limitations

## What Keyfall is

Browser-side gameplay automation for supported browser rhythm games running in
your own browser tab. It reads the chart the page has already loaded and
dispatches ordinary DOM `KeyboardEvent`s on `document`. On Ashtonk!mania it is
limited to **Practice mode**; ranked, multiplayer, daily, replay, spectate and
Auto/AT modes are refused.

It is built entirely from standard, publicly documented browser APIs:
`addEventListener`, `dispatchEvent`, `KeyboardEvent`, `performance.now`,
`requestAnimationFrame`, `setTimeout`, `MessageChannel`, `fetch` observation,
`localStorage`, canvas and DOM inspection.

## What Keyfall is not

None of the following are implemented, and none are achievable from the
position Keyfall occupies:

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
- **No account manipulation or score submission.** Nothing submits forms, calls
  authenticated endpoints, calls `Verified.submit`, or mutates site state. The
  Ashtonk!mania adapter refuses any mode that would submit a ranked/online score.
- **No network modification.** The `.osz` sniffer is strictly read-only:
  responses are `clone()`d and observed, requests are never altered, blocked,
  delayed or replayed.
- **No remote code execution.** No `eval` of remote content, no dynamic remote
  script loading in the shipped bundle.
- **No memory manipulation.** Not possible from JavaScript, and not attempted.

## The honest limitation

Every input Keyfall produces is `isTrusted === false`. Any site that checks
`event.isTrusted` — a one-line change in `handleKeyDown` — renders this entire
approach inert. Neither supported site requires trusted keyboard events for the
local input paths Keyfall uses today, which is the only reason this works at all.

That asymmetry is worth stating plainly: Keyfall is not robust against a site
author who decides they do not want it. It is a client-side convenience, not an
adversarial capability.

## Fair play

Web osu!mania's original design kept **local** high scores. Ashtonk!mania, by
contrast, has ranked, multiplayer and daily-challenge leaderboards with
server-side verification. That difference is why the Ashtonk!mania adapter is
**Practice-mode only**: normal/ranked play, multiplayer, daily challenges,
replays, spectating and the site's `AT` Auto mod are all refused before any
input is produced. Practice plays do not call `Verified.submit`.

Both supported sites ship their own Autoplay/Auto feature. If you simply want
to watch a map played perfectly using the developer's sanctioned feature, use
that instead. Keyfall explicitly refuses to run while either built-in Auto mod
is enabled, and never calls `generateAutoReplay` or `generateAutoInputs`.

If Web osu!mania adds — or already has on a particular deployment — ranked or
shared leaderboards, submitting an automated score would be cheating and would
also be trivially detectable via `isTrusted`. Do not do it. Do not use
humanization to try to make an automated Ashtonk!mania score look legitimate;
the practice-only gate exists so that question never arises.

Use this for practice reference, pattern study, testing your own charts,
accessibility, or watching a map you cannot yet play. Do not use it to claim a
score as your own.

## Humanization is not evasion

The optional humanization engine adds reproducible timing variation — seeded,
with drift, fatigue and pattern-aware tightening. It is worth being blunt about
what that is and is not.

It **is** a practice and analysis tool: you cannot learn how much slack a pattern
tolerates from a run that never varies, and a machine-perfect run tells you
nothing about the margin between "hit" and "miss" on a given chart.

It **is not** detection evasion, and it cannot become that. Every event Keyfall
dispatches is `isTrusted === false`. Humanization changes *when* an event is sent;
it does not change *what* the event is. A site that checked `isTrusted` would be
completely unaffected by any amount of timing variation, and would see every
synthetic keystroke just as plainly.

The variation is also deterministic from a seed, which is the opposite of what
evasion would want: two runs with the same seed produce byte-identical timing.
That is a deliberate trade. Reproducibility is what makes a humanized run
comparable, debuggable and worth studying; anything else would be noise.

Ranked/shared leaderboards already exist on Ashtonk!mania, which is precisely
why a humanized Keyfall run is never submitted there. A humanized run would be
no more legitimate than a frame-exact one, and no harder to detect.

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
   hold still down. It covers `RUNNING`, `PAUSED` and `READY`: a play can fail
   after the last action, while the site transitions to its results screen.
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
| Site's Autoplay / `AT` mod enabled | Refuses to start, with a message telling you to disable it |
| A replay is playing | Refuses to start; the site's `ReplayPlayer` / `s.feed` already drives input |
| Ashtonk!mania normal, ranked, multiplayer or daily play | Refuses with a Practice-mode notice rather than submitting an automated score |
| Ashtonk!mania Wind Up / Wind Down / Adaptive Speed | Refuses; those mods change the clock non-linearly and Keyfall's clock model is linear |
| Ashtonk!mania high-key layout collides with `G`/`B`/`X`/`Z` hotkeys | Collision warning is surfaced; rebind the hotkeys in More! → Input |
| Beatmap fails to download | No chart detected; overlay reports it, no input is produced |
| Keybind changed mid-run | Desync verifier stops the run rather than playing the wrong columns |
| Tab backgrounded mid-hold | Keys released, engine paused, resumes on return |
| Two columns bound to the same key | Duplicate presses are counted and surfaced in diagnostics instead of double-firing |
| Humanization shifts a hold's tail past the next press | Clamped during `prepare()`: the release ceiling is the next same-column press, and letting go early is always allowed |
| Humanization spreads a chord apart | Impossible by construction: one delta per timestamp, shared by every note in the chord |
| A timing or humanization setting changes mid-run | The scheduler updates from the current playhead. Holds with a future release remain held; any release moved behind the playhead is sent immediately |
