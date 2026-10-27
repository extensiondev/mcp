// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import fs from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

import { isChromiumFamily } from "./browser-family";
import {
  BACKGROUND_TARGET_TYPES,
  evaluateOnExtensionPage,
  findExtensionWorkerTargets,
  wakeExtensionWorker,
} from "./cdp-extension-page";
import { sessionGuestIdentity } from "./extension-identity";
import { verifyGuestLoaded } from "./guest-load-oracle";
import { pidState } from "./process-identity";
import { readyContractPath } from "./session-paths";

import type { ReadyContract } from "./types";

export const RECOVER_AFTER_MS = 15_000;
export const RECOVERY_WATCH_MS = 8_000;

const POLL_MS = 250;
const RELOAD_EXPRESSION = "setTimeout(() => chrome.runtime.reload(), 50), true";

export type ExecutorRecovery =
  | { outcome: "attached"; reloadedAt: string; attachedAt: string; waitedMs: number; say: string }
  | { outcome: "not-attached"; reloadedAt: string; waitedMs: number; say: string }
  | { outcome: "unreachable"; reason: string; say: string };

const triedSessions = new Set<string>();

function readContract(projectPath: string, browser: string): ReadyContract | null {
  try {
    return JSON.parse(fs.readFileSync(readyContractPath(projectPath, browser), "utf8")) as ReadyContract;
  } catch {
    return null;
  }
}

export function executorAttached(contract: ReadyContract | null): boolean {
  return contract?.runtime === "attached" || typeof contract?.executorAttachedAt === "string";
}

function attachedSince(contract: ReadyContract | null, sinceMs: number): string | null {
  if (contract?.runtime === "detached") return null;

  const at = typeof contract?.executorAttachedAt === "string" ? contract.executorAttachedAt : null;
  const atMs = at ? Date.parse(at) : Number.NaN;

  if (at && Number.isFinite(atMs) && atMs >= sinceMs - 1_000) return at;
  if (contract?.runtime === "attached" && typeof contract.ts === "string") return contract.ts;

  return null;
}

async function backgroundTarget(port: number, ids: string[]): Promise<{ targetId: string } | { reason: string }> {
  for (const id of ids) {
    const listed = (await findExtensionWorkerTargets(port, id)).find((t) => BACKGROUND_TARGET_TYPES.has(t.type));
    if (listed) return listed;
  }

  let lastReason = "the extension's id is not known from the session contract";

  for (const id of ids) {
    const wake = await wakeExtensionWorker(port, id);

    if (wake.woken) {
      const woken = wake.targets.find((t) => BACKGROUND_TARGET_TYPES.has(t.type));
      if (woken) return woken;
    } else {
      lastReason = wake.reason;
    }
  }

  return { reason: `no background of the extension is listed on the debug port and waking it failed: ${lastReason}` };
}

export async function reloadUnattachedWorker(input: {
  projectPath: string;
  browser: string;
  contract: ReadyContract;
  watchMs?: number;
}): Promise<ExecutorRecovery> {
  const port = typeof input.contract.cdpPort === "number" ? input.contract.cdpPort : null;

  if (port === null) {
    const reason = "the session's ready contract names no debug port";

    return { outcome: "unreachable", reason, say: `This server could not reload the extension over the debug port: ${reason}.` };
  }

  const target = await backgroundTarget(port, sessionGuestIdentity(input.projectPath, input.browser).expectedIds);

  if ("reason" in target) {
    return { outcome: "unreachable", reason: target.reason, say: `This server could not reload the extension over the debug port: ${target.reason}.` };
  }

  const startedMs = Date.now();
  const reloadedAt = new Date(startedMs).toISOString();
  const ran = await evaluateOnExtensionPage(port, target.targetId, RELOAD_EXPRESSION, 3_000);

  if (!ran.ok) {
    return { outcome: "unreachable", reason: ran.message, say: `This server could not reload the extension over the debug port: ${ran.message}.` };
  }

  const watchMs = input.watchMs ?? RECOVERY_WATCH_MS;

  for (;;) {
    const waitedMs = Date.now() - startedMs;
    const attachedAt = attachedSince(readContract(input.projectPath, input.browser), startedMs);

    if (attachedAt) {
      return {
        outcome: "attached",
        reloadedAt,
        attachedAt,
        waitedMs,
        say: `The extension's background had not connected to the dev server, so this server reloaded the extension over the debug port at ${reloadedAt} (chrome.runtime.reload in its background), and the new background connected at ${attachedAt}. Pages opened before that still run the content script they loaded until they reload.`,
      };
    }

    if (waitedMs >= watchMs) {
      return {
        outcome: "not-attached",
        reloadedAt,
        waitedMs,
        say: `This server reloaded the extension over the debug port at ${reloadedAt} (chrome.runtime.reload in its background), and its background still had not connected to the dev server ${waitedMs} ms later.`,
      };
    }

    await sleep(POLL_MS);
  }
}

export async function recoverUnattachedOnce(input: {
  projectPath: string;
  browser: string;
  contract: ReadyContract;
  unattachedForMs: number;
  remainingMs: number;
}): Promise<ExecutorRecovery | null> {
  if (!isChromiumFamily(input.browser)) return null;
  if (input.unattachedForMs < RECOVER_AFTER_MS || input.remainingMs < RECOVERY_WATCH_MS) return null;

  const key = `${input.projectPath}\u0000${input.browser}\u0000${input.contract.runId ?? input.contract.startedAt ?? input.contract.pid ?? ""}`;
  if (triedSessions.has(key)) return null;

  const browserPid = typeof input.contract.browserPid === "number" ? input.contract.browserPid : null;
  if (browserPid !== null && pidState(browserPid) === "dead") return null;

  const guest = await verifyGuestLoaded(input.projectPath, input.browser, { timeoutMs: 2_000 });
  if (!guest.checked || !guest.loaded) return null;

  triedSessions.add(key);

  return reloadUnattachedWorker({ projectPath: input.projectPath, browser: input.browser, contract: input.contract });
}

export class UnattachedWatch {
  recovery: ExecutorRecovery | null = null;
  private since: number | null = null;

  constructor(
    private readonly projectPath: string,
    private readonly browser: string,
  ) {}

  async reattachedNow(contract: ReadyContract, remainingMs: number): Promise<boolean> {
    this.since ??= Date.now();
    this.recovery ??= await recoverUnattachedOnce({
      projectPath: this.projectPath,
      browser: this.browser,
      contract,
      unattachedForMs: Date.now() - this.since,
      remainingMs,
    });

    return this.recovery?.outcome === "attached";
  }
}
