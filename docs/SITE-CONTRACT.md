# The Web osu!mania contract

Everything Keyfall does depends on a small set of facts about how
[Web osu!mania](https://webosumania.com/) is built. They are written down here
so that when the site changes, the fix is a targeted edit rather than an
archaeological dig.

Verified against the public source at
[`HecticKiwi/Web-Osu-Mania`](https://github.com/HecticKiwi/Web-Osu-Mania)
(commit on `main` as of 2026-10-06).

Stack: TypeScript, React (TanStack Start), PixiJS v8 for the gameplay renderer,
Howler for audio, Zustand for state (persisted to IndexedDB).

---

## 1. Input is reachable through the normal DOM event path

`src/osuMania/systems/input.ts`:

```ts
document.addEventListener("keydown", this.handleKeyDown);
document.addEventListener("keyup",   this.handleKeyUp);
```

`handleKeyDown` gates on exactly one thing:

```ts
if (event.repeat) return;
```

It **never checks `event.isTrusted`** (verified: `grep -rn "isTrusted" src`
returns nothing). So a synthetic `KeyboardEvent` dispatched on `document` is
processed identically to a physical keypress, flows through the site's own
`InputSystem.hit()` / `release()`, and is judged against the site's own clock.

Consequences for Keyfall:

- We dispatch `new KeyboardEvent("keydown", { code, key, repeat: false, bubbles: true })`.
  `repeat` **must** be `false` or the site drops it.
- `isTrusted` stays `false`. That is not something we work around, and it is
  the honest limit of browser-side automation: a determined anti-cheat could
  detect this trivially. See `docs/SAFETY.md`.
- Because the site listens on `document` in the bubble phase, our hotkeys are
  handled in the **capture** phase with `stopPropagation()` so a hotkey never
  also registers as a column hit.

## 2. Column resolution uses `event.code`

```ts
private initKeybindsMap() {
  const keybinds = this.game.settings.keybinds.keyModes[this.game.difficulty.keyCount - 1];
  keybinds.forEach(([keybind1, keybind2], index) => {
    if (keybind1) this.keybindsMap.set(keybind1, index);
    if (keybind2) this.keybindsMap.set(keybind2, index);
  });
}
```

- The map is keyed by **`code`** (`"KeyD"`, `"Space"`, `"Semicolon"`), not `key`.
- Shape: `keyModes[keyCount - 1][column] = [primary, secondary]`.
- Both bindings for a column are tracked in a `Set`; `hit()` fires when the set
  goes 0→1 and `release()` when it goes 1→0. So pressing both bindings is
  legal and releasing one of them does not release the column.
- Gamepad bindings use the `"🎮Btn<i>"` convention in the same map.

`game.columnKeybinds` is the already-resolved array for the active key count:

```ts
this.columnKeybinds = this.settings.keybinds.keyModes[this.difficulty.keyCount - 1];
```

`game.settings` is a **deep clone taken at construction**
(`JSON.parse(JSON.stringify(useSettingsStore.getState()))`), so it reflects the
keybinds for *that specific run* — which is what we want, since the user can
rebind between plays.

Default 4K is `KeyD KeyF KeyJ KeyK`. Defaults exist for 1K–10K+.

## 3. The live `Game` instance is reachable via `window.__PIXI_APP__`

`src/osuMania/game.ts`, inside `main()`:

```ts
ref.appendChild(this.app.canvas);

// For the debugger extension to detect the app
window.__PIXI_APP__ = this.app;
```

and in `dispose()`:

```ts
window.__PIXI_APP__ = null;
```

The `Game` itself is held in React component state
(`src/components/game/gameScreens.tsx`):

```ts
const [game, setGame] = useState<Game | null>(null);
...
gameInstance.main(containerRef.current, initialShowHud.current).then(() => setGame(gameInstance));
```

So the acquisition chain Keyfall uses is:

```
window.__PIXI_APP__  →  app.canvas  →  canvas.__reactFiber$…  →  walk up to root
                     →  scan subtree (hook chains / stateNode / memoizedProps)
                     →  the object that quacks like Game
```

Detection is **shape-based, never name-based** (`looksLikeGame` checks for
`hitObjects[]`, `difficulty.keyCount`, `timeElapsed`, `inputSystem|state`), so
renaming a component or a field does not break it. Two fallback strategies
exist behind it: a viewport-sized-canvas scan, and a broad fiber probe.

`__PIXI_APP__` being set is also a reliable "gameplay is active" signal, and
being `null` is a reliable "gameplay ended" signal.

## 4. Chart data shape

`src/lib/beatmapParser.ts`:

```ts
type TapData  = { type: "tap";  column; time; endTime; hitSound; hitSample; isHoldHead }
type HoldData = { type: "hold"; column; time; endTime }
type Difficulty = { keyCount: number; od: number; hp: number }
interface BeatmapData { hitObjects; startTime; endTime; difficulty; audioOffset; delay; … }
```

**The important quirk:** for every hold note the site pushes **two** objects —
a head `tap` (with `isHoldHead: true` and `endTime` set to the *hold's* end)
and the `hold` itself:

```ts
hitObjects.push({ type: "tap", column, time, endTime: isHold ? parsedEnd : time, isHoldHead: isHold });
if (isHoldNote && !mods.holdOff) {
  hitObjects.push({ type: "hold", column, time, endTime });
}
```

So `hitObjects.length` over-counts. Our timeline builder drops the head tap and
lets the `hold` drive both the press and the release, which reproduces the
site's own autoplay exactly. A plain tap has `endTime === time`; a hold head has
`endTime > time` — that is how we tell them apart even without `isHoldHead`.

Column derivation:

```ts
const column = Math.floor((x * columnCount) / 512);
```

`holdOff` collapses holds into taps. `mirror` applies `columnMap.toReversed()`.
`random` shuffles the column map **at runtime and never persists it** — so a
random-modded chart cannot be reconstructed from the `.osu` file. We flag that
as unreliable rather than guessing.

## 5. The clock

`src/osuMania/game.ts`:

```ts
private playUpdate(isAfterSeek?: boolean) {
  this.timeElapsed = Math.round(this.song.seek() * 1000);
  ...
  this.replayPlayer?.update(this.timeElapsed, isAfterSeek);
}
```

- `timeElapsed` is **chart time in ms**, sampled once per rendered frame from
  the Howler/Web Audio position, and rounded to whole ms.
- Judgement uses this value, not `performance.now()`.
- `audioOffset = settings.audioOffset - outputLatency`, and it is baked into
  every hit object: `hitObject.time += delay - audioOffset`.
- `delay = Math.max(1000 - hitObjects[0].time / mods.playbackRate, 0) * mods.playbackRate`
  — at least one second before the first note.
- `playbackRate` is applied to the **audio** (`this.song.rate(...)`), *not* to
  note times. Since `timeElapsed` follows `song.seek()`, it already tracks the
  rate.

This is why the tool fits a linear model between `performance.now()` and
`timeElapsed` (`src/timing/clock.ts`) rather than assuming a fixed relationship:
the chart clock's slope equals the playback rate, it quantises to 1ms, it only
advances when a frame renders, and it jumps on seek/pause/retry.

`game.state` is `"WAIT" | "PLAY" | "PAUSE" | "UNPAUSE" | "FAIL"`. Column hits
are ignored unless `state === "PLAY"` (or a replay is playing).

## 6. The site already has an autoplay

`src/components/game/gameModal.tsx`:

```ts
// If autoplay is enabled and we're not already watching a replay, use a perfect replay
if (!replay && mods.autoplay) {
  const autoReplay = generateAutoReplay(parsedBeatmapData, …);
}
```

`src/lib/replay.ts`:

```ts
for (const hitObject of beatmapData.hitObjects) {
  if (hitObject.type === "tap") {
    inputs.push(
      [hitObject.column, hitObject.time + beatmapData.audioOffset, true],
      [hitObject.column, hitObject.endTime + beatmapData.audioOffset, false],
    );
  }
}
```

and `src/osuMania/systems/replayPlayer.ts` subtracts `game.audioOffset` back
off, sorts by time, and calls `inputSystem.hit/release` directly.

Two things follow:

1. **This tool is redundant for pure autoplay.** If you just want to watch a
   map played perfectly, enable the site's Autoplay mod. It is strictly better:
   no timing model, no synthetic events, frame-exact.
2. Our ordering matches the site's, because both derive from the same
   construction order (press then release per hit object) and both use a stable
   sort on time alone. That is what makes a hold ending exactly where the next
   note on that column begins release *before* pressing, instead of swallowing
   the press.

Keyfall refuses to run while `mods.autoplay` is on: two independent schedulers
driving one input system would double-fire every note.

This also constrains the optional humanization engine. Because a humanized run is
*deliberately* imperfect, it is not a substitute for the site's Autoplay mod, and
it is not presented as one: it is off by default, and the frame-exact path is the
baseline. Nothing about humanization changes what the site receives — the same
synthetic `keydown`/`keyup` events on `document`, judged by the same
`InputSystem`, at slightly different moments.

## 7. Score readback

`src/osuMania/systems/score.ts` exposes plain numbers:

```ts
public 320 = 0; public 300 = 0; public 200 = 0; public 100 = 0; public 50 = 0; public 0 = 0;
public score = 0; public combo = 0; public maxCombo = 0; public accuracy = 1;
```

So the overlay reads accuracy/combo/score from `game.scoreSystem` instead of
parsing the Pixi `BitmapText` HUD. `accuracy` is a 0–1 fraction.

## 8. Beatmap delivery

Beatmaps arrive as `.osz` (ZIP) blobs from a provider (SayoBot, Mino,
NeriNyan) or from a user upload, fetched via `fetch`/XHR and unzipped with
`@zip.js/zip.js`. The read-only network sniffer in
`src/detect/chartSource.ts` observes those responses and parses the `.osu`
entry itself using `DecompressionStream("deflate-raw")` — no bundler
dependency. It is a *fallback* chart source for when the live `Game` cannot be
reached; requests are never modified, blocked or replayed.

---

## What breaks if the site changes

| Site change | Effect | Fix |
|---|---|---|
| Stops setting `window.__PIXI_APP__` | Strategy 1 fails | Strategies 2/3 (canvas scan, fiber probe) still work |
| Renames `Game` fields | `looksLikeGame` may reject | Widen the shape check in `src/detect/fiber.ts` |
| Adds an `isTrusted` check | **Input stops working entirely** | No legitimate fix. This is the hard ceiling. |
| Moves keybinds out of `settings.keybinds.keyModes` | Auto-mapping fails | Configure the mapping manually in Settings → Input |
| Changes `.osz` provider or transport | Fallback parser loses its source | Primary path unaffected (it reads the live game) |
| Switches renderer away from Pixi | `__PIXI_APP__` disappears | Strategies 2/3 |
| Changes hold representation | Timeline may double-fire | Update pass 1 of `src/chart/timeline.ts`, and `countUniqueNotes` |
| Changes how holds are stored so the head is no longer a tap | The head dedup stops matching | `isHoldHead` and the `endTime > time` marker are both checked; update `holdKeys` |
