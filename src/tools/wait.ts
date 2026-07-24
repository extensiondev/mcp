// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import fs from "node:fs";
import path from "node:path";
import type { ReadyContract } from "../lib/types";
import { findSessionInfo } from "../lib/process-manager";
import { resolveSessionBrowser } from "../lib/session-browser";
import { verifyGuestLoaded } from "../lib/guest-load-oracle";
import { recentErrorLogs } from "./doctor";

// A single call is bounded below the MCP client's default request timeout
// (DEFAULT_REQUEST_TIMEOUT_MSEC = 60_000 in the SDK), with margin for the
// request round-trip. Waiting longer than the client timeout would surface as
// an opaque transport error ("-32001 Request timed out") that also loses the
// session handle, instead of the graceful status below. A caller that needs to
// wait longer simply calls extension_wait again, it resumes polling the same
// on-disk contract, so the loop is idempotent and client-agnostic. (Progress
// notifications can't fix this: the SDK only resets the client timeout when the
// CLIENT sets resetTimeoutOnProgress, which the server cannot control.)
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
    "Wait for a running dev or start session to be ready. Polls the ready.json contract file and returns structured status with these facts: compiled (the compiler finished), browserAttached (the engine's runtime executor connected), and for a browser session guestLoaded (the browser's OWN target list actually shows your extension). guestLoaded is the trustworthy load signal: it catches a silently rejected --load-extension that leaves ready.json stamped attached with empty logs (extension.js BUGS_TO_FIX §83); it is null when it could not be checked (no CDP port, e.g. a gecko session). Every result reports budgetMs (this call's wait budget) and elapsedMs; on status:'timeout' call again to keep waiting (polling resumes on the same contract). In a noBrowser (build-only) session it returns as soon as the compile lands instead of waiting for a browser that will never attach. Ports in the result come from the ready contract, so they always match what the dev server actually bound.",
  inputSchema: {
    type: "object" as const,
    properties: {
      projectPath: {
        type: "string",
        description: "Path to the extension project root",
      },
      browser: {
        type: "string",
        description:
          "Browser to check readiness for. Defaults to the active dev session's browser for this project.",
      },
      timeoutMs: {
        type: "number",
        default: DEFAULT_TIMEOUT_MS,
        description:
          `Wait budget in milliseconds for this call. Default ${DEFAULT_TIMEOUT_MS}; clamped to ${MIN_TIMEOUT_MS}-${SAFE_CEILING_MS} (the ceiling keeps one call under the MCP client's 60s request timeout). On timeout the result reports elapsedMs plus what was observed (compiled, browserAttached); call again to keep waiting, polling resumes on the same contract.`,
      },
      timeout: {
        type: "number",
        description:
          "Deprecated alias of timeoutMs, kept for callers that already pass it. timeoutMs wins when both are given.",
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

  // A build-only session (dev with noBrowser: true) never launches a browser,
  // so no executor will ever attach: waiting for one just burns the whole
  // budget. The engine's contract does not record the flag, but the session
  // registry (and its on-disk marker) does.
  const buildOnly = findSessionInfo(args.projectPath, browser)?.noBrowser === true;

  const start = Date.now();
  const pollInterval = 1000;
  // Tracks the half-ready state: compiled, but the runtime executor never
  // attached. Distinguishing it from "still building" is the whole point.
  let sawCompiledButUnattached = false;
  // The last contract status observed, so a timeout can narrate what WAS seen
  // ("the server stamped starting but never compiled") instead of an opaque
  // "not ready".
  let lastContractStatus: string | null = null;

  while (Date.now() - start < budgetMs) {
    try {
      const raw = fs.readFileSync(readyPath, "utf8");
      const contract: ReadyContract = JSON.parse(raw);
      lastContractStatus = contract.status;

      if (contract.status === "ready") {
        // A ready.json can outlive its dev server (crash/kill). Returning
        // status:ready then would send the caller into reload/eval that fail
        // with a misleading control-channel error; report the dead session.
        if (typeof contract.pid === "number" && !isAlive(contract.pid)) {
          return JSON.stringify({
            status: "stale",
            message: `ready.json reports ready but its dev-server pid ${contract.pid} is dead, the session exited. Restart with extension_dev; extension_doctor will confirm.`,
            browser: contract.browser,
            pid: contract.pid,
            budgetMs,
            elapsedMs: Date.now() - start,
          });
        }
        // "ready" means COMPILED, which is not the same as usable: the runtime
        // executor attaches separately. Persona B7 got status:"ready" after 4ms
        // with only the compile done, then every control verb failed with "no
        // executor connected" until a full restart. Keep waiting for the
        // attachment rather than declaring victory at compile time.
        const attached =
          contract.runtime === "attached" ||
          typeof contract.executorAttachedAt === "string";
        if (!attached && buildOnly) {
          // No browser was launched, so the attach this loop would wait for
          // cannot happen. Say what IS ready and return immediately.
          return JSON.stringify({
            status: "ready",
            buildOnly: true,
            compiled: true,
            browserAttached: false,
            message:
              "Build-only session (noBrowser): the extension compiled and the dev server is live, but no browser was launched, so browserAttached will never become true. Do not call extension_wait again to wait for a browser. The control verbs (storage/reload/open/dom_inspect/eval) need a live browser and will not work against this session.",
            command: contract.command,
            browser: contract.browser,
            port: contract.port,
            pid: contract.pid,
            distPath: contract.distPath,
            manifestPath: contract.manifestPath,
            compiledAt: contract.compiledAt,
            startedAt: contract.startedAt,
            budgetMs,
            elapsedMs: Date.now() - start,
          });
        }
        if (!attached) {
          // Not an error yet: the executor usually attaches a beat later. Only
          // report the half-ready state if we run out of budget below.
          await new Promise((r) => setTimeout(r, pollInterval));
          sawCompiledButUnattached = true;
          continue;
        }
        // E21 in the API-surface swarm: wait returned a bare status:"ready"
        // while the service worker had crashed at top level on load, and only
        // doctor told the truth. "ready" still means compiled+attached, but a
        // ready that hides a crashing runtime is the false-green class this
        // file exists to prevent, so recent error events ride along.
        const runtimeErrors = recentErrorLogs(args.projectPath, browser, 3);
        // browserAttached means the engine's executor connected, which §83 shows
        // is not the same as the guest having loaded: Chrome silently refusing
        // --load-extension leaves ready.json stamped attached with empty logs.
        // Ask the browser's own target list for the real answer.
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
        return JSON.stringify({
          status: "ready",
          compiled: true,
          browserAttached: true,
          // The verified fact: null when it could not be checked (no CDP port,
          // e.g. a gecko session or a browser still binding its debug port).
          guestLoaded: guestCheck.checked ? guestCheck.loaded : null,
          ...(guestCheck.checked
            ? { guestIds: guestCheck.guestIds }
            : { guestLoadNote: guestCheck.reason }),
          command: contract.command,
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
          ...(warnings.length ? { warning: warnings.join(" ") } : {}),
        });
      }

      if (contract.status === "error") {
        return JSON.stringify({
          status: "error",
          message: contract.message,
          errors: contract.errors,
          code: contract.code,
          browser: contract.browser,
          budgetMs,
          elapsedMs: Date.now() - start,
        });
      }
    } catch {
    }

    await new Promise((resolve) => setTimeout(resolve, pollInterval));
  }

  if (sawCompiledButUnattached) {
    return JSON.stringify({
      status: "compiled-not-attached",
      compiled: true,
      browserAttached: false,
      message: `The extension compiled, but the runtime executor never attached within this call's ${budgetMs}ms budget. The build is fine; the browser side is not connected, so extension_eval/storage/reload/open will fail with "no executor connected".`,
      readyPath,
      budgetMs,
      elapsedMs: Date.now() - start,
      hint: "This is usually transient: call extension_wait again. If it persists, stop and restart the session with extension_dev (a restart reliably reattaches); extension_doctor reports the executor leg.",
    });
  }

  return JSON.stringify({
    status: "timeout",
    compiled: false,
    browserAttached: false,
    message:
      lastContractStatus === "starting"
        ? `Not ready after ${budgetMs}ms this call: the dev server stamped its contract (status: starting) but the first compile has not landed yet.`
        : `Not ready after ${budgetMs}ms this call: no ready contract was observed at ${readyPath}, so neither the compile nor a browser attach has been seen.`,
    readyPath,
    budgetMs,
    elapsedMs: Date.now() - start,
    clamped: clamped
      ? `requested ${requested}ms was clamped to ${SAFE_CEILING_MS}ms to stay under the MCP client request timeout`
      : undefined,
    hint: "Still building, call extension_wait again to keep waiting (it resumes polling the same contract). If it never readies, check the dev process with extension_doctor.",
  });
}
