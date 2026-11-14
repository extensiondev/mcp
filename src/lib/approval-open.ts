// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { spawn } from "node:child_process";

import { envelope, isEnvelope } from "./envelope";
import { envIsHeadless } from "./launch-flags";
import { APPROVAL_REQUIRED_STATUS } from "./approval-outcome";
import { isRow, text } from "./row";

import type { PageOpening } from "./kernel-hooks";

type Env = NodeJS.ProcessEnv | Record<string, string | undefined>;

export const NO_AUTO_OPEN_ENV = "EXTENSION_DEV_NO_AUTO_OPEN";

export const APPROVAL_OPENED_SENTENCE = "The approval page is open in your browser; click Approve, then tell me.";

export const APPROVAL_OPENED_SHORT = "The approval page is open in your browser.";

export const APPROVAL_BATCH_WINDOW_MS = 10 * 60 * 1000;

export const APPROVAL_BATCH_MAX = 10;

export const approvalBatchSentence = (count: number): string =>
  `One page lists all ${count} requests asked for in the last few minutes and is open in your browser; it shows each request's state, and Approve all approves every one still waiting. Approve them, then tell me.`;

export type UrlOpener = (url: string) => boolean;

const truthy = (raw: string | undefined): boolean => {
  const value = String(raw ?? "").trim().toLowerCase();

  return value !== "" && value !== "0" && value !== "false" && value !== "off";
};

export function osOpenCommand(url: string, platform: NodeJS.Platform = process.platform): [string, string[]] {
  if (platform === "darwin") return ["open", [url]];
  if (platform === "win32") return ["cmd", ["/c", "start", '""', url.replace(/[&^|<>]/g, (c) => `^${c}`)]];

  return ["xdg-open", [url]];
}

export const osOpen: UrlOpener = (url) => {
  const [command, args] = osOpenCommand(url);

  try {
    const child = spawn(command, args, { detached: true, stdio: "ignore", windowsVerbatimArguments: process.platform === "win32" });
    child.on("error", () => undefined);
    child.unref();

    return true;
  } catch {
    return false;
  }
};

let opener: UrlOpener = osOpen;

export function setApprovalOpener(next: UrlOpener): () => void {
  const previous = opener;
  opener = next;

  return () => {
    opener = previous;
  };
}

export function openUrl(url: string): boolean {
  return opener(url);
}

const opened = new Set<string>();

let recent: Array<{ approvalId: string; origin: string; at: number }> = [];

export function forgetOpenedApprovals(): void {
  opened.clear();
  recent = [];
}

const APPROVAL_PAGE = /^\/device\/approve\/(apr_[A-Za-z0-9_-]{32})$/;

export function approvalBatchUrl(approvalUrl: string, now: number = Date.now()): { url: string; count: number } {
  let parsed: URL;

  try {
    parsed = new URL(approvalUrl);
  } catch {
    return { url: approvalUrl, count: 1 };
  }

  const approvalId = APPROVAL_PAGE.exec(parsed.pathname)?.[1];
  if (!approvalId) return { url: approvalUrl, count: 1 };

  recent = [...recent.filter((entry) => now - entry.at < APPROVAL_BATCH_WINDOW_MS && entry.approvalId !== approvalId), { approvalId, origin: parsed.origin, at: now }];
  const ids = recent.filter((entry) => entry.origin === parsed.origin).slice(-APPROVAL_BATCH_MAX).map((entry) => entry.approvalId);
  if (ids.length < 2) return { url: approvalUrl, count: 1 };

  return { url: `${parsed.origin}/device/approve?ids=${ids.join(",")}`, count: ids.length };
}

export function autoOpenBlock(options: { noShip: boolean }, env: Env = process.env, platform: NodeJS.Platform = process.platform): string {
  if (options.noShip) return "this server runs with --no-ship";
  if (truthy(env[NO_AUTO_OPEN_ENV])) return `${NO_AUTO_OPEN_ENV} is set in this server's environment`;
  if (truthy(env.CI)) return "CI is set in this server's environment";
  if (text(env.SSH_CONNECTION) || text(env.SSH_TTY) || text(env.SSH_CLIENT)) return "this server runs in an SSH session, away from the person's screen";
  if (/^(1|true)$/i.test(env.EXTENSION_HEADLESS ?? "")) return "EXTENSION_HEADLESS=1 is set in this server's environment";
  if (envIsHeadless(env)) return "EXTENSION_BROWSER_FLAGS asks for a headless browser in this server's environment";
  if (platform === "linux" && !text(env.DISPLAY) && !text(env.WAYLAND_DISPLAY)) return "this server sees neither DISPLAY nor WAYLAND_DISPLAY on Linux";

  return "";
}

export function canAutoOpen(options: { noShip: boolean }, env: Env = process.env, platform: NodeJS.Platform = process.platform): boolean {
  return autoOpenBlock(options, env, platform) === "";
}

export type { PageOpening } from "./kernel-hooks";

export const notOpenedNote = (why: string): string => `No page was opened: ${why}. Hand the person the urls in this answer instead of calling again for a window.`;

export function openPagesForPerson(urls: string[], env: Env = process.env, platform: NodeJS.Platform = process.platform): PageOpening {
  const block = autoOpenBlock({ noShip: false }, env, platform);
  if (block) return { opened: false, note: notOpenedNote(block) };

  const wanted = urls.filter(Boolean);
  if (wanted.length && wanted.map((url) => opener(url)).every(Boolean)) return { opened: true, note: "" };

  return { opened: false, note: notOpenedNote(`the ${osOpenCommand("", platform)[0]} command did not start`) };
}

export function openApprovalOnce(result: string, options: { noShip: boolean }, env: Env = process.env, platform: NodeJS.Platform = process.platform): string {
  let parsed: unknown;

  try {
    parsed = JSON.parse(result);
  } catch {
    return result;
  }

  if (!isEnvelope(parsed) || parsed.status !== APPROVAL_REQUIRED_STATUS) return result;

  const value = isRow(parsed.value) ? parsed.value : {};
  const approvalUrl = text(value.approvalUrl);
  if (!/^https?:\/\//i.test(approvalUrl)) return result;

  const key = text(value.approvalId) || approvalUrl;
  if (opened.has(key) || !canAutoOpen(options, env, platform)) return result;

  opened.add(key);
  const batch = approvalBatchUrl(approvalUrl);
  if (!opener(batch.url)) return result;

  const hint = text(parsed.hint);
  const said = batch.count > 1 ? approvalBatchSentence(batch.count) : /click approve, then tell me/i.test(hint) ? APPROVAL_OPENED_SHORT : APPROVAL_OPENED_SENTENCE;

  return envelope({
    ok: parsed.ok,
    command: parsed.command,
    status: parsed.status,
    value: { ...value, approvalOpened: true, ...(batch.count > 1 ? { approvalBatchUrl: batch.url } : {}) },
    error: parsed.error,
    warnings: parsed.warnings,
    ...(parsed.truncated !== undefined ? { truncated: parsed.truncated } : {}),
    hint: [said, hint].filter(Boolean).join(" "),
  });
}
