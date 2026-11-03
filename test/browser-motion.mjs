/**
 * Real-browser regression for the panel's motion and native controls.
 *
 * Start `npm run demo` after building, then run with CHROME_PATH pointing to a
 * local Chromium/Chrome executable. KEYFALL_DEMO_URL can select another demo
 * server and KEYFALL_CHROME_ARGS can provide space-separated sandbox flags.
 */
import assert from "node:assert/strict";
import { chromium } from "playwright-core";

const demo = process.env.KEYFALL_DEMO_URL ?? "http://127.0.0.1:5173/";
const executablePath = process.env.CHROME_PATH || undefined;
const extraArgs = (process.env.KEYFALL_CHROME_ARGS ?? "").split(/\s+/).filter(Boolean);
const browser = await chromium.launch({ executablePath, args: extraArgs, headless: true });
const page = await browser.newPage({ viewport: { width: 1120, height: 1000 } });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const shift = () => page.keyboard.press("ShiftRight");
const finish = (selector) => page.evaluate((sel) => {
  document.querySelector(sel).getAnimations({ subtree: true }).forEach((animation) => {
    try { animation.finish(); } catch { animation.cancel(); }
  });
}, selector);
const state = () => page.evaluate(() => {
  const root = document.querySelector(".wom-ap-root");
  const drawer = document.querySelector(".wom-drawer");
  return {
    open: root.dataset.open, hidden: root.getAttribute("aria-hidden"), inert: root.inert,
    expanded: root.dataset.expanded, drawerHidden: drawer.getAttribute("aria-hidden"), drawerInert: drawer.inert,
  };
});

try {
  await page.goto(demo);
  await page.waitForFunction(() => window.Keyfall && document.querySelector(".wom-ap-root"));
  assert.deepEqual(await state(), {
    open: "0", hidden: "true", inert: true,
    expanded: "0", drawerHidden: "true", drawerInert: true,
  }, "panel and drawer start inaccessible");

  await shift();
  const entrance = await page.locator(".wom-panel").evaluate((panel) => {
    const animation = panel.getAnimations().find((item) => item.transitionProperty === "transform");
    if (!animation) return null;
    animation.pause();
    animation.currentTime = 60;
    const early = new DOMMatrixReadOnly(getComputedStyle(panel).transform);
    animation.currentTime = 400;
    const late = new DOMMatrixReadOnly(getComputedStyle(panel).transform);
    const timing = animation.effect.getTiming();
    animation.finish();
    return { earlyY: early.m42, lateY: late.m42, earlyScale: early.a, lateScale: late.a, timing };
  });
  assert.ok(entrance, "panel uses a real transform transition");
  assert.equal(entrance.timing.duration, 460);
  assert.match(entrance.timing.easing, /cubic-bezier/);
  assert.ok(entrance.earlyY < -1 && Math.abs(entrance.lateY) < 1, JSON.stringify(entrance));
  assert.ok(entrance.lateScale > entrance.earlyScale);
  await finish(".wom-ap-root");

  // Reverse an in-flight close without waiting for it to finish.
  await shift();
  assert.deepEqual((({ open, hidden, inert }) => ({ open, hidden, inert }))(await state()),
    { open: "0", hidden: "true", inert: true });
  const closingY = await page.locator(".wom-panel").evaluate((panel) => {
    const animation = panel.getAnimations().find((item) => item.transitionProperty === "transform");
    animation.pause(); animation.currentTime = 90;
    return new DOMMatrixReadOnly(getComputedStyle(panel).transform).m42;
  });
  await shift();
  const reopenedY = await page.locator(".wom-panel").evaluate((panel) =>
    new DOMMatrixReadOnly(getComputedStyle(panel).transform).m42);
  assert.ok(Math.abs(reopenedY - closingY) < 4, `reversal should be continuous: ${closingY} → ${reopenedY}`);
  assert.deepEqual((({ open, hidden, inert }) => ({ open, hidden, inert }))(await state()),
    { open: "1", hidden: "false", inert: false });
  await finish(".wom-ap-root");

  // Native keyboard access, focus indication, and a springing track click.
  const slider = page.locator('[data-setting="timing.offset"]').first();
  await page.keyboard.press("Tab");
  await slider.focus();
  await page.keyboard.press("ArrowRight");
  assert.equal(Number(await slider.inputValue()), 1);
  const focused = await slider.evaluate((input) => {
    const thumb = input.parentElement.querySelector(".wom-range-thumb");
    thumb.getAnimations().forEach((animation) => animation.finish());
    return { visible: input.matches(":focus-visible"), shadow: getComputedStyle(thumb).boxShadow };
  });
  assert.equal(focused.visible, true, "the real range control gets keyboard focus");
  assert.notEqual(focused.shadow, "none", "the decorative thumb shows focus");
  const box = await slider.boundingBox();
  await page.mouse.click(box.x + box.width * 0.85, box.y + box.height / 2);
  const clickMotion = await slider.evaluate((input) => {
    const wrap = input.parentElement;
    const thumb = wrap.querySelector(".wom-range-thumb");
    const animation = thumb.getAnimations().find((item) => item.transitionProperty === "left");
    if (!animation) return null;
    animation.pause(); animation.currentTime = 75;
    const mid = parseFloat(getComputedStyle(thumb).left);
    animation.currentTime = 300;
    const end = parseFloat(getComputedStyle(thumb).left);
    const timing = animation.effect.getTiming();
    animation.finish();
    return { mid, end, value: Number(input.value), progress: wrap.style.getPropertyValue("--wom-progress"), direct: wrap.dataset.direct, timing };
  });
  assert.ok(clickMotion, "track clicks animate the visible thumb");
  assert.equal(clickMotion.timing.duration, 300);
  assert.match(clickMotion.timing.easing, /cubic-bezier/);
  assert.ok(clickMotion.value > 0 && clickMotion.end > clickMotion.mid, JSON.stringify(clickMotion));
  assert.notEqual(clickMotion.direct, "1");
  assert.equal(await page.evaluate(() => Keyfall.settings.all.timing.offset), clickMotion.value);
  await finish(".wom-range-wrap");

  // Dragging must follow the native input immediately, with no left transition.
  const thumbBox = await slider.evaluate((input) => input.parentElement.querySelector(".wom-range-thumb").getBoundingClientRect().toJSON());
  await page.mouse.move(thumbBox.x + thumbBox.width / 2, thumbBox.y + thumbBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.25, box.y + box.height / 2, { steps: 5 });
  const dragging = await slider.evaluate((input) => {
    const wrap = input.parentElement;
    const visual = wrap.querySelector(".wom-range-visual").getBoundingClientRect();
    const thumb = wrap.querySelector(".wom-range-thumb");
    const rect = thumb.getBoundingClientRect();
    const progress = parseFloat(wrap.style.getPropertyValue("--wom-progress")) / 100;
    return {
      direct: wrap.dataset.direct, value: Number(input.value),
      actual: rect.x + rect.width / 2, expected: visual.x + visual.width * progress,
      transitions: thumb.getAnimations().map((animation) => animation.transitionProperty),
    };
  });
  assert.equal(dragging.direct, "1");
  assert.ok(dragging.value < 0);
  assert.ok(Math.abs(dragging.actual - dragging.expected) < 1.5, JSON.stringify(dragging));
  assert.ok(!dragging.transitions.includes("left"), "the thumb does not lag behind a drag");
  assert.equal(await page.locator('[data-tab-panel="timing"] [data-setting="timing.offset"]').inputValue(), String(dragging.value));
  await page.mouse.up();
  assert.equal(await slider.evaluate((input) => input.parentElement.dataset.direct), "0");

  // Programmatic changes and resets use the same spring, while switches use
  // their own responsive, spring-settled knob motion.
  await finish(".wom-ap-root");
  await page.evaluate(() => Keyfall.settings.set("timing.offset", 0));
  assert.equal(await slider.evaluate((input) => input.parentElement.querySelector(".wom-range-thumb")
    .getAnimations().some((animation) => animation.transitionProperty === "left")), true);
  const humanize = page.locator(".wom-quick-switches label").filter({ hasText: "Humanize" });
  await humanize.click();
  assert.equal(await page.evaluate(() => Keyfall.settings.all.humanization.enabled), true);
  assert.match(await humanize.locator(".wom-switch-knob").evaluate((knob) => getComputedStyle(knob).transitionTimingFunction), /1\.16/);
  assert.equal(await humanize.locator(".wom-switch-knob").evaluate((knob) =>
    knob.getAnimations().some((animation) => animation.transitionProperty === "transform")), true);
  assert.match(await page.locator('[data-part="start"]').evaluate((button) => getComputedStyle(button).transitionTimingFunction), /1\.16/);

  // Window movement and resizing remain directly attached to the pointer.
  await finish(".wom-ap-root");
  const originalAppearance = await page.evaluate(() => ({
    position: { ...Keyfall.settings.all.appearance.position }, size: { ...Keyfall.settings.all.appearance.size },
  }));
  const root = page.locator(".wom-ap-root");
  const initialRoot = await root.boundingBox();
  const header = await page.locator(".wom-header").boundingBox();
  await page.mouse.move(header.x + 100, header.y + header.height / 2);
  await page.mouse.down();
  await page.mouse.move(header.x + 142, header.y + header.height / 2 + 30);
  const movedRoot = await root.boundingBox();
  assert.ok(Math.abs(movedRoot.x - initialRoot.x - 42) < 1);
  assert.ok(Math.abs(movedRoot.y - initialRoot.y - 30) < 1);
  assert.equal(await root.evaluate((element) => element.getAnimations().some((animation) =>
    ["left", "top"].includes(animation.transitionProperty))), false);
  await page.mouse.up();
  const beforeResize = await root.boundingBox();
  const handle = await page.locator(".wom-resize").boundingBox();
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(handle.x + handle.width / 2 + 50, handle.y + handle.height / 2 + 25);
  const resizedRoot = await root.boundingBox();
  assert.ok(Math.abs(resizedRoot.width - beforeResize.width - 50) < 2, JSON.stringify({ beforeResize, resizedRoot }));
  assert.equal(await root.evaluate((element) => element.getAnimations().some((animation) =>
    ["width", "height"].includes(animation.transitionProperty))), false);
  await page.mouse.up();
  await page.evaluate(({ position, size }) => {
    Keyfall.settings.set("appearance.position", position);
    Keyfall.settings.set("appearance.size", size);
  }, originalAppearance);

  // Drawer state reverses independently; accessibility changes immediately.
  const more = page.locator('[data-part="more"]');
  await more.click();
  let snapshot = await state();
  assert.equal(snapshot.expanded, "1"); assert.equal(snapshot.drawerHidden, "false"); assert.equal(snapshot.drawerInert, false);
  assert.equal(await page.locator(".wom-drawer").evaluate((drawer) =>
    drawer.getAnimations().some((animation) => animation.transitionProperty === "grid-template-rows")), true);
  await more.click();
  snapshot = await state();
  assert.equal(snapshot.expanded, "0"); assert.equal(snapshot.drawerHidden, "true"); assert.equal(snapshot.drawerInert, true);
  await more.click();
  snapshot = await state();
  assert.equal(snapshot.expanded, "1"); assert.equal(snapshot.drawerInert, false);
  await finish(".wom-ap-root");

  // A scaled UI still measures tab-resize keyframes in unscaled layout pixels.
  await page.evaluate(() => Keyfall.settings.set("appearance.uiScale", 1.4));
  const scroll = page.locator(".wom-drawer-scroll");
  const beforeTab = await scroll.evaluate((element) => ({ height: element.offsetHeight, scaled: element.getBoundingClientRect().height }));
  await page.locator('[data-tab="input"]').click();
  const firstResize = await scroll.evaluate((element) => {
    const animation = element.getAnimations()[0];
    if (!animation) return null;
    const frames = animation.effect.getKeyframes();
    animation.pause(); animation.currentTime = 120;
    return { from: parseFloat(frames[0].height), to: parseFloat(frames[1].height), current: element.offsetHeight };
  });
  assert.ok(firstResize, "switching tabs animates drawer height");
  assert.ok(Math.abs(firstResize.from - beforeTab.height) <= 1, JSON.stringify({ beforeTab, firstResize }));
  assert.ok(Math.abs(firstResize.from - beforeTab.scaled) > 20, "keyframes must not use scaled screen pixels");
  assert.ok(firstResize.current > firstResize.from && firstResize.current < firstResize.to, JSON.stringify(firstResize));
  await page.locator('[data-tab="timing"]').click();
  const reversedResize = await scroll.evaluate((element) => {
    const animations = element.getAnimations();
    const frames = animations[0]?.effect.getKeyframes();
    return { count: animations.length, from: frames && parseFloat(frames[0].height) };
  });
  assert.equal(reversedResize.count, 1, "the previous resize is cancelled");
  assert.ok(Math.abs(reversedResize.from - firstResize.current) <= 1, JSON.stringify({ firstResize, reversedResize }));
  await more.click();
  assert.equal(await scroll.evaluate((element) => element.getAnimations().length), 0, "closing cancels a resize");
  assert.equal((await state()).drawerInert, true);

  // Changing the OS preference mid-animation finishes CSS transitions and
  // cancels the script-driven resize. Subsequent motion is instantaneous.
  await more.click();
  await finish(".wom-ap-root");
  await page.locator('[data-tab="input"]').click();
  assert.equal(await scroll.evaluate((element) => element.getAnimations().length), 1);
  await shift();
  assert.equal(await scroll.evaluate((element) => element.getAnimations().length), 0, "hiding cancels a resize");
  assert.equal((await state()).inert, true);
  await shift();
  await finish(".wom-ap-root");
  await page.locator('[data-tab="timing"]').click();
  await finish(".wom-ap-root");
  await page.locator('[data-tab="input"]').click();
  assert.equal(await scroll.evaluate((element) => element.getAnimations().length), 1);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.waitForFunction(() => {
    const root = document.querySelector(".wom-ap-root");
    return matchMedia("(prefers-reduced-motion: reduce)").matches
      && root.getAnimations({ subtree: true }).every((animation) => animation.playState !== "running");
  });
  assert.equal(await scroll.evaluate((element) => element.getAnimations().length), 0);
  assert.equal(await page.locator(".wom-panel").evaluate((panel) => getComputedStyle(panel).transitionDuration), "0s");
  await page.locator('[data-tab="timing"]').click();
  assert.equal(await scroll.evaluate((element) => element.getAnimations().length), 0, "reduced motion skips tab resizes");
  await page.evaluate(() => Keyfall.settings.set("timing.offset", 100));
  const reducedSlider = await slider.evaluate((input) => {
    const wrap = input.parentElement;
    const track = wrap.querySelector(".wom-range-visual").getBoundingClientRect();
    const thumb = wrap.querySelector(".wom-range-thumb");
    const rect = thumb.getBoundingClientRect();
    return {
      actual: rect.x + rect.width / 2,
      expected: track.x + track.width * parseFloat(wrap.style.getPropertyValue("--wom-progress")) / 100,
      transitions: thumb.getAnimations().map((animation) => animation.transitionProperty),
    };
  });
  assert.ok(Math.abs(reducedSlider.actual - reducedSlider.expected) < 1.5, JSON.stringify(reducedSlider));
  assert.ok(!reducedSlider.transitions.includes("left"));
  await shift();
  assert.deepEqual((({ open, hidden, inert }) => ({ open, hidden, inert }))(await state()),
    { open: "0", hidden: "true", inert: true });
  await shift();
  assert.deepEqual((({ open, hidden, inert }) => ({ open, hidden, inert }))(await state()),
    { open: "1", hidden: "false", inert: false });

  // Native touch dragging also stays direct (without a mouse-only handler).
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.evaluate(() => {
    Keyfall.settings.set("appearance.uiScale", 1);
    Keyfall.settings.set("timing.offset", 0);
  });
  await finish(".wom-ap-root");
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 });
  const touchBox = await slider.boundingBox();
  const touch = (type, x, y) => cdp.send("Input.dispatchTouchEvent", {
    type, touchPoints: type === "touchEnd" ? [] : [{ x, y, id: 1 }],
  });
  await touch("touchStart", touchBox.x + touchBox.width / 2, touchBox.y + touchBox.height / 2);
  for (const fraction of [0.45, 0.4, 0.35, 0.3, 0.25]) {
    await touch("touchMove", touchBox.x + touchBox.width * fraction, touchBox.y + touchBox.height / 2);
  }
  const duringTouch = await slider.evaluate((input) => ({
    value: Number(input.value), direct: input.parentElement.dataset.direct,
    transitions: input.parentElement.querySelector(".wom-range-thumb").getAnimations().map((animation) => animation.transitionProperty),
  }));
  assert.ok(duringTouch.value < 0);
  assert.equal(duringTouch.direct, "1");
  assert.ok(!duringTouch.transitions.includes("left"));
  await touch("touchEnd");
  assert.equal(await slider.evaluate((input) => input.parentElement.dataset.direct), "0");
  await cdp.detach();
  assert.deepEqual(errors, [], "no browser exceptions");
  console.log("Browser motion, interruption, direct-drag and reduced-motion checks passed.");
} finally {
  await browser.close();
}
