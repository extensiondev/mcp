// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { envelope } from "./envelope";
import { headlessHint } from "./launch-flags";
import { productionLoadProofLine } from "./production-launch";
import { waitCall } from "./production-receipt";
import { START_WAIT_BUDGET_MS } from "./start-landing";
import { handler as waitHandler } from "../tools/wait";

import type { ProductionLaunchEvidence } from "./production-launch";
import type { ReadyContract } from "./types";

interface WaitFrame {
  ok?: boolean;
  status?: string;
  error?: { code: string; message: string } & Record<string, unknown>;
  value?: Record<string, unknown>;
  hint?: string;
  warnings?: unknown[];
}

export type StartLanding =
  | { kind: "landed"; frame: WaitFrame }
  | { kind: "timeout"; frame: WaitFrame }
  | { kind: "failed"; frame: WaitFrame };

export async function awaitStartLanding(projectPath: string, browser: string): Promise<StartLanding> {
  const frame = JSON.parse(
    await waitHandler({ projectPath, browser, timeoutMs: START_WAIT_BUDGET_MS }),
  ) as WaitFrame;

  if (frame.ok === true) return { kind: "landed", frame };
  if (frame.status === "timeout" || frame.status === "no-session") return { kind: "timeout", frame };

  return { kind: "failed", frame };
}

export interface StartFacts {
  command: string;
  verb: "start" | "preview";
  projectPath: string;
  browser: string;
  pid: number;
  noBrowser: boolean;
  profileReused: boolean;
  headless: boolean;
  allowControl: boolean;
  allowEval: boolean;
  controlPort: number | null;
  controlledCopy: string;
  identity: Record<string, unknown>;
  launch: ProductionLaunchEvidence;
  contract: ReadyContract | null;
  replacedSession: unknown;
  warnings: Array<string | null | false | undefined>;
  landing: StartLanding | null;
}

const STOP = "When you are done, call extension_stop to shut the session down.";

function bridgeLine(facts: StartFacts): string {
  const { allowControl, allowEval, controlPort, controlledCopy } = facts;

  if (!allowControl) {
    return "A production session carries no dev bridge, so extension_logs has no console stream for it and the control verbs cannot attach; pass allowControl:true to drive it.";
  }

  const channel =
    controlPort !== null
      ? `This production session carries the control channel (port ${controlPort})`
      : "This production session asked for the control channel, and the contract has not recorded its port yet because the build is still running; extension_wait reads it once the build lands. The channel rides";
  const evalWords = allowEval
    ? ", and extension_eval runs where the build's content_security_policy allows it (context:'page' in a tab always does)"
    : "; extension_eval needs allowEval:true";

  return `${channel} on a copy of the build at ${controlledCopy}, so extension_storage, extension_reload (a real reload of the installed extension under open tabs, as a store update does), extension_open and extension_dom_snapshot attach${evalWords}. extension_logs has no console stream for it.`;
}

function sessionValue(facts: StartFacts): Record<string, unknown> {
  return {
    pid: facts.pid,
    browser: facts.browser,
    projectPath: facts.projectPath,
    verb: facts.verb,
    ...(facts.noBrowser ? {} : { profileReused: facts.profileReused }),
    headless: facts.headless,
    allowControl: facts.allowControl,
    allowEval: facts.allowEval,
    ...(facts.allowControl ? { controlPort: facts.controlPort } : {}),
    ...facts.identity,
    ...(facts.replacedSession ? { replacedSession: facts.replacedSession } : {}),
  };
}

function launchSeen(facts: StartFacts): string {
  const { launch } = facts;

  return launch.browserPid === null
    ? "the contract has not recorded a browser launch yet; extension_wait reads it once the build lands (browserPid, browserAlive)"
    : `the contract names the browser it launched (pid ${launch.browserPid}, ${launch.browserAlive ? "alive" : "gone"})`;
}

function startedHint(facts: StartFacts, lead: string): string {
  const { launch, browser, projectPath, contract, allowControl, noBrowser, headless } = facts;
  const visibility = noBrowser ? "" : headlessHint(headless);
  const proof = productionLoadProofLine(contract, launch, allowControl, projectPath, browser);

  return launch.extensionLoaded === true
    ? `${lead} ${launchSeen(facts)}, and ${browser} loaded the extension: ${launch.loadEvidence} ${bridgeLine(facts)} ${visibility} ${STOP}`
    : `${lead} ${launchSeen(facts)}. What this answer cannot confirm is that ${browser} loaded the extension: ${launch.loadEvidence} ${bridgeLine(facts)} ${proof} ${visibility} ${STOP}`;
}

function waitedOut(frame: WaitFrame): Record<string, unknown> {
  const value = frame.value ?? {};

  return {
    status: frame.status ?? "timeout",
    budgetMs: value.budgetMs ?? START_WAIT_BUDGET_MS,
    elapsedMs: value.elapsedMs ?? null,
  };
}

function landedAnswer(facts: StartFacts, frame: WaitFrame): string {
  const value = frame.value ?? {};
  const elapsed = typeof value.elapsedMs === "number" ? `${value.elapsedMs} ms` : "the wait";
  const loaded = frame.status === "ready" || value.extensionLoaded === true;
  const lead = loaded
    ? `The build landed and ${facts.browser} loaded the extension within ${elapsed} of the spawn, so no extension_wait is needed.`
    : `The build landed within ${elapsed} of the spawn; the load is not read yet.`;
  const visibility = facts.noBrowser ? "" : headlessHint(facts.headless);

  return envelope({
    ok: true,
    command: facts.command,
    status: frame.status ?? "build-ready",
    value: { ...sessionValue(facts), ...value, pid: facts.pid, waited: { ...waitedOut(frame), status: "landed" } },
    hint: `${lead} ${frame.hint ?? ""} ${bridgeLine(facts)} ${visibility} ${STOP}`.replace(/\s+/g, " ").trim(),
    warnings: [...facts.warnings, ...((frame.warnings ?? []) as Array<string | null>)],
  });
}

function failedAnswer(facts: StartFacts, frame: WaitFrame): string {
  return envelope({
    ok: false,
    command: facts.command,
    status: frame.status ?? "wait-failed",
    error: frame.error ?? {
      code: "E_CONTRACT_ERROR",
      message: `The ${facts.verb} process was alive 5 s after spawn, but the wait for the build answered ${frame.status ?? "nothing"}.`,
    },
    value: { ...sessionValue(facts), ...(frame.value ?? {}), pid: facts.pid, waited: { ...waitedOut(frame), status: "failed" } },
    ...(frame.hint ? { hint: frame.hint } : {}),
    warnings: [...facts.warnings, ...((frame.warnings ?? []) as Array<string | null>)],
  });
}

export function startAnswer(facts: StartFacts): string {
  const { landing } = facts;

  if (landing?.kind === "landed") return landedAnswer(facts, landing.frame);
  if (landing?.kind === "failed") return failedAnswer(facts, landing.frame);

  const alive = `The engine's ${facts.verb} process was alive 5 s after spawn and`;
  const lead =
    landing === null
      ? alive
      : `${alive} the build had not landed ${waitedOut(landing.frame).budgetMs} ms later (${String(landing.frame.error?.message ?? "no ready contract was observed")}). Call ${waitCall(facts.projectPath, facts.browser)} to keep waiting on the same contract, or pass wait: false to skip this wait. Meanwhile`;

  return envelope({
    ok: true,
    command: facts.command,
    status: "started",
    value: {
      ...sessionValue(facts),
      observed: "the engine process was alive 5 s after it was spawned",
      ...facts.launch,
      ...(landing ? { waited: waitedOut(landing.frame) } : {}),
    },
    hint: startedHint(facts, lead),
    warnings: facts.warnings,
  });
}
