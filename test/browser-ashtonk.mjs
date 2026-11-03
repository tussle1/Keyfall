/**
 * Optional end-to-end test against a separate, local Ashtonk!mania checkout.
 * No online game, multiplayer server, or score submission is involved.
 * See docs/ASHTONK-CONTRACT.md for setup and limitations.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const keyfallRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const ashtonkRoot = process.env.ASHTONK_ROOT && resolve(process.env.ASHTONK_ROOT);
if (!ashtonkRoot) throw new Error("Set ASHTONK_ROOT to a separate local Ashtonk!mania checkout; see docs/ASHTONK-CONTRACT.md.");
for (const file of ["index.html", "tests/fixtures/test-set.osz"]) {
  try { await stat(resolve(ashtonkRoot, file)); }
  catch { throw new Error(`Missing ${file} in ASHTONK_ROOT (${ashtonkRoot}); build or check the game checkout.`); }
}
const types = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json", ".wasm": "application/wasm",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp",
  ".woff2": "font/woff2", ".wav": "audio/wav", ".mp3": "audio/mpeg", ".osz": "application/zip",
};
const server = createServer(async (req, res) => {
  const pathname = new URL(req.url, "http://localhost").pathname;
  if (pathname.startsWith("/api/")) { res.writeHead(404).end(); return; }
  const name = pathname === "/" ? "/index.html" : pathname;
  for (const base of [ashtonkRoot, resolve(ashtonkRoot, "public")]) {
    const path = resolve(base, `.${name}`);
    if (!path.startsWith(base + sep)) continue;
    try {
      const data = await readFile(path);
      res.writeHead(200, { "content-type": types[extname(path)] ?? "application/octet-stream" });
      res.end(data);
      return;
    } catch { /* try public/ next */ }
  }
  res.writeHead(404).end();
});
await new Promise((resolveListen, reject) => {
  server.once("error", reject);
  server.listen(0, "0.0.0.0", resolveListen);
});
let browser;
try {
  const args = [
    "--no-sandbox", "--autoplay-policy=no-user-gesture-required",
    ...(process.env.KEYFALL_CHROME_ARGS ?? "").split(" ").filter(Boolean),
  ];
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.CHROME_PATH || undefined,
    args,
  });
  const context = await browser.newContext({ viewport: { width: 1000, height: 700 }, serviceWorkers: "block" });
  // Never contact a real service or submit scores while exercising local fixtures.
  await context.route("**/*", (route) => {
    const url = new URL(route.request().url());
    return url.protocol === "http:" && url.hostname === "127.0.0.1" ? route.continue() : route.abort();
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const origin = `http://127.0.0.1:${server.address().port}`;
  await page.goto(origin);
  await page.waitForFunction(() => document.querySelector("#loading-screen.done"), null, { timeout: 30_000 });
  await page.waitForTimeout(400);
  if (await page.$(".onboarding")) {
    if (await page.$('.setup-choice[data-id="new"]')) await page.click('.setup-choice[data-id="new"]');
    await page.fill(".onboarding .ob-name", "Tester");
    await page.keyboard.press("Enter");
    await page.waitForSelector(".setup-step-wom, .setup-step-mobile");
    await page.evaluate(() => AshtonkMania.Onboarding.finish());
  }

  await page.evaluate(async () => {
    const M = AshtonkMania;
    M.Settings.set("ui.mascot", false);
    M.Settings.set("gameplay.showBackground", false);
    M.Settings.set("graphics.renderScale", 0.5);
    M.Settings.set("graphics.performanceMode", true);
    M.Settings.set("gameplay.scrollSpeed", 5);
    M.Settings.set("gameplay.hitLighting", false);
    M.Settings.set("gameplay.judgementMode", "od");
    const zr = new ZipReader(await (await fetch("/tests/fixtures/test-set.osz")).arrayBuffer());
    const audio = new Uint8Array(await zr.read(zr.entries.find((entry) => entry.name === "audio.wav")));
    const text = (keys) => {
      const objects = [];
      for (const time of [7000, 8400]) for (let col = 0; col < keys; col++) {
        const x = Math.floor((col + 0.5) * 512 / keys);
        const hold = time === 7000 && col % 3 === 0;
        objects.push(`${x},192,${time},${hold ? 128 : 1},0,${hold ? "7800:0:0:0:0:" : "0:0:0:0:"}`);
      }
      return `osu file format v14\n\n[General]\nAudioFilename: audio.wav\nMode: 3\n\n[Metadata]\nTitle:Keyfall Fixture\nArtist:Local Test\nCreator:Keyfall\nVersion:${keys}K Test\nBeatmapSetID:-1\n\n[Difficulty]\nHPDrainRate:3\nCircleSize:${keys}\nOverallDifficulty:5\nSliderMultiplier:1.4\nSliderTickRate:1\n\n[Events]\n\n[TimingPoints]\n0,500,4,2,0,100,1,0\n\n[HitObjects]\n${objects.join("\n")}\n`;
    };
    const encoder = new TextEncoder();
    const files = [
      { name: "audio.wav", data: audio },
      ...[4, 18].map((keys) => ({ name: `test-${keys}k.osu`, data: encoder.encode(text(keys)) })),
    ];
    const result = await M.App.importFiles([new File([writeZip(files)], "keyfall-test.osz")]);
    if (result.errors.length) throw new Error(`Could not import local chart: ${JSON.stringify(result.errors)}`);
    if (![...M.BeatmapManager.maps.values()].some((map) => map.version === "18K Test")) {
      throw new Error("Imported local chart was not found");
    }
    M.Settings.setKeybinds(4, [["KeyQ"], ["KeyW"], ["KeyE"], ["KeyR"]]);
  });
  await page.addScriptTag({ path: resolve(keyfallRoot, "release/keyfall.user.js") });
  await page.waitForFunction(() => window.Keyfall);
  await page.evaluate(() => {
    window.__play = null;
    window.__rates = [];
    window.__detections = 0;
    window.__rateTimer = null;
    window.__offDetected = Keyfall.engine.on("detected", () => {
      window.__play = AshtonkMania.GameplayScreen.s;
      window.__detections++;
      clearInterval(window.__rateTimer);
      window.__rateTimer = setInterval(() => {
        if (window.__play) window.__rates.push(window.__play.rate);
      }, 100);
    });
  });

  const cases = [
    { name: "normal 4K / custom QWER / manual arm", keys: 4, mods: [], manual: true },
    { name: "practice 4K", keys: 4, mods: [], practice: true },
    { name: "practice seek during hold", keys: 4, mods: [], practice: true, seek: true },
    { name: "daily-configured 4K (offline)", keys: 4, mods: [], daily: { day: "2026-11-03", onlineId: 1 } },
    { name: "multiplayer-configured 4K (offline)", keys: 4, mods: [], mp: true },
    { name: "Wind Up 4K", keys: 4, mods: ["WU"] },
    { name: "Wind Down 4K", keys: 4, mods: ["WD"] },
    // A small early offset causes real Adaptive Speed feedback without leaving
    // the top judgement window, so the mod actually changes its rate.
    { name: "Adaptive Speed 4K", keys: 4, mods: ["AS"], offset: -12 },
    { name: "normal 18K", keys: 18, mods: [] },
    { name: "emergency during 18K hold", keys: 18, mods: [], emergency: true },
  ];
  for (const test of cases) {
    await page.evaluate(async (test) => {
      const M = AshtonkMania;
      Keyfall.settings.set("general.autoStart", !test.manual);
      Keyfall.settings.set("timing.offset", test.offset ?? 0);
      if (test.manual) {
        Keyfall.start();
        if (Keyfall.diagnostics().pendingStart !== "manual" ||
            document.querySelector('[data-part="status"]').textContent !== "ARMED") {
          throw new Error("Manual start was not visibly armed before launching gameplay");
        }
      }
      if (M.GameplayScreen.s) M.GameplayScreen.quit();
      clearInterval(window.__rateTimer);
      window.__play = null; window.__rates = []; window.__detections = 0;
      const map = [...M.BeatmapManager.maps.values()].find((entry) => entry.version === `${test.keys}K Test`);
      M.Game.launch({
        mapId: map.id, mods: test.mods, mode: test.practice ? "practice" : "play", quick: true,
        daily: test.daily, mp: test.mp ? { startAt: performance.now() + 1000, players: [], rp: true } : undefined,
      });
    }, test);
    if (test.seek) {
      await page.waitForFunction(() => window.__play?.held.some(Boolean) && Keyfall.phase === "RUNNING", null, { timeout: 30_000 });
      await page.evaluate(() => AshtonkMania.GameplayScreen.practiceSeek(7500));
      await page.waitForFunction(() => window.__detections >= 2 && window.__play?.engine.remaining === 0, null, { timeout: 15_000 });
      const result = await page.evaluate(() => ({
        counts: [...window.__play.engine.score.counts], presses: [...window.__play.engine.pressCounts],
        held: [...window.__play.held], keyfallHeld: Keyfall.diagnostics().input.heldColumns,
      }));
      assert.deepEqual(result.counts, [4, 0, 0, 0, 0, 0], test.name);
      assert.deepEqual(result.presses, [1, 1, 1, 1], test.name);
      assert.equal(result.held.some(Boolean), false, test.name);
      assert.deepEqual(result.keyfallHeld, [], test.name);
      console.log(`PASS ${test.name}: chart rebound, all lanes played and released`);
      await page.evaluate(() => AshtonkMania.GameplayScreen.quit());
      await page.waitForFunction(() => AshtonkMania.Screens.currentName !== "gameplay", null, { timeout: 10_000 });
      await page.waitForTimeout(800);
      continue;
    }
    if (test.emergency) {
      await page.waitForFunction(() => window.__play?.held.some(Boolean) && Keyfall.phase === "RUNNING", null, { timeout: 30_000 });
      await page.evaluate(() => document.activeElement?.blur());
      await page.keyboard.press("KeyZ"); // trusted, and also an 18K lane
      await page.waitForFunction(() => Keyfall.phase === "IDLE", null, { timeout: 3000 });
      const held = await page.evaluate(() => ({ site: window.__play.held, keyfall: Keyfall.diagnostics().input.heldColumns }));
      assert.equal(held.site.some(Boolean), false, test.name);
      assert.deepEqual(held.keyfall, [], test.name);
      console.log(`PASS ${test.name}: emergency received; no held keys`);
      continue;
    }
    const expected = test.keys * 2 + Math.ceil(test.keys / 3);
    await page.waitForFunction((n) => {
      const engine = window.__play?.engine;
      return engine && engine.score.counts.reduce((a, b) => a + b, 0) >= n;
    }, expected, { timeout: 30_000 });
    const result = await page.evaluate(() => ({
      counts: [...window.__play.engine.score.counts],
      errors: window.__play.engine.hitErrors,
      presses: window.__play.engine.pressCounts,
      held: window.__play.held,
      keyfall: Keyfall.diagnostics(),
      minRate: Math.min(...window.__rates), maxRate: Math.max(...window.__rates),
      detections: window.__detections,
      practice: !!window.__play.practice, mp: !!window.__play.mp,
      adaptive: !!window.__play.adaptive,
      daily: !!AshtonkMania.GameplayScreen.params?.daily,
      feed: !!window.__play.feed,
    }));
    assert.equal(result.counts[0], expected, `${test.name}: ${JSON.stringify(result.counts)}`);
    assert.equal(result.counts.slice(1).reduce((a, b) => a + b, 0), 0, test.name);
    assert.deepEqual(result.presses, Array(test.keys).fill(2), test.name);
    assert.equal(result.errors.filter((error) => error.tail).length, Math.ceil(test.keys / 3), test.name);
    assert.equal(result.held.some(Boolean), false, test.name);
    assert.deepEqual(result.keyfall.input.heldColumns, [], test.name);
    assert.ok(["RUNNING", "READY"].includes(result.keyfall.phase), test.name);
    assert.equal(result.keyfall.pendingStart, null, test.name);
    assert.equal(result.feed, false, test.name);
    assert.equal(result.practice, !!test.practice, test.name);
    assert.equal(result.mp, !!test.mp, test.name);
    assert.equal(result.daily, !!test.daily, test.name);
    assert.equal(result.detections, 1, `${test.name}: chart should not reload as rate changes`);
    if (test.name.startsWith("Wind ")) assert.ok(result.maxRate > result.minRate + 0.05, `${test.name}: rate must actually change`);
    if (test.mods.includes("AS")) {
      assert.equal(result.adaptive, true, test.name);
      assert.ok(result.maxRate > result.minRate + 0.005, "Adaptive Speed rate must actually change");
    }
    if (test.keys === 4) assert.deepEqual(result.keyfall.mapping.codes, ["KeyQ", "KeyW", "KeyE", "KeyR"], test.name);
    console.log(`PASS ${test.name}: ${expected} top-tier judgements, all lanes, holds released, rate ${result.minRate.toFixed(2)}–${result.maxRate.toFixed(2)}`);
    await page.evaluate(() => AshtonkMania.GameplayScreen.quit());
    await page.waitForFunction(() => AshtonkMania.Screens.currentName !== "gameplay", null, { timeout: 10_000 });
    await page.waitForTimeout(800);
  }
  await page.evaluate(() => { clearInterval(window.__rateTimer); window.__offDetected(); Keyfall.uninstall(); });
  assert.deepEqual(errors, [], `Unexpected game page errors: ${errors.join("; ")}`);
} finally {
  if (browser) await browser.close();
  await new Promise((resolveClose) => server.close(resolveClose));
}
