// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import fs from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

import { CDPClient } from "./cdp";
import { readyContractPath } from "./session-paths";

export const RECENT_RELOAD_MS = 15_000;
export const RELOAD_RETURN_WAIT_MS = 8_000;

const POLL_MS = 250;
const EXTENSION_URL = /^chrome-extension:\/\/([a-p]{32})\//i;

export interface ReloadEvidence {
  kind: "detached" | "reloaded" | "reattached" | "compiled";
  at: string;
  sentence: string;
}

export interface SessionRef {
  projectPath: string;
  browser: string;
}

function readContract(projectPath: string, browser: string): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(readyContractPath(projectPath, browser), "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function stampMs(value: unknown): number | null {
  if (typeof value !== "string" || !value) return null;

  const ms = Date.parse(value);

  return Number.isFinite(ms) ? ms : null;
}

export function extensionIdOf(url: string): string | null {
  const match = EXTENSION_URL.exec(String(url ?? ""));

  return match ? match[1]!.toLowerCase() : null;
}

export function readReloadEvidence(projectPath: string, browser: string, now = Date.now()): ReloadEvidence | null {
  const contract = readContract(projectPath, browser);
  if (!contract) return null;

  const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

  const recent = (v: unknown): string | null => {
    const ms = stampMs(v);

    return ms !== null && now - ms <= RECENT_RELOAD_MS && ms - now <= 1_000 ? (v as string) : null;
  };

  if (contract.runtime === "detached") {
    const at = str(contract.executorDetachedAt) ?? "an unstated time";

    return { kind: "detached", at, sentence: `its background detached at ${at} and has not connected again` };
  }

  const reloadedAt = recent(contract.reloadedAt);

  if (reloadedAt) {
    const kind = str(contract.reloadKind) ?? "full";

    return { kind: "reloaded", at: reloadedAt, sentence: `the engine applied a ${kind} reload at ${reloadedAt}` };
  }

  const attachedAt = recent(contract.executorAttachedAt);

  if (attachedAt) {
    return { kind: "reattached", at: attachedAt, sentence: `its background connected again at ${attachedAt}` };
  }

  const compiledAt = recent(contract.compiledAt);

  if (compiledAt) {
    return { kind: "compiled", at: compiledAt, sentence: `a compile landed at ${compiledAt}, and the reload that follows one closes the extension's pages` };
  }

  return null;
}

export async function extensionTargetsListed(port: number, extensionId: string): Promise<boolean | null> {
  try {
    const targets = await CDPClient.discoverTargets(port);

    return targets.some((t) => extensionIdOf(String(t.url ?? "")) === extensionId);
  } catch {
    return null;
  }
}

export interface ReloadReturn {
  outcome: "back" | "absent" | "unreadable";
  waitedMs: number;
}

export async function waitForExtensionBack(
  port: number,
  extensionId: string,
  session: SessionRef,
  budgetMs: number,
): Promise<ReloadReturn> {
  const started = Date.now();
  const firstTs = readContract(session.projectPath, session.browser)?.ts;
  let listed: boolean | null = null;

  for (;;) {
    listed = await extensionTargetsListed(port, extensionId);
    const waitedMs = Date.now() - started;

    if (listed === true) return { outcome: "back", waitedMs };

    const contract = readContract(session.projectPath, session.browser);
    if (contract?.runtime === "attached" && contract.ts !== firstTs) return { outcome: "back", waitedMs };

    if (waitedMs >= budgetMs) return { outcome: listed === null ? "unreadable" : "absent", waitedMs };

    await sleep(Math.min(POLL_MS, Math.max(1, budgetMs - waitedMs)));
  }
}

const openedExtensionTargets = new Map<string, string>();

export function rememberExtensionTarget(targetId: unknown, url: unknown): void {
  if (typeof targetId !== "string" || !targetId || typeof url !== "string") return;
  if (extensionIdOf(url)) openedExtensionTargets.set(targetId, url);
}

export function rememberedExtensionTargetUrl(targetId: string): string | null {
  return openedExtensionTargets.get(targetId) ?? null;
}
