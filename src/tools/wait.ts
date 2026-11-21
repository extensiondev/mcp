// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import fs from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

import { PROJECT_PATH, SESSION_BROWSER } from "../lib/common-schema";
import { findSessionInfo, sessionSinceMs } from "../lib/process-manager";
import { ambiguousSessionRefusal, resolveSessionBrowser } from "../lib/session-browser";
import { contractPidState } from "../lib/contract-pids";
import { readyContractPath } from "../lib/session-paths";
import { productionLaunchEvidence, readLoadOverDebugPort } from "../lib/production-launch";
import { productionWaitHint } from "../lib/production-wait-words";
import { sessionPorts } from "../lib/session-ports";
import { envelope, sessionCommandSinceEnvelopeOwnsCommand } from "../lib/envelope";
import { verifyGuestLoaded } from "../lib/guest-load-oracle";
import { detachedVerdictFrame, readDetachedVerdict } from "../lib/background-liveness";
import { WAIT_MODE_PROPERTIES, contractErrorList, waitModeFrame } from "../lib/wait-modes";
import {
  browserUpNotAttached,
  browserUpNotAttachedAnswer,
  compiledNotAttachedAnswer,
} from "../lib/compiled-not-attached";
import { safariSigningFrame } from "../lib/safari-signing";
import { WEBKIT_FAMILY } from "../lib/browser-family";
import { UnattachedWatch } from "../lib/executor-recovery";
import {
  CONTRACT_MTIME_GRANULARITY_SLACK_MS,
  FIRST_RUN_NOTE,
  SOURCE_NOT_LOADABLE_NOTE,
  startingSentence,
  startingSession,
} from "../lib/session-starting";
import { recentErrorLogs } from "./doctor";

import type { ReadyContract } from "../lib/types";

/* @invariant WAITING ON A SESSION THAT IS STILL STARTING IS NOT AN ERROR.
 * The budget of one call stays under the request timeout most MCP clients
 * apply (60 s), and a first run installs dependencies for longer than that,
 * so a wait that runs out on a live session that has not compiled yet is
 * the expected answer, not a failure. Until 2026-11-18 (ledger 942) it was
 * `ok: false` with E_SESSION_STARTING, which a client shows as a failed
 * tool call: in 10 agent runs it came back 22 times, four agents gave up on
 * the session and drove a browser by hand, and one loaded the unbuilt
 * source folder. The answer is `ok: true` with status "starting", the shape
 * extension_dev already gives the same state, with what the session is
 * waiting on, `retry: "safe"` in value and the next call in hint. A session
 * that is gone, a compile error and a wait with no session keep their
 * refusals, and the other session tools still answer E_SESSION_STARTING,
 * since nothing they were asked for ran.
 */
const SAFE_CEILING_MS = 50_000;
const DEFAULT_TIMEOUT_MS = 45_000;
const MIN_TIMEOUT_MS = 1_000;

export const schema = {
  name: "extension_wait",
  description:
    "Wait for a session to be ready, or for: \"rebuild\" after an edit; only after wait:false, a ready.status not \"ready\", or noBrowser; answers port, controlPort and cdpPort or rdpPort. A page condition is extension_eval until; never sleep in a shell.",
  inputSchema: {
    type: "object" as const,
    properties: {
      projectPath: PROJECT_PATH,
      browser: SESSION_BROWSER,
      timeoutMs: {
        type: "number",
        default: DEFAULT_TIMEOUT_MS,
        description:
          `Wait budget in ms, clamped ${MIN_TIMEOUT_MS}-${SAFE_CEILING_MS}.`,
      },
      timeout: {
        type: "number",
        description:
          "Deprecated alias of timeoutMs.",
      },
      ...WAIT_MODE_PROPERTIES,
    },
    required: ["projectPath"],
  },
};

export async function handler(args: {
  projectPath: string;
  browser?: string;
  timeoutMs?: number;
  timeout?: number;
  for?: string;
  since?: string;
  until?: unknown;
}): Promise<string> {
  const ambiguous = ambiguousSessionRefusal(schema.name, args.projectPath, args.browser);
  if (ambiguous) return ambiguous;

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
  const readyPath = readyContractPath(args.projectPath, browser);

  const mode = await waitModeFrame(schema.name, args, browser, budgetMs);
  if (mode !== null) return mode;

  const buildOnly = findSessionInfo(args.projectPath, browser)?.noBrowser === true;
  const since = sessionSinceMs(args.projectPath, browser);

  const start = Date.now();
  const pollInterval = 1000;
  let sawCompiledButUnattached = false;
  let unattachedContract: ReadyContract | null = null;
  const unattached = new UnattachedWatch(args.projectPath, browser);
  let lastContractStatus: string | null = null;
  let staleContractNote: string | null = null;
  let contractUnreadable: string | null = null;
  const clampNote = clamped
    ? `requested ${requested}ms was clamped to ${SAFE_CEILING_MS}ms to stay under the MCP client request timeout`
    : null;

  while (Date.now() - start < budgetMs) {
    try {
      const stat = fs.statSync(readyPath);
      const raw = fs.readFileSync(readyPath, "utf8");
      const contract: ReadyContract = JSON.parse(raw);
      const stampedBeforeSession =
        since !== null && stat.mtimeMs < since - CONTRACT_MTIME_GRANULARITY_SLACK_MS;
      const deadOrphanStamp =
        since === null &&
        contract.status !== "ready" &&
        typeof contract.pid === "number" &&
        contractPidState(args.projectPath, browser, contract, "engine") === "dead";

      if (stampedBeforeSession || deadOrphanStamp) {
        staleContractNote = stampedBeforeSession
          ? `A ready.json contract stamped before this session started (status: ${contract.status}) was ignored; it describes the previous run, not this one.`
          : `A ready.json contract whose dev-server pid ${contract.pid} is dead (status: ${contract.status}) was ignored; it describes a session that already exited.`;

        await sleep(pollInterval);
        continue;
      }

      lastContractStatus = contract.status;

      if ((contract as { command?: unknown }).command === "build") {
        return envelope({
          ok: false,
          command: schema.name,
          status: "no-session",
          error: {
            code: "E_NO_SESSION",
            message: `${readyPath} is the contract a finished extension_build left (command: build), not a running session, so there is nothing to wait for.`,
          },
          value: { readyPath, budgetMs, elapsedMs: Date.now() - start },
          hint: "Start a session with extension_dev (or extension_start), then call extension_wait.",
        });
      }

      if (contract.status === "stopped") {
        return envelope({
          ok: false,
          command: schema.name,
          status: "stopped",
          error: {
            code: "E_SESSION_EXITED",
            message: `${readyPath} records status: stopped; that session was stopped and nothing will become ready.`,
          },
          value: { readyPath, budgetMs, elapsedMs: Date.now() - start },
          hint: "Start a session with extension_dev, then call extension_wait.",
        });
      }

      if (contract.status === "ready") {
        if (contractPidState(args.projectPath, browser, contract, "engine") === "dead") {
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

        const browserGone =
          contract.runtime === "detached" ||
          typeof (contract as { browserExitedAt?: unknown }).browserExitedAt === "string";

        const verdict = browserGone ? await readDetachedVerdict(contract, { projectPath: args.projectPath, browser }) : null;

        if (verdict && verdict.kind !== "gone") {
          return detachedVerdictFrame(schema.name, contract, verdict, {
            ...sessionPorts(contract),
            budgetMs,
            elapsedMs: Date.now() - start,
          }, clampNote);
        }

        if (browserGone) {
          const goneEvidence = verdict?.kind === "gone" ? verdict.evidence : null;
          const exit = contract as {
            browserExitedAt?: string;
            browserExitCode?: number | null;
            browserExitSignal?: string | null;
            executorDetachedAt?: string;
          };

          return envelope({
            ok: false,
            command: schema.name,
            status: "browser-gone",
            error: {
              code: "E_SESSION_EXITED",
              message: `ready.json still reads ready, but the browser is gone: ${
                exit.browserExitedAt
                  ? `it exited at ${exit.browserExitedAt}${
                      exit.browserExitCode != null ? ` with code ${exit.browserExitCode}` : ""
                    }${exit.browserExitSignal ? ` (${exit.browserExitSignal})` : ""}`
                  : `the runtime executor detached${exit.executorDetachedAt ? ` at ${exit.executorDetachedAt}` : ""}`
              }${goneEvidence ? `, and ${goneEvidence}` : ""}. The dev server is still up, so a build will still land, but nothing is attached to drive or read.`,
            },
            value: {
              compiled: true,
              browserAttached: false,
              browserGone: true,
              ...sessionCommandSinceEnvelopeOwnsCommand(contract),
              browser: contract.browser,
              pid: contract.pid,
              ...(exit.browserExitedAt ? { browserExitedAt: exit.browserExitedAt } : {}),
              ...(exit.executorDetachedAt ? { executorDetachedAt: exit.executorDetachedAt } : {}),
              budgetMs,
              elapsedMs: Date.now() - start,
            },
            hint: "Call extension_stop for this project, then extension_dev again; extension_logs (level: error) and the session log may say why the browser left.",
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
              ...sessionPorts(contract),
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

        if (!attached && (contract.command === "start" || contract.command === "preview")) {
          const launch = await readLoadOverDebugPort(contract, productionLaunchEvidence(contract, false, { projectPath: args.projectPath, browser }));

          return envelope({
            ok: true,
            command: schema.name,
            status: "build-ready",
            value: {
              compiled: true,
              browserAttached: launch.extensionLoaded === true,
              sessionCommand: contract.command,
              browser: contract.browser,
              ...sessionPorts(contract),
              ...launch,
              pid: contract.pid,
              readyPath,
              budgetMs,
              elapsedMs: Date.now() - start,
            },
            warnings: [clampNote, staleContractNote],
            hint: productionWaitHint(contract, launch, { projectPath: args.projectPath, browser }),
          });
        }

        if (!attached && browserUpNotAttached(contract)) {
          return browserUpNotAttachedAnswer(contract, {
            command: schema.name,
            projectPath: args.projectPath,
            browser,
            readyPath,
            budgetMs,
            elapsedMs: Date.now() - start,
            warnings: [clampNote, staleContractNote],
          });
        }

        if (!attached) {
          sawCompiledButUnattached = true;
          unattachedContract = contract;
          if (!(await unattached.reattachedNow(contract, budgetMs - (Date.now() - start)))) await sleep(unattached.pollDelayMs(pollInterval));

          continue;
        }

        const reloadedMs = unattached.recovery?.outcome === "attached" ? Date.parse(unattached.recovery.reloadedAt) : Number.NaN;
        const recovered = Number.isFinite(reloadedMs);
        const runtimeErrors = recentErrorLogs(args.projectPath, browser, 3, {}, recovered ? { fromMs: reloadedMs } : {});
        const beforeRecovery = recovered ? recentErrorLogs(args.projectPath, browser, 3, {}, { beforeMs: reloadedMs }) : [];
        const guestCheck = await verifyGuestLoaded(args.projectPath, browser);
        const signingFrame = await safariSigningFrame(args.projectPath, browser);
        const warnings: string[] = [...(signingFrame?.warnings ?? []), ...(unattached.recovery ? [unattached.recovery.say] : [])];

        if (runtimeErrors.length) {
          warnings.push(
            `Compiled and attached, but the extension is throwing at runtime (${runtimeErrors.length} recent error event${runtimeErrors.length === 1 ? "" : "s"} above). Check extension_logs (level: error) or extension_doctor before trusting this session.`,
          );
        }

        if (guestCheck.checked && !guestCheck.loaded) {
          warnings.push(
            `The engine reports the runtime attached, but the browser's own target list shows no chrome-extension:// target under your extension's id. ${guestCheck.reason} The control verbs will fail against a guest that is not there. Check the manifest and extension_logs.`,
          );
        }

        return envelope({
          ok: true,
          command: schema.name,
          status: "ready",
          value: {
            compiled: true,
            browserAttached: true,
            ...(guestCheck.checked
              ? { guestLoaded: guestCheck.loaded, guestIds: guestCheck.guestIds }
              : WEBKIT_FAMILY.has(browser)
                ? {}
                : { guestLoaded: null, guestLoadNote: guestCheck.reason }),
            ...sessionCommandSinceEnvelopeOwnsCommand(contract),
            browser: contract.browser,
            ...sessionPorts(contract),
            pid: contract.pid,
            distPath: contract.distPath,
            manifestPath: contract.manifestPath,
            ...(typeof contract.browserPid === "number"
              ? { browserPid: contract.browserPid }
              : {}),
            ...(typeof contract.profilePath === "string" && contract.profilePath
              ? { profilePath: contract.profilePath }
              : {}),
            compiledAt: contract.compiledAt,
            startedAt: contract.startedAt,
            budgetMs,
            elapsedMs: Date.now() - start,
            ...(runtimeErrors.length ? { runtimeErrors } : {}),
            ...(beforeRecovery.length
              ? {
                  beforeRecovery: {
                    errors: beforeRecovery,
                    note: `Logged before the recovery reload at ${unattached.recovery?.outcome === "attached" ? unattached.recovery.reloadedAt : ""}, by the build the browser held before it; the reload replaced that build, so these are not the live build's errors.`,
                  },
                }
              : {}),
            ...(unattached.recovery ? { executorRecovery: unattached.recovery } : {}),
            ...(signingFrame ? { signing: signingFrame.signing } : {}),
          },
          warnings,
          ...(signingFrame?.hints.length ? { hint: signingFrame.hints.join(" ") } : {}),
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
            errors: contractErrorList(contract),
            browser: contract.browser,
            budgetMs,
            elapsedMs: Date.now() - start,
          },
          hint:
            contract.command === "start" || contract.command === "preview"
              ? productionContractHint(contract.code, contract.command)
              : contract.code === "browser_exited" || contract.code === "browser_launch_failed"
              ? "The browser is gone and the dev server does not relaunch it: read extension_logs for its last words, then call extension_dev with replace: true."
              : contract.code === "compile_failed"
              ? "The compiler failed outside a module (a plugin hook or extension.config.js threw), which the dev server's watcher does not recover from: fix the cause, then call extension_dev with replace: true."
              : 'Fix the errors in value.errors and save: the dev server recompiles. Call extension_wait with for: "rebuild" to wait for that compile.',
        });
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      contractUnreadable =
        code === "ENOENT" ? null : `${readyPath} exists but could not be read: ${(err as Error)?.message ?? String(err)}`;
    }

    await sleep(pollInterval);
  }

  if (sawCompiledButUnattached) {
    return compiledNotAttachedAnswer({
      command: schema.name,
      projectPath: args.projectPath,
      browser,
      readyPath,
      budgetMs,
      elapsedMs: Date.now() - start,
      warnings: [clampNote, staleContractNote],
      contract: unattachedContract,
      recovery: unattached.recovery,
    });
  }

  if (lastContractStatus === null && !contractUnreadable && !staleContractNote && !findSessionInfo(args.projectPath, browser)) {
    return envelope({
      ok: false,
      command: schema.name,
      status: "no-session",
      error: {
        code: "E_NO_SESSION",
        message: `No ${browser} session is known for ${args.projectPath}: this server registered none and no contract appeared at ${readyPath} in ${budgetMs} ms.`,
      },
      value: { compiled: false, browserAttached: false, readyPath, budgetMs, elapsedMs: Date.now() - start },
      warnings: [clampNote],
      hint: "Check projectPath and browser, or start a session with extension_dev, then call extension_wait.",
    });
  }

  const starting = startingSession(args.projectPath, browser);

  if (starting) {
    return envelope({
      ok: true,
      command: schema.name,
      status: "starting",
      value: {
        compiled: false,
        browserAttached: false,
        waitingOn: starting.waitingOn,
        pid: starting.pid,
        readyPath,
        budgetMs,
        elapsedMs: Date.now() - start,
        retry: "safe",
      },
      warnings: [clampNote, staleContractNote],
      hint: `Call extension_wait again: that is the correct next call, and it resumes polling the same contract. ${startingSentence(starting, args.projectPath)} It was not ready after ${budgetMs}ms this call, which is progress and not a failure. ${FIRST_RUN_NOTE} The session exists: do not start or replace it. ${SOURCE_NOT_LOADABLE_NOTE} If it never readies, extension_doctor checks the dev process.`,
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
          : contractUnreadable
            ? `Not ready after ${budgetMs}ms this call: ${contractUnreadable}. A contract that exists and cannot be read is not "no session"; the engine may be mid-write, or the file is corrupt.`
            : `Not ready after ${budgetMs}ms this call: no ready contract was observed at ${readyPath}, so neither the compile nor a browser attach has been seen.`,
    },
    value: {
      compiled: false,
      browserAttached: false,
      readyPath,
      budgetMs,
      elapsedMs: Date.now() - start,
    },
    warnings: [clampNote, staleContractNote],
    hint: "Still building, call extension_wait again to keep waiting (it resumes polling the same contract). If it never readies, check the dev process with extension_doctor.",
  });
}

function productionContractHint(code: unknown, command: "start" | "preview"): string {
  const relaunch = command === "preview" ? "extension_start with build: false and replace: true" : "extension_start with replace: true";

  if (code === "browser_exited" || code === "browser_launch_failed") {
    return `The browser is gone and a ${command} session does not relaunch it: read extension_logs for its last words, then call ${relaunch}.`;
  }

  return `A ${command} session builds once and does not rebuild after a fix: fix the cause in value.errors, then call ${relaunch}.`;
}
