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
      "What to wait for. \"ready\" (the default) waits for the session to be ready. \"rebuild\" waits for the compile after a source edit: until ready.json's compiledAt moves past its value at call time (or past since), then for the reload: an engine that stamps reloadedAt is waited on until that stamp also moves past its value at call time, answering reload.outcome \"reloaded\" with reloadKind (full, background, content, page or safari-resync) and reloadLabel; an older engine is watched briefly for the background to connect again (reattached, still-detached, or not-stamped for a content-script, page or Safari app re-sync reload, which it does not stamp). It answers status \"rebuilt\" with the new compiledAt, errors and reload, or status \"compile-error\" with the errors.",
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

export function contractErrorList(
  contract: Pick<ReadyContract, "errors" | "message">,
): string[] {
  if (Array.isArray(contract.errors) && contract.errors.length) return contract.errors;

  return typeof contract.message === "string" && contract.message.trim()
    ? [contract.message]
    : [];
}

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
  outcome: "reloaded" | "reattached" | "still-detached" | "not-stamped";
  waitedMs: number;
  detachedAt?: string;
  reloadedAt?: string;
  reloadKind?: string;
  reloadLabel?: string;
  note: string;
}

function stampedReload(contract: ReadyContract | null, reloadFloor: number, waitedMs: number): ReloadReading | null {
  const reloadedMs = stampMs(contract?.reloadedAt);
  if (!contract || reloadedMs === null || reloadedMs <= reloadFloor) return null;

  const kind = typeof contract.reloadKind === "string" ? contract.reloadKind : "full";
  const label = typeof contract.reloadLabel === "string" ? contract.reloadLabel : undefined;

  return {
    outcome: "reloaded",
    waitedMs,
    reloadedAt: contract.reloadedAt as string,
    reloadKind: kind,
    ...(label ? { reloadLabel: label } : {}),
    note: `ready.json stamped a ${kind} reload${label ? ` (${label})` : ""} at ${contract.reloadedAt}, after this compile, so the change reached the browser.`,
  };
}

async function watchReload(
  projectPath: string,
  browser: string,
  compiledAt: string,
  compileWriteTs: unknown,
  graceMs: number,
  reloadFloor: number,
  stampsReloads: boolean,
): Promise<ReloadReading> {
  const started = Date.now();
  const compileWriteMs = Math.max(stampMs(compileWriteTs) ?? 0, stampMs(compiledAt) ?? 0);
  let detachedAt: string | undefined;

  for (;;) {
    const contract = readContract(projectPath, browser);
    const waitedMs = Date.now() - started;
    const tsMs = stampMs(contract?.ts);

    const reloaded = contract?.compiledAt === compiledAt ? stampedReload(contract, reloadFloor, waitedMs) : null;
    if (reloaded) return reloaded;

    if (contract?.runtime === "detached") detachedAt = contract.executorDetachedAt ?? detachedAt;

    if (!stampsReloads && contract?.runtime === "attached" && tsMs !== null && tsMs > compileWriteMs && contract.compiledAt === compiledAt) {
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
  const reloadFloor = sinceValid ? (stampMs(since) as number) : (stampMs(atCall.reloadedAt) ?? Number.NEGATIVE_INFINITY);
  const stampsReloads = typeof atCall.reloadedAt === "string";
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
          value: { errors: contractErrorList(contract), failedAt: contract.ts, since: baseline, budgetMs, elapsedMs: Date.now() - start },
          hint: `Fix the errors, then call extension_wait with for: "rebuild" again. ${NO_TAILING}`,
        });
      }

      if (contract.status === "ready" && compiledMs !== null && compiledMs > compiledFloor) {
        const compiledAt = contract.compiledAt as string;
        const remaining = budgetMs - (Date.now() - start);
        const graceCap = stampsReloads ? remaining : WEBKIT_FAMILY.has(browser) ? WEBKIT_RELOAD_GRACE_MS : RELOAD_GRACE_MS;
        const grace = Math.max(0, Math.min(remaining, graceCap));
        const watched = await watchReload(projectPath, browser, compiledAt, contract.ts, grace, reloadFloor, stampsReloads);
        const reload: ReloadReading =
          stampsReloads && watched.outcome === "not-stamped"
            ? { ...watched, note: `This engine stamps every reload it applies (ready.json reloadedAt), and none landed within ${watched.waitedMs} ms of this compile, so the browser has not applied the change yet. extension_doctor reports whether the extension's executor is connected.` }
            : watched;

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
