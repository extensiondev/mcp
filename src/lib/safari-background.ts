// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import fs from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

import { WEBKIT_FAMILY } from "./browser-family";
import { matchPatternCovers } from "./match-patterns";
import { declaredContentScripts, readBuiltManifest } from "./project-manifest";
import { readyContractPath } from "./session-paths";
import {
  readWebDriverSession,
  WebDriverClient,
  webdriverSessionEnded,
} from "./webdriver";

import type { ReadyContract } from "./types";

export const SAFARI_WAKE_WAIT_MS = 8_000;

export const SAFARI_BACKGROUND_UNLOAD =
  "Safari unloads an idle background page about 30 s after its last event, and it comes back on the next extension event, not on its own";

export interface SafariWakeOutcome {
  woke: boolean;
  attempted: boolean;
  how: string;
  waitedMs: number;
}

export type WakePlan = { action: "refresh" | "navigate"; url: string };

const WEB_PAGE = /^https?:\/\//i;

export function safariExecutorUnavailable(frame: any, browser: string | undefined): boolean {
  if (!browser || !WEBKIT_FAMILY.has(browser) || !frame || frame.ok !== false) return false;

  const code = typeof frame.error?.code === "string" ? frame.error.code : "";

  return code === "E_CONTROL_UNAVAILABLE" || /no executor connected/i.test(String(frame.error?.message ?? ""));
}

export function wakeUrlFromMatchPattern(pattern: string): string | null {
  const found = /^(\*|https?):\/\/([^/]+)(\/.*)?$/.exec(pattern.trim());
  if (!found) return null;

  const host = found[2] === "*" ? null : found[2].replace(/^\*\./, "");
  if (!host || host.includes("*")) return null;

  const scheme = found[1] === "*" ? "https" : found[1];
  const path = (found[3] ?? "/").replace(/\*.*$/, "");

  return `${scheme}://${host}${path || "/"}`;
}

export function wakePlan(patterns: string[], current: string | null): WakePlan | null {
  const onWebPage = current !== null && WEB_PAGE.test(current);

  if (onWebPage && patterns.some((p) => p === "<all_urls>" || matchPatternCovers(p, current))) {
    return { action: "refresh", url: current };
  }

  for (const pattern of patterns) {
    const url = wakeUrlFromMatchPattern(pattern);
    if (url) return { action: "navigate", url };
  }

  return patterns.includes("<all_urls>") ? { action: "navigate", url: "https://example.com/" } : null;
}

function readContract(projectPath: string, browser: string): ReadyContract | null {
  try {
    return JSON.parse(fs.readFileSync(readyContractPath(projectPath, browser), "utf8")) as ReadyContract;
  } catch {
    return null;
  }
}

function executorAttached(contract: ReadyContract | null): boolean {
  if (!contract) return false;
  if (contract.runtime === "attached") return true;
  if (typeof contract.executorAttachedAt !== "string") return false;

  return typeof contract.executorDetachedAt !== "string" || contract.executorAttachedAt > contract.executorDetachedAt;
}

function contentScriptPatterns(projectPath: string, browser: string): string[] {
  const built = readBuiltManifest(projectPath, browser);

  return built ? declaredContentScripts(built.manifest).flatMap((script) => script.matches) : [];
}

export async function wakeSafariBackground(
  projectPath: string,
  browser: string,
  waitMs: number,
): Promise<SafariWakeOutcome> {
  const info = readWebDriverSession(projectPath, browser);

  if (!info) {
    return {
      woke: false,
      attempted: false,
      how: "ready.json records no safaridriver session for this run, so this server has no window to send the extension an event through",
      waitedMs: 0,
    };
  }

  if (executorAttached(readContract(projectPath, browser))) {
    return { woke: true, attempted: false, how: "the executor attached again on its own before this server sent an event", waitedMs: 0 };
  }

  const client = new WebDriverClient(info);
  let current: string | null = null;

  try {
    current = await client.currentUrl();
  } catch (error) {
    if (webdriverSessionEnded(error)) {
      return { woke: false, attempted: false, how: `the dev session's WebDriver session ${info.sessionId} has ended, so the automation window cannot be driven`, waitedMs: 0 };
    }
  }

  const plan = wakePlan(contentScriptPatterns(projectPath, browser), current);

  if (!plan) {
    return {
      woke: false,
      attempted: false,
      how: "the built manifest declares no content script match this server can send the automation window to, and the extension's own Safari page address is not recorded",
      waitedMs: 0,
    };
  }

  const did = plan.action === "refresh"
    ? `reloaded ${plan.url} in the automation window so its content script runs again`
    : `sent the automation window to ${plan.url}, a page its content script matches`;

  try {
    if (plan.action === "refresh") await client.refresh();
    else await client.navigate(plan.url);
  } catch (error) {
    return {
      woke: false,
      attempted: true,
      how: `the automation window could not be sent to ${plan.url} (${error instanceof Error ? error.message : String(error)})`,
      waitedMs: 0,
    };
  }

  const started = Date.now();

  while (Date.now() - started < waitMs) {
    if (executorAttached(readContract(projectPath, browser))) {
      return { woke: true, attempted: true, how: did, waitedMs: Date.now() - started };
    }

    await sleep(250);
  }

  return {
    woke: false,
    attempted: true,
    how: `${did}, and the executor had not attached again ${waitMs} ms later`,
    waitedMs: Date.now() - started,
  };
}

function secondsSince(iso: string): number | null {
  const at = Date.parse(iso);

  return Number.isFinite(at) ? Math.max(0, Math.round((Date.now() - at) / 1000)) : null;
}

export function safariBackgroundUnavailableMessage(
  contract: ReadyContract | null,
  wake: SafariWakeOutcome,
): string {
  const detachedAt = typeof contract?.executorDetachedAt === "string" ? contract.executorDetachedAt : null;
  const ago = detachedAt ? secondsSince(detachedAt) : null;
  const when = detachedAt ? ` (its executor detached at ${detachedAt}${ago !== null ? `, ${ago} s ago` : ""})` : "";
  const tried = wake.attempted
    ? `This call tried once to wake it: it ${wake.how}, so it answers unavailable (woke: ${wake.woke}).`
    : `This call could not wake it: ${wake.how} (woke: false).`;

  return `No executor connected: the extension's background page is unloaded${when}. ${SAFARI_BACKGROUND_UNLOAD}. ${tried}`;
}

export function safariBackgroundWakeHint(): string {
  return 'Wake the extension with an event it listens to and read within 30 s of it: extension_open url with a page its content script matches (the automation window navigates there and the content script\'s first message brings the background back), a page you open in Safari yourself, or a click on its toolbar button. When it connects, ready.json stamps executorAttachedAt again and extension_wait answers ready. extension_eval context "page" with a url needs no background on Safari: it runs over the automation window\'s WebDriver session.';
}

function wokeWarning(wake: SafariWakeOutcome): string {
  return `The extension's background page was unloaded (${SAFARI_BACKGROUND_UNLOAD}); this call ${wake.how}${wake.attempted ? ` and the executor attached again ${wake.waitedMs} ms later` : ""}, then ran again (woke: true).`;
}

export async function answerAfterSafariWake(
  frame: any,
  projectPath: string,
  browser: string,
  rerun: () => Promise<any>,
  waitMs: number,
): Promise<any> {
  const wake = await wakeSafariBackground(projectPath, browser, waitMs);
  let answer = frame;

  if (wake.woke) {
    const again = await rerun();

    if (again && typeof again === "object" && again.ok !== false) {
      if (!Array.isArray(again.warnings)) again.warnings = [];

      again.warnings.push(wokeWarning(wake));

      if (again.value && typeof again.value === "object" && !Array.isArray(again.value)) {
        again.value = { ...again.value, woke: true };
      }

      return again;
    }

    if (again && typeof again === "object" && again.error) answer = again;
  }

  const value = answer.value && typeof answer.value === "object" && !Array.isArray(answer.value) ? answer.value : {};

  answer.error = { ...answer.error, message: safariBackgroundUnavailableMessage(readContract(projectPath, browser), wake) };
  answer.value = { ...value, browser, woke: wake.woke, wake: wake.how };
  answer.hint = safariBackgroundWakeHint();

  return answer;
}
