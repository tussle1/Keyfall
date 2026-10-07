#!/usr/bin/env node
/**
 * Build script.
 *
 * Produces three artifacts from the same bundle:
 *
 *   dist/autoplay.user.js    userscript (Tampermonkey / Violentmonkey / Greasy Fork)
 *   dist/autoplay.js         plain script, for a <script> tag or devtools paste
 *   dist/bookmarklet.txt     javascript: URI (see the size warning below)
 *
 * No runtime dependencies: the tool is one self-contained bundle.
 */

import { build } from "esbuild";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const watch = process.argv.includes("--watch");

const pkg = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));

const USERSCRIPT_HEADER = `// ==UserScript==
// @name         Web osu!mania Autoplay
// @namespace    https://github.com/tussle1/BedForge
// @version      ${pkg.version}
// @description  Detects the live Web osu!mania chart and plays it through the site's own keyboard input path. Local, single-player automation only.
// @author       tussle1
// @match        https://webosumania.com/*
// @match        https://www.webosumania.com/*
// @match        https://*.webosumania.com/*
// @match        https://web-osu-mania.pages.dev/*
// @match        https://web-osu-mania.vercel.app/*
// @match        http://localhost:*/*
// @match        http://127.0.0.1:*/*
// @run-at       document-start
// @grant        none
// @noframes
// @license      MIT
// ==/UserScript==
`;

const BANNER = `/*! Web osu!mania Autoplay v${pkg.version} — browser-side gameplay automation for webosumania.com. */`;

/** Shared esbuild options. */
const baseOptions = {
  entryPoints: [resolve(root, "src/main.ts")],
  bundle: true,
  format: "iife",
  target: ["es2022", "chrome110", "firefox115", "safari16.4"],
  platform: "browser",
  legalComments: "none",
  logLevel: "info",
  tsconfig: resolve(root, "tsconfig.json"),
};

await mkdir(resolve(root, "dist"), { recursive: true });

const minified = await build({
  ...baseOptions,
  minify: true,
  write: false,
  banner: { js: BANNER },
});

const code = minified.outputFiles[0].text;

// --- userscript ---------------------------------------------------------
// Wrap in an IIFE so the bundle's top-level scope can't collide with the page.
const userscript = `${USERSCRIPT_HEADER}\n(() => {\n"use strict";\n${code}\n})();\n`;
await writeFile(resolve(root, "dist/autoplay.user.js"), userscript, "utf8");

// --- plain script -------------------------------------------------------
await writeFile(resolve(root, "dist/autoplay.js"), code, "utf8");

// --- bookmarklet --------------------------------------------------------
// Percent-encode conservatively: only characters that are unsafe in a URI.
// A bookmarklet of this size exceeds what some browsers accept in a bookmark
// URL, so the README documents the snippet-loader alternative as the
// recommended path.
const bookmarkletBody = encodeURIComponent(code)
  .replace(/%20/g, "+")
  .replace(/[!'()]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

const bookmarklet = `javascript:(function(){try{var s=document.createElement('script');s.textContent=decodeURIComponent("${bookmarkletBody}");document.documentElement.appendChild(s);s.remove();}catch(e){alert('Autoplay failed to start: '+e.message);}})();`;

await writeFile(resolve(root, "dist/bookmarklet.txt"), bookmarklet, "utf8");

// --- devtools snippet loader (the practical bookmarklet) ----------------
const loader = `javascript:(function(){var s=document.createElement('script');s.src='RAW_URL_HERE/dist/autoplay.js';s.onload=function(){console.log('Autoplay loaded');};s.onerror=function(){alert('Could not load autoplay.js — check the URL and CORS.');};document.documentElement.appendChild(s);})();`;
await writeFile(resolve(root, "dist/bookmarklet-loader.txt"), loader, "utf8");

const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
console.log("");
console.log(`  dist/autoplay.user.js       ${kb(Buffer.byteLength(userscript))}`);
console.log(`  dist/autoplay.js            ${kb(Buffer.byteLength(code))}`);
console.log(`  dist/bookmarklet.txt        ${kb(Buffer.byteLength(bookmarklet))}`);
console.log(`  dist/bookmarklet-loader.txt ${kb(Buffer.byteLength(loader))}`);

if (Buffer.byteLength(bookmarklet) > 60_000) {
  console.log("");
  console.log("  ⚠ The inline bookmarklet is large. Many browsers truncate bookmark URLs");
  console.log("    past ~64KB. Prefer the userscript, or host dist/autoplay.js and use");
  console.log("    dist/bookmarklet-loader.txt with RAW_URL_HERE replaced.");
}

if (watch) {
  const ctx = await (
    await import("esbuild")
  ).context({ ...baseOptions, minify: true, write: false, banner: { js: BANNER } });
  await ctx.watch();
  console.log("\n  watching src/ …\n");
}
