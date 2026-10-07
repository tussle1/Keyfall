# Maintaining Keyfall when the site changes

The site is actively developed. This is the triage order.

## Step 1: work out which layer broke

Open devtools on `webosumania.com`, start a map, and run:

```js
Keyfall.diagnostics()
```

Read it top-down:

```js
{
  site: "confirmed",     // ← wrong?  detect/siteDetection.ts
  via: "pixiGlobal",     // ← null?   detect/pixiHook.ts strategies
  chart: { keyCount, notes, actions, signature },  // ← null?  detect/buildContext.ts
  mapping: { source, codes },   // ← source "fallback"?  keybinds moved
  clock: { slope, errorMs, confident },  // ← not confident?  timing/clock.ts
  scheduler: { cursor, armed, fired, dropped },
  input: { held, down, up, duplicatesSuppressed, failures },
  siteState: "PLAY",
  lastError: null
}
```

Each field points at one module. `lastError` usually states the problem
directly.

## Step 2: the common failures

### `via` is null — the game can't be found

Most likely `window.__PIXI_APP__` went away. Check in the console:

```js
window.__PIXI_APP__            // the site sets this during play
document.querySelectorAll("canvas").length
```

If the global is gone, strategy 2 (viewport-sized canvas → fiber) should still
work. If React changed its internals, check the fiber key prefix:

```js
Object.keys(document.querySelector("canvas")).filter(k => k.startsWith("__react"))
```

`detect/fiber.ts` caches the `__reactFiber$` prefix on first success; if React
renames it, that is the line to update.

If the `Game` moved somewhere the scan does not reach, widen `scanValue`'s depth
or add a field to check in `looksLikeGame`. Keep it shape-based — do not match on
a constructor name.

### `chart` is null but the game is found

The site's field names changed. `detect/buildContext.ts` reads exactly:

```
game.hitObjects[]      → { type, column, time, endTime }
game.difficulty.keyCount
game.startTime / game.endTime
game.columnKeybinds    → [[primary, secondary], …]
game.settings.keybinds.keyModes
game.mods.autoplay
game.replayPlayer
```

Each has a fallback (`readKeyCount` tries `difficulty`, then
`columnKeybinds.length`, then `inputSystem.pressedColumns.length`). Update the
`GameLike` interface in `src/types.ts` to match the new shape — it is
structurally typed on purpose, so a rename is a one-file change.

### `mapping.source` is `"fallback"`

Keybinds moved out of `settings.keybinds.keyModes`. Two options:

- Update `buildKeyMapping` in `detect/buildContext.ts` to read the new location.
- Or just configure it manually: overlay → Settings → Input → click a column →
  press the key. User overrides are persisted and take priority over the
  fallback (but not over a successful site read).

### Input dispatches but nothing happens

Check whether the site added an `isTrusted` guard:

```js
// In devtools, on the gameplay page:
document.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyD", bubbles: true }));
// Does the receptor light up?
```

If not, look at what the handler now requires. If it is an `isTrusted` check,
**there is no fix** — see `docs/SAFETY.md`. The desync verifier will detect this
within about six checks and stop safely with an explanatory message rather than
silently doing nothing.

If the receptor lights up but notes are not judged, the column mapping is wrong;
compare `diagnostics().mapping.codes` against the site's Settings → Keybinds.

### Notes fire but timing is off

```js
Keyfall.diagnostics().clock
```

- `confident: false` after several seconds → the fit is not converging. Check
  `slope`: it should equal the playback rate (1 at normal speed). A slope of 1
  when the site is at 1.5× means `timeElapsed` stopped following `song.seek()`.
- `errorMs` large (>10) → the two clocks are not linearly related any more.
  Look at what the site now uses for `timeElapsed`.
- `discontinuities` climbing steadily → something is being misread as a seek.
  Check the thresholds at the top of `timing/clock.ts`.

Use the Timing Offset slider (±200ms, 1ms steps) for a constant musical
correction. That is separate from a broken clock model.

### Timing varies when it should not, or does not when it should

```js
Keyfall.diagnostics().humanization
```

- `{ enabled: false }` but timing still looks off — it is not humanization. Check
  `clock` and the Timing Offset instead.
- `enabled: true` unexpectedly — it persisted from a previous session. Turn it off
  in Settings → Humanize, or `Keyfall.resetSettings()`.
- Same seed gives different runs — that is a bug, not a setting. Determinism is
  tested in `test/humanizer.test.ts`; start with whether `reseed()` is being
  called on rebuild.
- Holds are being released early or notes are vanishing on one column — check
  `clamped` and `releaseClamped`. Rising clamp counts mean the chart is denser
  than the variation allows; lower `strength`.

### Everything works but holds are wrong

The hold representation changed. `chart/timeline.ts` pass 1 assumes the site
stores a hold as a head `tap` (`endTime` = hold end) plus a `hold` object. Verify:

```js
Keyfall.chart.notes.slice(0, 40)
```

If holds are no longer duplicated, the pre-pass is harmless but `noteCount`
will be off; if they are duplicated differently, update the `holdKeys` logic.

## Step 3: add a new detection strategy

Strategies are independent functions in `detect/pixiHook.ts`:

```ts
export const STRATEGIES: Strategy[] = [
  { name: "pixiGlobal", cost: "low",    run: viaPixiGlobal },
  { name: "canvasScan", cost: "medium", run: viaCanvasScan },
  { name: "fiberProbe", cost: "high",   run: viaAnyFiber },
  // add here — ordered cheapest and most reliable first
];
```

Each returns `GameLike | null` and is called inside a `try`/`catch`, so a new
strategy that throws cannot break the others. Nothing else needs to change:
`acquireGame` reports which one succeeded, and that string appears in
`diagnostics().via`.

## Step 4: verify

```bash
npm run verify     # typecheck + 229 tests + shipped-bundle smoke test
```

If you changed timing or ordering behaviour, add a test. The two bugs that were
hardest to find in this codebase — the unbounded spin-wait and the
catch-up-ignores-offset problem — were both invisible in manual testing and
obvious under the stubbed clock.

Then check by hand against the real site, in this order:

1. A 4K map with only taps.
2. A map with holds, including a hold that ends exactly where the next note on
   that column starts.
3. A dense stream (jacks faster than 12ms apart at high rate).
4. 7K or higher, to confirm no 4K assumption leaked in.
5. Pause and resume mid-hold. Confirm no stuck key.
6. Change beatmap without refreshing. Confirm the overlay re-detects.
7. Close the game mid-hold. Confirm no stuck key.
8. Enable the site's own Autoplay mod. Confirm Keyfall refuses to start.
9. Enable humanization at strength 1 with hold-release variation and fatigue at
   maximum, on the densest chart you have. Confirm no stuck key and that every
   press is matched by a release.

## Reference

- Site source: <https://github.com/HecticKiwi/Web-Osu-Mania>
- `.osu` format: <https://osu.ppy.sh/wiki/en/Client/File_formats/osu_(file_format)>
- osu!mania V2 scoring / hit windows: <https://osu.ppy.sh/wiki/en/Gameplay/Scoring>
- The contract this tool depends on: [`SITE-CONTRACT.md`](./SITE-CONTRACT.md)
