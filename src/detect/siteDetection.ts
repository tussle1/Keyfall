import {
  ASHTONK_APP_GLOBAL,
  ASHTONK_HOST_PATTERN,
  ASHTONK_HOSTS,
  DEV_HOST_PATTERN,
  KNOWN_HOSTS,
} from "../constants";
import { readAshtonkApi } from "./ashtonkAdapter";

export type SiteVerdict = "confirmed" | "probable" | "unknown";
export type SiteFamily = "webosumania" | "ashtonkmania" | "unknown";

export interface SiteCheck {
  verdict: SiteVerdict;
  host: string;
  message: string;
  /** Which site adapter should own this page. Omitted by older callers. */
  family?: SiteFamily;
}

/** Recognise the known Ashtonk!mania deployments and versioned previews. */
export function isAshtonkHost(host: string): boolean {
  const h = host.toLowerCase();
  return (
    ASHTONK_HOSTS.includes(h) ||
    ASHTONK_HOST_PATTERN.test(h) ||
    h.endsWith(".ashtonkmania.lokaux.workers.dev")
  );
}

/**
 * Determine whether the current page is one of the supported mania sites.
 *
 * Three tiers, cheapest first:
 *  1. Hostname match or exported site global       -> confirmed
 *  2. Localhost dev server                        -> probable
 *  3. DOM fingerprint (canvas + site wording)     -> probable
 *
 * The DOM fingerprint exists because Web osu!mania has changed hosts twice
 * already; a future move should not silently disable the tool. Ashtonk!mania
 * additionally exports `window.AshtonkMania`, which works for the saved
 * single-file HTML build as well as hosted deployments.
 */
export function detectSite(win: Window = window): SiteCheck {
  const host = win.location.hostname.toLowerCase();
  const ashtonkApi = readAshtonkApi(win);

  if (isAshtonkHost(host) || ashtonkApi) {
    return {
      verdict: "confirmed",
      host,
      family: "ashtonkmania",
      message: `Ashtonk!mania (${host})`,
    };
  }

  if (KNOWN_HOSTS.some((known) => host === known)) {
    return {
      verdict: "confirmed",
      host,
      family: "webosumania",
      message: `Web osu!mania (${host})`,
    };
  }

  // Subdomain of a known apex domain (e.g. a preview deployment).
  const apexMatch = KNOWN_HOSTS.some(
    (known) => host.endsWith(`.${known}`) && host !== known,
  );
  if (apexMatch) {
    return {
      verdict: "confirmed",
      host,
      family: "webosumania",
      message: `Web osu!mania (${host})`,
    };
  }

  if (DEV_HOST_PATTERN.test(host)) {
    return {
      verdict: "probable",
      host,
      family: "webosumania",
      message: `Local dev server (${host}) — assuming Web osu!mania`,
    };
  }

  const ashtonkFingerprint = /ashtonk/i.test(win.document.title ?? "");
  if (matchesDomFingerprint(win.document)) {
    return {
      verdict: "probable",
      host,
      family: ashtonkFingerprint ? "ashtonkmania" : "webosumania",
      message: ashtonkFingerprint
        ? `Unrecognised host (${host}) but the page looks like Ashtonk!mania`
        : `Unrecognised host (${host}) but the page looks like Web osu!mania`,
    };
  }

  return {
    verdict: "unknown",
    host,
    family: "unknown",
    message: NOT_DETECTED_MESSAGE,
  };
}

/**
 * Structural fingerprint of either supported site. Deliberately tolerant: it
 * looks for a canvas plus wording unique to these projects, not for class names
 * that a refactor would churn.
 */
function matchesDomFingerprint(doc: Document): boolean {
  const canvas = doc.querySelector("canvas");
  if (!canvas) return false;

  const view = doc.defaultView as (Window & Record<string, unknown>) | null;
  const isWebgl =
    canvas.getAttribute("data-pixi") !== null ||
    // Pixi v8 canvases are created via a WebGL context; the site's devtools
    // hook / Ashtonk's exported app are cheap proxies for that.
    view?.__PIXI_APP__ != null ||
    view?.[ASHTONK_APP_GLOBAL] != null;

  const text = (doc.title + " " + (doc.body?.innerText?.slice(0, 4000) ?? ""))
    .toLowerCase();
  const mentionsGame =
    text.includes("osu!mania") ||
    text.includes("web osu") ||
    text.includes("ashtonk") ||
    text.includes("beatmap");

  return isWebgl || mentionsGame;
}

/**
 * The exact copy the spec requires when the page is not a supported site.
 * Kept as a constant so it can never drift from the requirement.
 */
export const NOT_DETECTED_MESSAGE = "Web osu!mania not detected.";
