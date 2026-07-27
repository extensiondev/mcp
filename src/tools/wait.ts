// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { PROJECT_PATH, SESSION_BROWSER } from "../lib/common-schema";
import fs from "node:fs";
import path from "node:path";
import type { ReadyContract } from "../lib/types";
import { findSessionInfo, sessionSinceMs } from "../lib/process-manager";
import { resolveSessionBrowser } from "../lib/session-browser";
import {
  envelope,
  sessionCommandSinceEnvelopeOwnsCommand,
} from "../lib/envelope";
import { verifyGuestLoaded } from "../lib/guest-load-oracle";
import { recentErrorLogs } from "./doctor";

const SAFE_CEILING_MS = 50_000;
const DEFAULT_TIMEOUT_MS = 45_000;
const MIN_TIMEOUT_MS = 1_000;

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export const schema = {
  name: "extension_wait",
  description:
    "Wait for a running dev or start session to be ready. This polls the ready.json contract and reports compiled (the compiler finished), browserAttached (the runtime executor connected), and guestLoaded (the browser's own target list shows your extension). Read guestLoaded as the trustworthy load signal: it catches a silently rejected --load-extension that leaves ready.json stamped attached with empty logs. It is null when it could not be checked, for example a gecko session with no CDP port. Every result reports budgetMs and elapsedMs; on status 'timeout', call again to keep waiting on the same contract. In a noBrowser session this returns as soon as the compile lands, instead of waiting for a browser that will never attach. Ports come from the contract, so they match what the server actually bound.",
  inputSchema: {
    type: "object" as const,
    properties: {
      projectPath: PROJECT_PATH,
      browser: SESSION_BROWSER,
      timeoutMs: {
        type: "number",
        default: DEFAULT_TIMEOUT_MS,
        description:
          `Wait budget for this call. Default ${DEFAULT_TIMEOUT_MS}, clamped to ${MIN_TIMEOUT_MS}-${SAFE_CEILING_MS} so one call stays under the client's 60s request timeout. On timeout, call again to keep waiting.`,
      },
      timeout: {
        type: "number",
        description:
          "Deprecated alias of timeoutMs, which wins when both are given.",
      },
    },
    required: ["projectPath"],
  },
};

export async function handler(args: {
  projectPath: string;
  browser?: string;
  timeoutMs?: number;
  timeout?: number;
}): Promise<string> {
  const { browser } = resolveSessionBrowser(
    args.projectPath,
    args.browser,
    "chrome",
  );
  const requested = args.timeoutMs ?? args.timeout ?? DEFAULT_TIMEOUT_MS;
  const budgetMs = Math.min(
    Math.max(requested, MIN_TIMEOUT_MS),
    SAFE_CEILING_MS,
  );
  const clamped = requested > SAFE_CEILING_MS;
  const readyPath = path.resolve(
    args.projectPath,
    "dist",
    "extension-js",
    browser,
    "ready.json",
  );

  const buildOnly = findSessionInfo(args.projectPath, browser)?.noBrowser === true;
  const since = sessionSinceMs(args.projectPath, browser);

  const start = Date.now();
  const pollInterval = 1000;
  let sawCompiledButUnattached = false;
  let lastContractStatus: string | null = null;
  let staleContractNote: string | null = null;

  while (Date.now() - start < budgetMs) {
    try {
      const stat = fs.statSync(readyPath);
      const raw = fs.readFileSync(readyPath, "utf8");
      const contract: ReadyContract = JSON.parse(raw);
      const stampedBeforeSession = since !== null && stat.mtimeMs < since;
      const deadOrphanStamp =
        since === null &&
        contract.status !== "ready" &&
        typeof contract.pid === "number" &&
        !isAlive(contract.pid);
      if (stampedBeforeSession || deadOrphanStamp) {
        staleContractNote = stampedBeforeSession
          ? `A ready.json contract stamped before this session started (status: ${contract.status}) was ignored; it describes the previous run, not this one.`
          : `A ready.json contract whose dev-server pid ${contract.pid} is dead (status: ${contract.status}) was ignored; it describes a session that already exited.`;
        await new Promise((resolve) => setTimeout(resolve, pollInterval));
        continue;
      }
      lastContractStatus = contract.status;

      if (contract.status === "ready") {
        if (typeof contract.pid === "number" && !isAlive(contract.pid)) {
          return envelope({
            ok: false,
            command: schema.name,
            status: "stale",
            error: {
              code: "E_STALE_CONTRACT",
              message: `ready.json reports ready but its dev-server pid ${contract.pid} is dead, the session exited. Restart with extension_dev; extension_doctor will confirm.`,
            },
            value: {
              browser: contract.browser,
              pid: contract.pid,
              budgetMs,
              elapsedMs: Date.now() - start,
            },
          });
        }
        const attached =
          contract.runtime === "attached" ||
          typeof contract.executorAttachedAt === "string";
        if (!attached && buildOnly) {
          return envelope({
            ok: true,
            command: schema.name,
            status: "ready",
            value: {
              buildOnly: true,
              compiled: true,
              browserAttached: false,
              ...sessionCommandSinceEnvelopeOwnsCommand(contract),
              browser: contract.browser,
              port: contract.port,
              pid: contract.pid,
              distPath: contract.distPath,
              manifestPath: contract.manifestPath,
              compiledAt: contract.compiledAt,
              startedAt: contract.startedAt,
              budgetMs,
              elapsedMs: Date.now() - start,
            },
            hint: "Build-only session (noBrowser): the extension compiled and the dev server is live, but no browser was launched, so browserAttached will never become true. Do not call extension_wait again to wait for a browser. The control verbs (storage/reload/open/dom_snapshot/eval) need a live browser and will not work against this session.",
          });
        }
        if (!attached) {
          await new Promise((r) => setTimeout(r, pollInterval));
          sawCompiledButUnattached = true;
          continue;
        }
        const runtimeErrors = recentErrorLogs(args.projectPath, browser, 3);
        const guestCheck = await verifyGuestLoaded(args.projectPath, browser);
        const warnings: string[] = [];
        if (runtimeErrors.length) {
          warnings.push(
            `Compiled and attached, but the extension is throwing at runtime (${runtimeErrors.length} recent error event${runtimeErrors.length === 1 ? "" : "s"} above). Check extension_logs (level: error) or extension_doctor before trusting this session.`,
          );
        }
        if (guestCheck.checked && !guestCheck.loaded) {
          warnings.push(
            "The engine reports the runtime attached, but the browser's own target list shows no chrome-extension:// target for your extension, only the engine companion. This is the signature of a silently rejected --load-extension (extension.js BUGS_TO_FIX §83): the CLI and ready.json cannot see it, and the control verbs will fail against a guest that is not there. Check the manifest and extension_logs.",
          );
        }
        return envelope({
          ok: true,
          command: schema.name,
          status: "ready",
          value: {
            compiled: true,
            browserAttached: true,
            guestLoaded: guestCheck.checked ? guestCheck.loaded : null,
            ...(guestCheck.checked
              ? { guestIds: guestCheck.guestIds }
              : { guestLoadNote: guestCheck.reason }),
            ...sessionCommandSinceEnvelopeOwnsCommand(contract),
            browser: contract.browser,
            port: contract.port,
            pid: contract.pid,
            distPath: contract.distPath,
            manifestPath: contract.manifestPath,
            compiledAt: contract.compiledAt,
            startedAt: contract.startedAt,
            budgetMs,
            elapsedMs: Date.now() - start,
            ...(runtimeErrors.length ? { runtimeErrors } : {}),
          },
          warnings,
        });
      }

      if (contract.status === "error") {
        return envelope({
          ok: false,
          command: schema.name,
          status: "contract-error",
          error: {
            code: contract.code
              ? `E_${String(contract.code).toUpperCase()}`
              : "E_CONTRACT_ERROR",
            message:
              contract.message ??
              "The dev server stamped its ready contract with an error.",
            contractCode: contract.code,
          },
          value: {
            errors: contract.errors,
            browser: contract.browser,
            budgetMs,
            elapsedMs: Date.now() - start,
          },
        });
      }
    } catch {
    }

    await new Promise((resolve) => setTimeout(resolve, pollInterval));
  }

  if (sawCompiledButUnattached) {
    return envelope({
      ok: false,
      command: schema.name,
      status: "compiled-not-attached",
      error: {
        code: "E_NOT_ATTACHED",
        message: `The extension compiled, but the runtime executor never attached within this call's ${budgetMs}ms budget. The build is fine; the browser side is not connected, so extension_eval/storage/reload/open will fail with "no executor connected".`,
      },
      value: {
        compiled: true,
        browserAttached: false,
        readyPath,
        budgetMs,
        elapsedMs: Date.now() - start,
      },
      hint: "This is usually transient: call extension_wait again. If it persists, stop and restart the session with extension_dev (a restart reliably reattaches); extension_doctor reports the executor leg.",
    });
  }

  return envelope({
    ok: false,
    command: schema.name,
    status: "timeout",
    error: {
      code: "E_WAIT_TIMEOUT",
      message:
        lastContractStatus === "starting"
          ? `Not ready after ${budgetMs}ms this call: the dev server stamped its contract (status: starting) but the first compile has not landed yet.`
          : `Not ready after ${budgetMs}ms this call: no ready contract was observed at ${readyPath}, so neither the compile nor a browser attach has been seen.`,
    },
    value: {
      compiled: false,
      browserAttached: false,
      readyPath,
      budgetMs,
      elapsedMs: Date.now() - start,
    },
    warnings: [
      clamped
        ? `requested ${requested}ms was clamped to ${SAFE_CEILING_MS}ms to stay under the MCP client request timeout`
        : null,
      staleContractNote,
    ],
    hint: "Still building, call extension_wait again to keep waiting (it resumes polling the same contract). If it never readies, check the dev process with extension_doctor.",
  });
}
