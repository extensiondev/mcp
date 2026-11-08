// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import fs from "node:fs";

import { listBridgeTabs } from "./bridge-tab-list";
import { isGeckoFamily } from "./browser-family";
import { rdpPortMissingHint, resolveRdpPort, type RdpPortAnswer } from "./cdp-port";
import { envelope } from "./envelope";
import { productionSessionCommand } from "./extension-surfaces";
import { matchPatternCovers } from "./match-patterns";
import { manifestCandidates } from "./project-manifest";
import { rdpEvaluateInTab } from "./rdp";
import { geckoRecency } from "./target-pick";

import type { RdpTab } from "./rdp";

export const NO_SCRIPTING_API = /scripting is not available/i;

const TAB_ID_ASKED_FOR = /requires a tabId \(content\/page\)/i;

export function geckoManifestVersion(
  projectPath: string,
  browser: string,
): 2 | 3 | null {
  for (const file of manifestCandidates(projectPath, browser)) {
    let manifest: Record<string, any>;

    try {
      manifest = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      continue;
    }

    const version =
      manifest["firefox:manifest_version"] ??
      manifest["gecko:manifest_version"] ??
      manifest.manifest_version;
    if (version === 3) return 3;
    if (version === 2) return 2;
  }

  return null;
}

export function lacksScriptingOnMv3(
  projectPath: string,
  browser: string,
  refusal: Record<string, any> | null,
  tabNamed = false,
): boolean {
  if (!isGeckoFamily(browser) || !refusal || refusal.ok !== false) return false;
  if (geckoManifestVersion(projectPath, browser) !== 3) return false;

  const message = String(refusal.error?.message ?? "");

  if (NO_SCRIPTING_API.test(message)) return true;

  return tabNamed && TAB_ID_ASKED_FOR.test(message) && productionSessionCommand(projectPath, browser) !== null;
}

export function noScriptingReason(projectPath: string, browser: string): string {
  const production = productionSessionCommand(projectPath, browser);

  return production
    ? `this ${browser} ${production} session runs the build with its own permissions, and an MV3 build has no tabs.executeScript and gets chrome.scripting only from a "scripting" permission this manifest does not grant (extension_dev adds it for its own runs)`
    : `this ${browser} copy of the MV3 build has no chrome.scripting (its manifest grants no "scripting" permission), and MV3 has no tabs.executeScript`;
}

function sameDocument(a: string, b: string): boolean {
  return a.replace(/#.*$/, "") === b.replace(/#.*$/, "");
}

export function webTabsByUrl(tabs: RdpTab[], url: string): RdpTab[] {
  const urlOf = (tab: RdpTab) => String(tab.url ?? "");
  const exact = tabs.filter((tab) => sameDocument(urlOf(tab), url));
  if (exact.length) return [...exact].sort(geckoRecency);

  const covered = tabs.filter((tab) => matchPatternCovers(url, urlOf(tab)));
  if (covered.length) return [...covered].sort(geckoRecency);

  const wanted = url.toLowerCase();

  return tabs.filter((tab) => urlOf(tab).toLowerCase().includes(wanted)).sort(geckoRecency);
}

export type GeckoTabPick = {
  label: string;
  select: (tabs: RdpTab[]) => RdpTab | undefined;
};

export async function geckoTabPick(
  projectPath: string,
  browser: string,
  target: { url?: string; tab?: number },
  timeout: number | undefined,
  tool: string,
): Promise<GeckoTabPick | { error: string }> {
  if (typeof target.tab === "number") {
    const listed = await listBridgeTabs(projectPath, browser, timeout, tool);
    if ("error" in listed) return { error: listed.error };

    const url = listed.tabs.find((tab) => tab.tabId === target.tab)?.url;

    if (!url) {
      return {
        error: envelope({
          ok: false,
          command: tool,
          status: "no-matching-target",
          error: {
            code: "E_NO_MATCHING_TARGET",
            name: "NoMatchingTarget",
            message: `Tab ${target.tab} is not open, or the extension cannot read its url (the "tabs" permission or a host permission for it is missing), so it cannot be found over the debugger protocol.`,
          },
          value: { availableTabs: listed.tabs },
          hint: "Pass url with the page's address instead of tab.",
        }),
      };
    }

    return { label: `tab ${target.tab} (${url})`, select: (tabs) => webTabsByUrl(tabs, url)[0] };
  }

  if (target.url) {
    const url = target.url;

    return { label: url, select: (tabs) => webTabsByUrl(tabs, url)[0] };
  }

  return { label: "the active tab", select: (tabs) => tabs.find((tab) => tab.selected === true) };
}

export function contentWorldUnreachable(tool: string, projectPath: string, browser: string): string {
  return envelope({
    ok: false,
    command: tool,
    status: "content-world-unreachable",
    error: {
      code: "E_PAGE_NOT_SCRIPTABLE",
      name: "ContentWorldUnreachable",
      message: `Nothing was evaluated: ${noScriptingReason(projectPath, browser)}, so no route into the tab's content-script world exists here. The debugger protocol reaches the tab's page world only.`,
    },
    hint: `Pass context: "page" to read the tab's DOM and page globals over the debugger protocol, or run extension_dev with browser: "${browser}", whose build carries the scripting permission, to read the content-script world.`,
  });
}

export function noDebuggerForTab(tool: string, projectPath: string, browser: string, what: string, miss: RdpPortAnswer = null): string {
  return envelope({
    ok: false,
    command: tool,
    status: "page-unreachable",
    error: {
      code: "E_PAGE_NOT_SCRIPTABLE",
      name: "PageUnreachable",
      message: `${what} was not read: ${noScriptingReason(projectPath, browser)}, and this session's contract records no debugger (RDP) port to read the tab over instead.`,
    },
    hint: miss?.port === null
      ? rdpPortMissingHint(miss)
      : `Run extension_dev with browser: "${browser}" to read web pages on Firefox, or restart this session and confirm it with extension_wait so its contract publishes the debugger port.`,
  });
}

export function overProtocolNote(projectPath: string, browser: string, label: string): string {
  return `Because ${noScriptingReason(projectPath, browser)}, ${label} was read over the debugger protocol, in the page's own world (not the content-script world).`;
}

export async function readGeckoTabWithoutScripting(
  args: { projectPath: string; url?: string; tab?: number; timeout?: number },
  browser: string,
  expression: string,
  tool: string,
): Promise<{ value: unknown; url: string; title: string; note: string } | { error: string }> {
  const pick = await geckoTabPick(args.projectPath, browser, { url: args.url, tab: args.tab }, args.timeout, tool);
  if ("error" in pick) return pick;

  const resolved = await resolveRdpPort(args.projectPath, browser, { waitMs: 3_000, graceMs: 1_000 });
  if (!resolved?.port) return { error: noDebuggerForTab(tool, args.projectPath, browser, pick.label, resolved) };

  let outcome: Awaited<ReturnType<typeof rdpEvaluateInTab>>;

  try {
    outcome = await rdpEvaluateInTab(resolved.port, { select: pick.select, expression, timeoutMs: args.timeout ?? 10_000 });
  } catch (err) {
    outcome = { ok: false, name: "RdpFailed", message: err instanceof Error ? err.message : String(err) };
  }

  if (outcome.ok) {
    return {
      value: outcome.value,
      url: outcome.tab.url,
      title: outcome.tab.title,
      note: overProtocolNote(args.projectPath, browser, pick.label),
    };
  }

  const missing = outcome.name === "TargetNotFound";

  return {
    error: envelope({
      ok: false,
      command: tool,
      status: missing ? "no-matching-target" : "rdp-failed",
      error: {
        code: missing ? "E_NO_MATCHING_TARGET" : "E_RDP",
        name: missing ? "NoMatchingTarget" : outcome.name,
        message: missing
          ? `No open tab matches ${pick.label}, so it was not read over the debugger protocol, the one route to a page on this session because ${noScriptingReason(args.projectPath, browser)}.`
          : `${pick.label} could not be read over the debugger protocol: ${outcome.message}.`,
      },
      hint: missing
        ? "Open the page first with extension_open and its url, then retry; extension_dom_snapshot with listTargets: true lists what is open."
        : "extension_doctor says whether the browser is still up; if it is, retry.",
    }),
  };
}
