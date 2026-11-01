// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import fs from "node:fs";

import { WEBKIT_FAMILY } from "./browser-family";
import { readExecutorStamp } from "./executor-stamp";
import { readyContractPath } from "./session-paths";

export function safariSilentLogReason(projectPath: string, browser: string): string | undefined {
  if (!WEBKIT_FAMILY.has(browser)) return undefined;

  const stamp = readExecutorStamp(projectPath, browser);
  if (!stamp) return undefined;

  const attached = stamp.executorAttachedAt;
  const detached = stamp.executorDetachedAt;

  if (stamp.runtime === "attached" || (attached && (!detached || attached > detached))) return undefined;

  const state = attached
    ? `Safari unloaded its background at ${detached}, after it last connected at ${attached}`
    : "the extension's background has not connected to the bridge in this run (ready.json records no executorAttachedAt)";

  return `The log file holds no events, and ${state}. Lines reach this file only through a connected background, so this does not mean the extension wrote nothing. Wake it with an event it listens to (extension_open url with a page its content script matches, or a click on its toolbar button) and read again.`;
}

export function safariStartingUrlWarning(
  projectPath: string,
  browser: string,
  startingUrl: string | undefined,
): string | null {
  if (!WEBKIT_FAMILY.has(browser) || !startingUrl) return null;

  let contract: Record<string, unknown>;

  try {
    contract = JSON.parse(fs.readFileSync(readyContractPath(projectPath, browser), "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }

  if (contract.startingUrlOpened === true) return null;

  const reason = typeof contract.startingUrlUnopenedReason === "string" ? contract.startingUrlUnopenedReason.trim() : "";
  const why =
    contract.startingUrlOpened === false
      ? `Safari did not open startingUrl ${startingUrl}${reason ? `: ${reason}` : ""}.`
      : `ready.json records no outcome for startingUrl ${startingUrl}, so this answer cannot say Safari opened it (an engine that does not open it on Safari records none at all).`;

  return `${why} Open it with extension_open url before driving the page.`;
}
