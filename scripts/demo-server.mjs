#!/usr/bin/env node
/**
 * Static server for the sandbox demo.
 *
 *   /            -> demo/index.html
 *   /stub-game.js-> demo/stub-game.js
 *   /autoplay.js -> dist/autoplay.js   (the real bundle, unmodified)
 *
 * The demo runs on localhost, which `detectSite` classifies as "probable" — so
 * the whole detection and autoplay pipeline runs exactly as it would on the
 * real site.
 */

import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

const PORT = Number(process.env.PORT ?? 5173);
const HOST = process.env.HOST ?? "0.0.0.0";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

/** Map a URL path to a file, keeping the demo and the built bundle distinct. */
function resolvePath(pathname) {
  const clean = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, "");

  if (clean === "/" || clean === "/index.html") return join(root, "demo", "index.html");
  if (clean === "/keyfall.js") return join(root, "dist", "keyfall.js");
  if (clean.startsWith("/demo/")) return join(root, clean);
  if (clean.startsWith("/dist/")) return join(root, clean);

  // Bare filenames resolve against demo/ first, then dist/.
  const base = clean.replace(/^\//, "");
  return join(root, "demo", base);
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const file = resolvePath(url.pathname);

    // Never serve anything outside the project.
    if (!file.startsWith(root)) {
      res.writeHead(403).end("Forbidden");
      return;
    }

    const info = await stat(file).catch(() => null);
    if (!info || !info.isFile()) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end(`404 — ${url.pathname}\n\nRun "npm run build" first if /keyfall.js is missing.`);
      return;
    }

    const body = await readFile(file);
    res.writeHead(200, {
      "content-type": MIME[extname(file)] ?? "application/octet-stream",
      "content-length": body.length,
      "cache-control": "no-store",
    });
    res.end(body);
  } catch (err) {
    res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    res.end(`500 — ${err?.message ?? err}`);
  }
});

server.listen(PORT, HOST, () => {
  console.log("");
  console.log(`  Keyfall — sandbox demo`);
  console.log(`  http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${PORT}/`);
  console.log("");
  console.log(`  Serving dist/keyfall.js as /keyfall.js`);
  console.log(`  Rebuild with: npm run build`);
  console.log("");
});
