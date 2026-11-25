// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import path from "node:path";

import { installManagedBrowser } from "../tools/install-browser";
import { isGeckoFamily } from "./browser-family";

export const GUIDED_BROWSERS = [
  "chrome",
  "chromium",
  "edge",
  "brave",
  "opera",
  "vivaldi",
  "firefox",
  "waterfox",
  "librewolf",
  "zen",
  "floorp",
] as const;

export type GuidedBrowser = (typeof GUIDED_BROWSERS)[number];

export interface BrowserProbe {
  platform: NodeJS.Platform;
  systemBinary(browser: GuidedBrowser): string | null;
  managedBinary(browser: "chrome" | "chromium"): string | null;
  lastUsed(appPath: string): number | null;
  defaultBrowser(): string | null;
}

export interface GuidedBrowserChoice {
  browser: GuidedBrowser;
  binary: string | null;
  install: "chrome" | "chromium" | null;
  why: string;
}

const LABELS: Record<GuidedBrowser, string> = {
  chrome: "Chrome",
  chromium: "Chromium",
  edge: "Edge",
  brave: "Brave",
  opera: "Opera",
  vivaldi: "Vivaldi",
  firefox: "Firefox",
  waterfox: "Waterfox",
  librewolf: "LibreWolf",
  zen: "Zen",
  floorp: "Floorp",
};

const DEFAULT_IDS: Array<[RegExp, GuidedBrowser]> = [
  [/^com\.google\.chrome/, "chrome"],
  [/^com\.microsoft\.edgemac/, "edge"],
  [/^com\.brave\.browser/, "brave"],
  [/^org\.chromium\.chromium/, "chromium"],
  [/^com\.operasoftware\.opera/, "opera"],
  [/^com\.vivaldi\.vivaldi/, "vivaldi"],
  [/^org\.mozilla\.firefox/, "firefox"],
  [/^net\.waterfox/, "waterfox"],
  [/^io\.gitlab\.librewolf/, "librewolf"],
  [/^app\.zen-browser/, "zen"],
  [/^one\.ablaze\.floorp/, "floorp"],
  [/^(chromehtml|google-chrome)/, "chrome"],
  [/^(msedgehtm|microsoft-edge)/, "edge"],
  [/^(bravehtml|brave)/, "brave"],
  [/^(chromiumhtm|chromium)/, "chromium"],
  [/^(operastable|opera)/, "opera"],
  [/^vivaldi/, "vivaldi"],
  [/^(librewolf)/, "librewolf"],
  [/^(waterfox)/, "waterfox"],
  [/^(floorp)/, "floorp"],
  [/^(zen)/, "zen"],
  [/^(firefoxurl|firefox)/, "firefox"],
];

export function guidedBrowserLabel(browser: GuidedBrowser): string {
  return LABELS[browser];
}

export function browserOfDefaultId(raw: string | null): GuidedBrowser | null {
  const id = String(raw ?? "").trim().toLowerCase().replace(/^.*[\\/]/, "").replace(/^firefox_/, "");
  if (!id) return null;

  return DEFAULT_IDS.find(([pattern]) => pattern.test(id))?.[1] ?? null;
}

export function appBundleOf(binary: string): string {
  const at = binary.indexOf(".app/");

  return at < 0 ? binary : binary.slice(0, at + 4);
}

function lastUsedPick(probe: BrowserProbe): { browser: GuidedBrowser; at: number } | null {
  let best: { browser: GuidedBrowser; at: number } | null = null;

  for (const browser of GUIDED_BROWSERS) {
    const binary = probe.systemBinary(browser);
    if (!binary) continue;

    const at = probe.lastUsed(appBundleOf(binary));
    if (at !== null && (!best || at > best.at)) best = { browser, at };
  }

  return best;
}

function picked(probe: BrowserProbe): { browser: GuidedBrowser; reason: string } | null {
  const used = probe.platform === "darwin" ? lastUsedPick(probe) : null;
  if (used) return { browser: used.browser, reason: "the browser you used most recently" };

  const fallback = browserOfDefaultId(probe.defaultBrowser());

  return fallback && probe.systemBinary(fallback) ? { browser: fallback, reason: "your default browser" } : null;
}

/* @invariant THE GUIDED BROWSER IS ONE THE MCP CAN LOAD AN EXTENSION INTO,
 * NEVER SAFARI AND NEVER BRANDED CHROME. Cezar ruled on 2026-11-24 that the
 * store connect opens the person's most recently used browser the MCP can
 * control (the app last-used date on macOS, the system default on Windows and
 * Linux and on a Mac whose last-used dates cannot be read), falling back to
 * Chromium. Branded Chrome refuses a command-line
 * extension since Chrome 137, so a Chrome person gets the managed Chrome for
 * Testing, installed through the same path extension_browsers install uses.
 */
export function chooseGuidedBrowser(probe: BrowserProbe): GuidedBrowserChoice {
  const pick = picked(probe);

  if (pick?.browser === "chrome") {
    const binary = probe.managedBinary("chrome");

    return {
      browser: "chrome",
      binary,
      install: binary ? null : "chrome",
      why: `Chrome for Testing, since Chrome is ${pick.reason} and branded Chrome refuses a loaded extension.`,
    };
  }

  if (pick) {
    return { browser: pick.browser, binary: probe.systemBinary(pick.browser), install: null, why: `${LABELS[pick.browser]}, ${pick.reason}.` };
  }

  const binary = probe.managedBinary("chromium") ?? probe.systemBinary("chromium");

  return {
    browser: "chromium",
    binary,
    install: binary ? null : "chromium",
    why: "Chromium, since no browser the MCP can load an extension into was found as your recent or default one.",
  };
}

export function guidedEngine(browser: GuidedBrowser): "chromium" | "gecko" {
  return isGeckoFamily(browser) ? "gecko" : "chromium";
}

export function guidedProfileDir(stateDir: string, browser: GuidedBrowser): string {
  return path.join(stateDir, "guided-browser", browser, "profile");
}

/* @invariant THE GUIDED PATH INSTALLS ITS OWN ENGINE BROWSER (MCP ledger
 * 1151). Chrome for Testing or Chromium lives in the managed cache, which a
 * cleanup can empty while a guided window still runs from it; the person
 * asked for the guided window, and extension_browsers_install sits in a tool
 * group most servers start without, so the open installs the managed browser
 * itself and says so, or says why it could not.
 */
export async function installGuidedBrowser(browser: string): Promise<string | null> {
  const answer = JSON.parse(await installManagedBrowser(browser)) as { ok?: boolean; error?: { message?: string } };

  return answer.ok === true ? null : answer.error?.message || `installing ${browser} did not finish`;
}

export async function installedChoice(runtime: { probe(): BrowserProbe; install?(browser: string): Promise<string | null> }): Promise<{ choice: GuidedBrowserChoice; failed: string | null }> {
  const first = chooseGuidedBrowser(runtime.probe());
  if (!first.install || !runtime.install) return { choice: first, failed: null };

  const failed = await runtime.install(first.install);

  return { choice: failed ? first : chooseGuidedBrowser(runtime.probe()), failed };
}
