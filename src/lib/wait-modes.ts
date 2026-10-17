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
import { envelope } from "./envelope";
import { readyContractPath } from "./session-paths";

import type { ReadyContract } from "./types";

export const WAIT_MODE_PROPERTIES = {
  for: {
    type: "string",
    enum: ["ready", "rebuild"],
    default: "ready",
    description:
      "What to wait for. \"ready\" (the default) waits for the session to be ready. \"rebuild\" waits for the compile after a source edit: until ready.json's compiledAt moves past its value at call time (or past since), then briefly for the reloaded background to connect again; it answers status \"rebuilt\" with the new compiledAt, errors and reload.outcome (reattached, still-detached, or not-stamped for a content-script, page or Safari app re-sync reload, which ready.json does not stamp), or status \"compile-error\" with the errors.",
  },
  since: {
    type: "string",
    description:
      "for: \"rebuild\" only. An ISO time: a compile stamped after it counts, so pass the compiledAt an earlier answer returned (or a time before your edit) and a rebuild that landed before this call is not missed.",
  },
};

const REBUILD_POLL_MS = 200;
const RELOAD_GRACE_MS = 5_000;
const WEBKIT_RELOAD_GRACE_MS = 15_000;

const NO_TAILING =
  "Do not sleep or tail the session log in a shell to wait: extension_wait with for: \"rebuild\" waits for the compile after an edit, and extension_eval with until waits for a page or extension condition.";

function readContract(projectPath: string, browser: string): ReadyContract | null {
  try {
    return JSON.parse(fs.readFileSync(readyContractPath(projectPath, browser), "utf8")) as ReadyContract;
  } catch {
    return null;
  }
}

function stampMs(value: unknown): number | null {
  if (typeof value !== "string" || !value) return null;

  const ms = Date.parse(value);

  return Number.isFinite(ms) ? ms : null;
}

interface ReloadReading {
  outcome: "reattached" | "still-detached" | "not-stamped";
  waitedMs: number;
  detachedAt?: string;
  note: string;
}

async function watchReload(
  projectPath: string,
  browser: string,
  compiledAt: string,
  graceMs: number,
): Promise<ReloadReading> {
  const started = Date.now();
  const compiledMs = stampMs(compiledAt) ?? 0;
  let detachedAt: string | undefined;

  for (;;) {
    const contract = readContract(projectPath, browser);
    const waitedMs = Date.now() - started;
    const tsMs = stampMs(contract?.ts);

    if (contract?.runtime === "detached") detachedAt = contract.executorDetachedAt ?? detachedAt;

    if (contract?.runtime === "attached" && tsMs !== null && tsMs > compiledMs && contract.compiledAt === compiledAt) {
      return {
        outcome: "reattached",
        waitedMs,
        ...(detachedAt ? { detachedAt } : {}),
        note: `ready.json stamped the extension's executor connected again at ${contract.ts}, after this compile, so the reloaded background is up.`,
      };
    }

    if (waitedMs >= graceMs) {
      return detachedAt
        ? {
            outcome: "still-detached",
            waitedMs,
            detachedAt,
            note: `ready.json stamped the executor detached at ${detachedAt} after this compile and not connected again within ${waitedMs} ms: the reloaded background has not come up yet, or it went idle. Call extension_wait (no for) to read which.`,
          }
        : {
            outcome: "not-stamped",
            waitedMs,
            note: `ready.json stamped no executor reconnect within ${waitedMs} ms of this compile. It stamps one only when the background reloads; a content-script or page reload${WEBKIT_FAMILY.has(browser) ? ", and the Safari app re-sync that follows a compile," : ""} leaves no stamp, so confirm the change itself with extension_eval and until.`,
          };
    }

    await sleep(REBUILD_POLL_MS);
  }
}

export async function waitForRebuild(
  command: string,
  projectPath: string,
  browser: string,
  since: string | undefined,
  budgetMs: number,
): Promise<string> {
  const start = Date.now();
  const atCall = readContract(projectPath, browser);

  if (!atCall) {
    return envelope({
      ok: false,
      command,
      status: "no-session",
      error: { code: "E_NO_SESSION", message: `No ready.json for a ${browser} session on ${projectPath}, so there is no compile stamp to wait past.` },
      value: { budgetMs, elapsedMs: 0 },
      hint: "Start a session with extension_dev, then call extension_wait with for: \"rebuild\" after an edit.",
    });
  }

  const sinceValid = since !== undefined && stampMs(since) !== null;
  const previousCompiledAt = typeof atCall.compiledAt === "string" ? atCall.compiledAt : null;
  const baseline = sinceValid ? (since as string) : previousCompiledAt;
  const compiledFloor = stampMs(baseline) ?? Number.NEGATIVE_INFINITY;
  const errorFloor = sinceValid ? (stampMs(since) as number) : start;
  let last: ReadyContract = atCall;

  while (Date.now() - start < budgetMs) {
    const contract = readContract(projectPath, browser);

    if (contract) {
      last = contract;
      const compiledMs = stampMs(contract.compiledAt);

      if (contract.status === "stopped") {
        return envelope({
          ok: false,
          command,
          status: "stopped",
          error: { code: "E_SESSION_EXITED", message: "ready.json records status: stopped; the session ended, so no rebuild will land." },
          value: { since: baseline, budgetMs, elapsedMs: Date.now() - start },
          hint: "Start a session with extension_dev.",
        });
      }

      if (contract.status === "error" && (stampMs(contract.ts) ?? 0) > errorFloor) {
        return envelope({
          ok: false,
          command,
          status: "compile-error",
          error: { code: "E_COMPILE", message: contract.message ?? "The rebuild failed.", contractCode: contract.code },
          value: { errors: contract.errors ?? [], failedAt: contract.ts, since: baseline, budgetMs, elapsedMs: Date.now() - start },
          hint: `Fix the errors, then call extension_wait with for: "rebuild" again. ${NO_TAILING}`,
        });
      }

      if (contract.status === "ready" && compiledMs !== null && compiledMs > compiledFloor) {
        const compiledAt = contract.compiledAt as string;
        const remaining = budgetMs - (Date.now() - start);
        const grace = Math.max(0, Math.min(remaining, WEBKIT_FAMILY.has(browser) ? WEBKIT_RELOAD_GRACE_MS : RELOAD_GRACE_MS));
        const reload = await watchReload(projectPath, browser, compiledAt, grace);

        return envelope({
          ok: true,
          command,
          status: "rebuilt",
          value: {
            compiledAt,
            previousCompiledAt,
            ...(sinceValid ? { since } : {}),
            errors: contract.errors ?? [],
            reload,
            browser,
            budgetMs,
            elapsedMs: Date.now() - start,
          },
          hint: `The rebuild landed at ${compiledAt}. ${reload.note} To wait for the next edit's rebuild, pass since: "${compiledAt}".`,
        });
      }
    }

    await sleep(REBUILD_POLL_MS);
  }

  return envelope({
    ok: false,
    command,
    status: "timeout",
    error: {
      code: "E_WAIT_TIMEOUT",
      message: `No compile stamped after ${baseline ?? "the session start"} within ${budgetMs} ms (ready.json compiledAt is ${last.compiledAt ?? "unset"}, status ${last.status}).`,
    },
    value: { since: baseline, compiledAt: last.compiledAt ?? null, lastStatus: last.status, budgetMs, elapsedMs: Date.now() - start },
    hint: `Call extension_wait again with for: "rebuild" and since: "${baseline ?? new Date(start).toISOString()}" so a compile that lands between calls still counts. If the edit was saved and nothing compiles, check that the file is part of the build. ${NO_TAILING}`,
  });
}

export async function waitModeFrame(
  command: string,
  args: { projectPath: string; for?: string; since?: string; until?: unknown },
  browser: string,
  budgetMs: number,
): Promise<string | null> {
  if (args.until !== undefined) {
    return envelope({
      ok: false,
      command,
      status: "bad-request",
      error: { code: "E_BAD_REQUEST", message: "extension_wait only reads the session contract and takes no until: waiting on a condition runs code, which is extension_eval's job." },
      hint: "Call extension_eval with the expression, its context and url, and until: {} (or {timeoutMs, intervalMs}); it repeats the eval until the value is truthy.",
    });
  }

  if (args.for === "rebuild") return waitForRebuild(command, args.projectPath, browser, args.since, budgetMs);

  return null;
}
