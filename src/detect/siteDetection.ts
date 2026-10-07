import { DEV_HOST_PATTERN, KNOWN_HOSTS } from "../constants";

export type SiteVerdict = "confirmed" | "probable" | "unknown";

export interface SiteCheck {
  verdict: SiteVerdict;
  host: string;
  message: string;
}

/**
 * Determine whether the current page is Web osu!mania.
 *
 * Three tiers, cheapest first:
 *  1. Hostname match against known deployments  -> confirmed
 *  2. Localhost dev server                      -> probable
 *  3. DOM fingerprint (Pixi canvas + site text) -> probable
 *
 * The DOM fingerprint exists because the site has changed hosts twice
 * already; a future move should not silently disable the tool.
 */
export function detectSite(win: Window = window): SiteCheck {
  const host = win.location.hostname.toLowerCase();

  if (KNOWN_HOSTS.some((known) => host === known)) {
    return { verdict: "confirmed", host, message: `Web osu!mania (${host})` };
  }

  // Subdomain of a known apex domain (e.g. a preview deployment).
  const apexMatch = KNOWN_HOSTS.some(
    (known) => host.endsWith(`.${known}`) && host !== known,
  );
  if (apexMatch) {
    return { verdict: "confirmed", host, message: `Web osu!mania (${host})` };
  }

  if (DEV_HOST_PATTERN.test(host)) {
    return {
      verdict: "probable",
      host,
      message: `Local dev server (${host}) — assuming Web osu!mania`,
    };
  }

  if (matchesDomFingerprint(win.document)) {
    return {
      verdict: "probable",
      host,
      message: `Unrecognised host (${host}) but the page looks like Web osu!mania`,
    };
  }

  return {
    verdict: "unknown",
    host,
    message: "Web osu!mania not detected.",
  };
}

/**
 * Structural fingerprint of the site. Deliberately tolerant: it looks for a
 * WebGL canvas plus wording unique to this project, not for class names that
 * a Tailwind refactor would churn.
 */
function matchesDomFingerprint(doc: Document): boolean {
  const canvas = doc.querySelector("canvas");
  if (!canvas) return false;

  const isWebgl =
    canvas.getAttribute("data-pixi") !== null ||
    // Pixi v8 canvases are created via WebGL context; check for the attribute
    // set by the site's own devtools hook as a cheap proxy.
    (doc.defaultView as any)?.__PIXI_APP__ != null;

  const text = (doc.title + " " + (doc.body?.innerText?.slice(0, 4000) ?? ""))
    .toLowerCase();
  const mentionsGame =
    text.includes("osu!mania") ||
    text.includes("web osu") ||
    text.includes("beatmap");

  return isWebgl || mentionsGame;
}

/**
 * The exact copy the spec requires when the page is not the target site.
 * Kept as a constant so it can never drift from the requirement.
 */
export const NOT_DETECTED_MESSAGE = "Web osu!mania not detected.";
