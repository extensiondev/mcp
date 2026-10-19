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
import { isRow, text } from "./ship-act";

type Env = NodeJS.ProcessEnv | Record<string, string | undefined>;

export const NO_AUTO_OPEN_ENV = "EXTENSION_DEV_NO_AUTO_OPEN";

export const APPROVAL_OPENED_SENTENCE = "The approval page is open in your browser; click Approve, then tell me.";

export const APPROVAL_OPENED_SHORT = "The approval page is open in your browser.";

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

const opened = new Set<string>();

export function forgetOpenedApprovals(): void {
  opened.clear();
}

export function canAutoOpen(options: { noShip: boolean }, env: Env = process.env, platform: NodeJS.Platform = process.platform): boolean {
  if (options.noShip) return false;
  if (truthy(env[NO_AUTO_OPEN_ENV])) return false;
  if (truthy(env.CI)) return false;
  if (envIsHeadless(env)) return false;
  if (platform === "linux" && !text(env.DISPLAY) && !text(env.WAYLAND_DISPLAY)) return false;

  return true;
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
  if (!opener(approvalUrl)) return result;

  const hint = text(parsed.hint);

  return envelope({
    ok: parsed.ok,
    command: parsed.command,
    status: parsed.status,
    value: { ...value, approvalOpened: true },
    error: parsed.error,
    warnings: parsed.warnings,
    ...(parsed.truncated !== undefined ? { truncated: parsed.truncated } : {}),
    hint: [/click approve, then tell me/i.test(hint) ? APPROVAL_OPENED_SHORT : APPROVAL_OPENED_SENTENCE, hint].filter(Boolean).join(" "),
  });
}
