/**
 * A minimal stand-in for Web osu!mania's gameplay layer.
 *
 * This is NOT a port of the game and makes no attempt to be one. It exists so
 * the real autoplay bundle can be exercised end to end in a sandbox: it
 * implements exactly the contract documented in `docs/SITE-CONTRACT.md` and
 * nothing more.
 *
 *   - `document` keydown/keyup listeners keyed on `event.code`, ignoring
 *     `event.repeat`, never checking `event.isTrusted`
 *   - a `Game`-shaped object with `state`, `timeElapsed`, `hitObjects`,
 *     `difficulty`, `columnKeybinds`, `inputSystem.pressedColumns`,
 *     `scoreSystem`
 *   - `window.__PIXI_APP__` set during play and nulled on dispose
 *   - a canvas carrying a React-fiber-shaped pointer to the game
 *   - `timeElapsed = Math.round(audioClockMs())`, the same relationship the
 *     real site has with `song.seek()`
 *
 * Judgement here is deliberately simple. The point of the demo is to show the
 * tool detecting a chart and driving real input at the right moments, not to
 * reproduce osu!mania V2 scoring.
 */
(function () {
  "use strict";

  /* ----------------------------- charts -------------------------------- */

  const tap = (column, time) => ({ type: "tap", column, time, endTime: time });
  const hold = (column, time, endTime) => ({ type: "hold", column, time, endTime });

  /**
   * Every chart is stored the way the real site stores it: a hold appears as
   * BOTH a head tap (with the hold's endTime) and a hold object. That
   * duplication is the quirk the tool's timeline builder has to undo, so the
   * demo reproduces it rather than handing over a convenient pre-cleaned array.
   */
  function withHoldHeads(notes) {
    const out = [];
    for (const note of notes) {
      if (note.type === "hold") {
        out.push({ type: "tap", column: note.column, time: note.time, endTime: note.endTime, isHoldHead: true });
      }
      out.push(note);
    }
    return out;
  }

  const CHARTS = {
    "4K — taps, holds and a chord": {
      keyCount: 4,
      notes: withHoldHeads([
        tap(0, 2000), tap(1, 2400), tap(2, 2800), tap(3, 3200),
        hold(0, 4000, 5200), tap(2, 4400), tap(3, 4800),
        hold(1, 6000, 7000), hold(3, 6000, 6600), tap(0, 6300),
        // A hold that ends exactly where the next note on that column begins.
        hold(2, 8000, 9000), tap(2, 9000),
        tap(0, 10000), tap(1, 10000), tap(2, 10000), tap(3, 10000),
        // Jacks: same column, 60ms apart.
        tap(1, 11000), tap(1, 11060), tap(1, 11120), tap(1, 11180),
        hold(0, 12000, 13500), tap(1, 12400), tap(2, 12800), tap(3, 13200),
        tap(0, 14500), tap(3, 14500), tap(1, 15000), tap(2, 15000),
      ]),
    },
    "7K — dense stream": {
      keyCount: 7,
      notes: withHoldHeads(
        Array.from({ length: 84 }, (_, i) => {
          const time = 2000 + i * 90;
          const column = [0, 1, 2, 3, 4, 5, 6, 5, 4, 3, 2, 1][i % 12];
          return i % 21 === 20 ? hold(column, time, time + 400) : tap(column, time);
        }),
      ),
    },
    "10K — wide": {
      keyCount: 10,
      notes: withHoldHeads(
        Array.from({ length: 40 }, (_, i) => {
          const time = 2000 + i * 220;
          return i % 7 === 6 ? hold(i % 10, time, time + 700) : tap(i % 10, time);
        }),
      ),
    },
  };

  const KEYBINDS_BY_COUNT = {
    4: ["KeyD", "KeyF", "KeyJ", "KeyK"],
    7: ["KeyS", "KeyD", "KeyF", "Space", "KeyJ", "KeyK", "KeyL"],
    10: ["KeyA", "KeyS", "KeyD", "KeyF", "KeyV", "KeyN", "KeyJ", "KeyK", "KeyL", "Semicolon"],
  };

  /* ------------------------------ audio -------------------------------- */

  let audioCtx = null;
  let audioStartedAt = 0; // performance.now() when playback began
  let audioOffsetSeconds = 0; // accumulated pause time
  let playing = false;

  function audioClockMs() {
    if (!playing) return audioOffsetSeconds * 1000;
    return (performance.now() - audioStartedAt) / 1000 * 1000 + audioOffsetSeconds * 1000;
  }

  function audioStart() {
    if (!audioCtx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (Ctx) audioCtx = new Ctx();
    }
    if (audioCtx && audioCtx.state === "suspended") audioCtx.resume();
    audioStartedAt = performance.now();
    audioOffsetSeconds = 0;
    playing = true;
  }

  function audioPause() {
    if (!playing) return;
    audioOffsetSeconds = audioClockMs() / 1000;
    playing = false;
  }

  function audioStop() {
    playing = false;
    audioOffsetSeconds = 0;
  }

  function click(freq, gainValue) {
    if (!audioCtx) return;
    try {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = "square";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(gainValue, audioCtx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.06);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start();
      osc.stop(audioCtx.currentTime + 0.07);
    } catch (_) {
      /* audio is cosmetic here */
    }
  }

  /* ------------------------------- game -------------------------------- */

  const HIT_WINDOW = 64; // ms, generous so the demo reads clearly

  class StubInputSystem {
    constructor(game, keybinds) {
      this.game = game;
      this.pressedColumns = new Array(game.difficulty.keyCount).fill(false);
      this.tappedColumns = new Array(game.difficulty.keyCount).fill(false);
      this.releasedColumns = new Array(game.difficulty.keyCount).fill(false);
      this.keybindsMap = new Map(keybinds.map((code, column) => [code, column]));

      this.handleKeyDown = this.handleKeyDown.bind(this);
      this.handleKeyUp = this.handleKeyUp.bind(this);
      document.addEventListener("keydown", this.handleKeyDown);
      document.addEventListener("keyup", this.handleKeyUp);
    }

    dispose() {
      document.removeEventListener("keydown", this.handleKeyDown);
      document.removeEventListener("keyup", this.handleKeyUp);
    }

    handleKeyDown(event) {
      if (event.repeat) return; // same gate the real site uses
      const column = this.keybindsMap.get(event.code);
      if (column === undefined) return;
      if (this.pressedColumns[column]) return; // no-op while already down
      this.pressedColumns[column] = true;
      this.tappedColumns[column] = true;
      if (this.game.state !== "PLAY") return;
      this.game.registerHit(column, this.game.timeElapsed);
    }

    handleKeyUp(event) {
      const column = this.keybindsMap.get(event.code);
      if (column === undefined) return;
      if (!this.pressedColumns[column]) return;
      this.pressedColumns[column] = false;
      this.releasedColumns[column] = true;
      if (this.game.state !== "PLAY") return;
      this.game.registerRelease(column, this.game.timeElapsed);
    }
  }

  class StubGame {
    constructor(chartName) {
      const chart = CHARTS[chartName];
      this.chartName = chartName;
      this.difficulty = { keyCount: chart.keyCount, od: 7, hp: 7 };
      this.columnKeybinds = KEYBINDS_BY_COUNT[chart.keyCount].map((code) => [code, null]);
      this.settings = {
        keybinds: {
          keyModes: [],
          pause: "Escape",
          retry: null,
          toggleHud: null,
        },
        mods: { autoplay: false, playbackRate: 1 },
      };
      this.mods = { autoplay: false, playbackRate: 1 };

      // Stored exactly as the site stores them, hold heads included.
      this.hitObjects = chart.notes
        .map((n) => ({ ...n }))
        .sort((a, b) => a.time - b.time || a.column - b.column);

      this.startTime = Math.min(...this.hitObjects.map((n) => n.time));
      this.endTime = Math.max(...this.hitObjects.map((n) => (n.type === "hold" ? n.endTime : n.time)));
      this.audioOffset = 0;
      this.state = "WAIT";
      this.timeElapsed = 0;

      this.scoreSystem = { score: 0, combo: 0, maxCombo: 0, accuracy: 1, 320: 0, 300: 0, 200: 0, 100: 0, 50: 0, 0: 0 };

      // Per-note bookkeeping for the demo's simple judgement.
      this.noteState = this.hitObjects.map((n) => ({
        judged: false,
        holding: false,
        holdJudged: false,
        note: n,
      }));
      this.columnCursor = new Array(this.difficulty.keyCount).fill(0);

      this.inputSystem = new StubInputSystem(this, KEYBINDS_BY_COUNT[chart.keyCount]);
      this.replayPlayer = null;
      this.app = null;

      this.onResults = null;
      this._raf = null;
      this._finishTimeout = null;
    }

    /** Attach the same anchors the real site provides. */
    mount(canvas) {
      this.app = { canvas };
      window.__PIXI_APP__ = this.app;
      // React-fiber-shaped pointer, so fiber traversal can find this instance.
      canvas["__reactFiber$stub"] = {
        child: null,
        sibling: null,
        return: null,
        stateNode: canvas,
        memoizedProps: { game: this },
        memoizedState: { memoizedState: this, next: null },
      };
      this.canvas = canvas;
    }

    start() {
      audioStart();
      this.state = "PLAY";
      this.loop();
    }

    pause() {
      if (this.state !== "PLAY") return;
      audioPause();
      this.state = "PAUSE";
    }

    resume() {
      if (this.state !== "PAUSE") return;
      audioStartedAt = performance.now();
      playing = true;
      this.state = "PLAY";
      this.loop();
    }

    loop() {
      if (this._raf) cancelAnimationFrame(this._raf);
      const step = () => {
        if (this.state !== "PLAY") return;
        this.timeElapsed = Math.round(audioClockMs());
        this.checkMisses();
        if (this.timeElapsed > this.endTime + 1500) {
          this.finish();
          return;
        }
        this._raf = requestAnimationFrame(step);
      };
      this._raf = requestAnimationFrame(step);
    }

    finish() {
      this.state = "WAIT";
      if (this._raf) cancelAnimationFrame(this._raf);
      this._raf = null;
      audioStop();
      this.onResults && this.onResults(this.summary());
    }

    dispose() {
      if (this._raf) cancelAnimationFrame(this._raf);
      this._raf = null;
      clearTimeout(this._finishTimeout);
      this.inputSystem.dispose();
      audioStop();
      window.__PIXI_APP__ = null;
      if (this.canvas) delete this.canvas["__reactFiber$stub"];
      this.state = "WAIT";
    }

    /* ------------------------- simple judgement ------------------------- */

    nextUnjudged(column) {
      for (let i = this.columnCursor[column]; i < this.noteState.length; i++) {
        const entry = this.noteState[i];
        if (entry.note.column !== column) continue;
        if (!entry.judged) return entry;
        this.columnCursor[column] = i + 1;
      }
      return null;
    }

    registerHit(column, time) {
      const entry = this.nextUnjudged(column);
      if (!entry) return;

      const isHold = entry.note.type === "hold";
      const delta = time - entry.note.time;

      if (Math.abs(delta) > HIT_WINDOW) {
        // Too early for this note: ignore, exactly as a real receptor would.
        return;
      }

      const judgement = Math.abs(delta) <= 22 ? 320 : Math.abs(delta) <= 45 ? 300 : 200;
      this.score(judgement);
      click(660 + column * 40, 0.05);

      if (isHold) {
        entry.judged = true; // head judged
        entry.holding = true;
      } else {
        entry.judged = true;
      }
    }

    registerRelease(column, time) {
      // Find a hold on this column that is currently being held.
      for (const entry of this.noteState) {
        if (entry.note.column !== column || !entry.holding) continue;
        entry.holding = false;
        entry.holdJudged = true;
        const delta = time - entry.note.endTime;
        if (Math.abs(delta) <= HIT_WINDOW * 1.5) this.score(320);
        else this.score(50);
        return;
      }
    }

    checkMisses() {
      const time = this.timeElapsed;
      for (const entry of this.noteState) {
        if (entry.judged && !entry.holding) continue;
        const limit = entry.note.type === "hold" && !entry.judged
          ? entry.note.time + HIT_WINDOW
          : entry.note.type === "hold"
            ? entry.note.endTime + HIT_WINDOW * 1.5
            : entry.note.time + HIT_WINDOW;
        if (time > limit && !entry.judged) {
          entry.judged = true;
          this.score(0);
        } else if (entry.holding && time > entry.note.endTime + HIT_WINDOW * 1.5) {
          // Held far too long: let it go so the demo cannot wedge.
          entry.holding = false;
          entry.holdJudged = true;
        }
      }
    }

    score(judgement) {
      const s = this.scoreSystem;
      s[judgement]++;
      if (judgement === 0) {
        s.combo = 0;
      } else {
        s.combo++;
        if (s.combo > s.maxCombo) s.maxCombo = s.combo;
        s.score += judgement;
      }
      const judged = s[320] + s[300] + s[200] + s[100] + s[50] + s[0];
      if (judged > 0) {
        const weighted = s[320] * 320 + s[300] * 300 + s[200] * 200 + s[100] * 100 + s[50] * 50;
        s.accuracy = weighted / (judged * 320);
      }
    }

    summary() {
      const s = this.scoreSystem;
      return {
        score: s.score,
        maxCombo: s.maxCombo,
        accuracy: s.accuracy,
        counts: { 320: s[320], 300: s[300], 200: s[200], 100: s[100], 50: s[50], miss: s[0] },
      };
    }
  }

  /* ------------------------------ renderer ----------------------------- */

  const COLUMN_COLORS = ["#ff6b9d", "#5ad1ff", "#ffd166", "#7ee081", "#c792ea", "#ff9e64", "#89ddff", "#f78c6c", "#a6e22e", "#e0af68"];

  function render(ctx, game, width, height) {
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = "#0b0c10";
    ctx.fillRect(0, 0, width, height);

    if (!game) {
      ctx.fillStyle = "#6b6d7b";
      ctx.font = "14px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("Select a chart and press Play", width / 2, height / 2);
      return;
    }

    const keyCount = game.difficulty.keyCount;
    const stageWidth = Math.min(width * 0.72, keyCount * 74);
    const stageLeft = (width - stageWidth) / 2;
    const colWidth = stageWidth / keyCount;
    const hitY = height - 90;
    const pxPerMs = 0.42;
    const time = game.timeElapsed;

    // Stage background
    ctx.fillStyle = "rgba(255,255,255,0.025)";
    ctx.fillRect(stageLeft, 0, stageWidth, height);

    // Column separators and receptors
    for (let c = 0; c < keyCount; c++) {
      const x = stageLeft + c * colWidth;
      const down = game.inputSystem.pressedColumns[c];

      if (down) {
        const grad = ctx.createLinearGradient(0, 0, 0, height);
        grad.addColorStop(0, "rgba(255,255,255,0)");
        grad.addColorStop(1, hexA(COLUMN_COLORS[c % COLUMN_COLORS.length], 0.16));
        ctx.fillStyle = grad;
        ctx.fillRect(x, 0, colWidth, height);
      }

      ctx.strokeStyle = "rgba(255,255,255,0.07)";
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
      ctx.stroke();

      ctx.fillStyle = down ? COLUMN_COLORS[c % COLUMN_COLORS.length] : "rgba(255,255,255,0.13)";
      ctx.fillRect(x + 3, hitY, colWidth - 6, 9);
    }
    ctx.strokeStyle = "rgba(255,255,255,0.07)";
    ctx.beginPath();
    ctx.moveTo(stageLeft + stageWidth, 0);
    ctx.lineTo(stageLeft + stageWidth, height);
    ctx.stroke();

    // Notes
    for (const entry of game.noteState) {
      const note = entry.note;
      if (entry.judged && note.type !== "hold") continue;
      if (entry.judged && note.type === "hold" && !entry.holding) continue;

      const x = stageLeft + note.column * colWidth + 3;
      const w = colWidth - 6;
      const color = COLUMN_COLORS[note.column % COLUMN_COLORS.length];

      if (note.type === "hold") {
        const yEnd = hitY - (note.endTime - time) * pxPerMs;
        const yStart = hitY - (note.time - time) * pxPerMs;
        if (yEnd > height || yStart < -40) continue;
        ctx.fillStyle = hexA(color, entry.holding ? 0.75 : 0.3);
        ctx.fillRect(x + w * 0.22, Math.max(yEnd, -20), w * 0.56, Math.min(yStart, height + 20) - Math.max(yEnd, -20));
        ctx.fillStyle = color;
        ctx.fillRect(x, yStart - 11, w, 11);
      } else {
        const y = hitY - (note.time - time) * pxPerMs;
        if (y > height + 20 || y < -30) continue;
        ctx.fillStyle = color;
        ctx.fillRect(x, y - 11, w, 11);
      }
    }

    // HUD
    const s = game.scoreSystem;
    ctx.textAlign = "left";
    ctx.font = "600 13px ui-monospace, monospace";
    ctx.fillStyle = "#e8e9ef";
    ctx.fillText(String(s.score).padStart(8, "0"), 18, 30);
    ctx.fillStyle = "#9a9cab";
    ctx.font = "12px ui-monospace, monospace";
    ctx.fillText(`${(s.accuracy * 100).toFixed(2)}%`, 18, 50);
    ctx.fillText(`${s.combo}x`, 18, 68);
    ctx.textAlign = "right";
    ctx.fillStyle = "#6b6d7b";
    ctx.font = "11px ui-monospace, monospace";
    ctx.fillText(`${(time / 1000).toFixed(2)}s · ${game.difficulty.keyCount}K`, width - 18, 30);
    ctx.fillText(game.state, width - 18, 46);
  }

  function hexA(hex, alpha) {
    const v = hex.replace("#", "");
    const r = parseInt(v.slice(0, 2), 16);
    const g = parseInt(v.slice(2, 4), 16);
    const b = parseInt(v.slice(4, 6), 16);
    return `rgba(${r},${g},${b},${alpha})`;
  }

  /* -------------------------------- API -------------------------------- */

  window.StubGame = StubGame;
  window.STUB_CHARTS = Object.keys(CHARTS);
  window.STUB_KEYBINDS = KEYBINDS_BY_COUNT;
  window.stubRender = render;
  window.stubAudioClockMs = audioClockMs;
})();
