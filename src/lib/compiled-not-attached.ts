// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import path from "node:path";

import { envelope, sessionCommandSinceEnvelopeOwnsCommand } from "./envelope";
import { verifyGuestLoaded } from "./guest-load-oracle";
import { pidState } from "./process-identity";
import { findSessionInfo } from "./process-manager";
import { isSafariTarget, notAttachedHint } from "./safari-dev-options";
import { safariSigningFrame } from "./safari-signing";
import { browserProfileRootDir } from "./session-paths";
import { sessionPorts } from "./session-ports";

import type { ExecutorRecovery } from "./executor-recovery";
import type { ReadyContract } from "./types";

export const NO_ATTACH_DIAGNOSIS_NOTE =
  "the engine running here wrote no attach diagnosis into ready.json, so the reason is not in the contract";

const KEEPS_WAITING =
  "The dev server keeps waiting and stamps executorAttachedAt on the first attach, so a dialog dismissed in that window also turns the next extension_wait into ready.";

export interface NotAttachedContext {
  command: string;
  projectPath: string;
  browser: string;
  readyPath: string;
  budgetMs: number;
  elapsedMs: number;
  warnings?: Array<string | null | undefined | false>;
  contract?: ReadyContract | null;
  recovery?: ExecutorRecovery | null;
}

export type FailedLeg = "browser" | "extension-load" | "executor";

export interface ObservedAttachLegs {
  failedLeg: FailedLeg | null;
  failedLegSays: string | null;
  legs: Record<string, unknown>;
  freshProfile: string | null;
}

export const REBUILD_NOT_REACHING_NOTE =
  "Until the background connects, an edit still compiles but does not reach the browser: the dev server applies every reload through that connection, so the browser keeps the build it loaded.";

export const CONTROL_PORT_KEPT_NOTE =
  "the engine keeps one control port per project and browser on purpose, so a worker cached in a reused profile can find the port it was built with; a replaced session answering with the same port is that design, not a port left bound";

export async function observeAttachLegs(
  contract: ReadyContract | null | undefined,
  ctx: { projectPath: string; browser: string },
): Promise<ObservedAttachLegs> {
  const none: ObservedAttachLegs = { failedLeg: null, failedLegSays: null, legs: {}, freshProfile: null };
  if (!contract || isSafariTarget(ctx.browser)) return none;

  const browserPid = typeof contract.browserPid === "number" ? contract.browserPid : null;
  const browserAlive = browserPid === null ? null : pidState(browserPid) !== "dead";
  const profilePath = typeof contract.profilePath === "string" && contract.profilePath.trim() ? contract.profilePath : null;
  const profileReused =
    typeof contract.profileReused === "boolean"
      ? contract.profileReused
      : findSessionInfo(ctx.projectPath, ctx.browser)?.profileReused === true;
  const controlPort = typeof contract.controlPort === "number" ? contract.controlPort : null;
  const guest = browserAlive === false ? null : await verifyGuestLoaded(ctx.projectPath, ctx.browser, { timeoutMs: 2000 });
  const legs = {
    browser: { pid: browserPid, alive: browserAlive },
    extension: guest?.checked ? { loaded: guest.loaded, guestIds: guest.guestIds } : { loaded: null, note: guest?.reason ?? "not read: the browser is gone" },
    controlChannel: { port: controlPort, ...(controlPort !== null ? { note: CONTROL_PORT_KEPT_NOTE } : {}) },
    executor: { attached: false },
    profile: { path: profilePath, reused: profileReused },
  };
  const reusedProfile = profileReused
    ? ` The profile${profilePath ? ` at ${profilePath}` : ""} had been run before, and a stale copy of the extension in it can keep the worker from connecting; restarting on that same profile keeps it, so a plain restart does not help.`
    : "";
  const fresh = (leg: FailedLeg, says: string): ObservedAttachLegs => ({
    failedLeg: leg,
    failedLegSays: says,
    legs,
    freshProfile: profileReused ? freshProfilePath({ profilePath, projectPath: ctx.projectPath, browser: ctx.browser }) : null,
  });

  if (browserAlive === false) {
    return { failedLeg: "browser", failedLegSays: `The browser this session launched (pid ${browserPid}) is gone, so nothing is left to attach.`, legs, freshProfile: null };
  }

  if (!guest?.checked) return { ...none, legs };

  if (!guest.loaded) {
    return fresh("extension-load", `The browser is up${browserPid !== null ? ` (pid ${browserPid})` : ""}, but its target list shows no target for this extension, so it never loaded the build.${reusedProfile}`);
  }

  return fresh(
    "executor",
    `The browser is up${browserPid !== null ? ` (pid ${browserPid})` : ""} and the extension is loaded (its ${guest.guestIds.join(", ")} target is in the browser's list), but its background never connected to this session's control channel${controlPort !== null ? ` on port ${controlPort}` : ""}.${reusedProfile}`,
  );
}

export interface NotAttachedRelay {
  value: Record<string, unknown>;
  message: string;
  hint: string;
}

export function browserUpNotAttached(contract: ReadyContract): boolean {
  return (
    typeof contract.browserUpNotAttachedAt === "string" &&
    contract.browserUpNotAttachedAt.trim().length > 0
  );
}

function pad(part: number): string {
  return String(part).padStart(2, "0");
}

export function freshProfileStamp(now: Date = new Date()): string {
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}${pad(now.getHours())}${pad(now.getMinutes())}`;
}

export function freshProfilePath(input: {
  profilePath?: string | null;
  projectPath: string;
  browser: string;
  now?: Date;
}): string {
  const stamp = freshProfileStamp(input.now);
  const current =
    typeof input.profilePath === "string"
      ? input.profilePath.trim().replace(/[\\/]+$/, "")
      : "";

  if (current) return `${current}-fresh-${stamp}`;

  return path.join(
    browserProfileRootDir(input.projectPath, input.browser),
    `fresh-${stamp}`,
  );
}

function wayOutSentence(profile: string): string {
  return `Relaunch on a fresh profile: call extension_dev with replace: true and profile: "${profile}".`;
}

function sentences(hint: string, wayOut: string): { message: string; sayToPerson: string; hint: string } {
  return {
    message: `The extension compiled and the browser is up, but nothing inside it has connected. ${hint}`,
    sayToPerson: `${hint} ${wayOut}`,
    hint: `${hint} ${wayOut} ${KEEPS_WAITING}`,
  };
}

export function browserUpNotAttachedAnswer(
  contract: ReadyContract,
  ctx: NotAttachedContext,
): string {
  const hint =
    (contract.browserUpNotAttachedHint ?? "").trim() ||
    "the browser is up, but the extension has not connected";
  const profilePath =
    typeof contract.profilePath === "string" && contract.profilePath.trim()
      ? contract.profilePath
      : null;
  const profile = freshProfilePath({
    profilePath,
    projectPath: ctx.projectPath,
    browser: ctx.browser,
  });
  const wayOut = wayOutSentence(profile);
  const said = sentences(hint, wayOut);

  return envelope({
    ok: false,
    command: ctx.command,
    status: "compiled-not-attached",
    error: { code: "E_NOT_ATTACHED", message: said.message },
    value: {
      compiled: true,
      browserAttached: false,
      ...sessionCommandSinceEnvelopeOwnsCommand(contract),
      browser: contract.browser,
      ...sessionPorts(contract),
      pid: contract.pid,
      browserPid: typeof contract.browserPid === "number" ? contract.browserPid : null,
      profilePath,
      profileReused: typeof contract.profileReused === "boolean" ? contract.profileReused : null,
      waitedMs:
        typeof contract.browserUpNotAttachedWaitMs === "number"
          ? contract.browserUpNotAttachedWaitMs
          : null,
      browserUpNotAttachedAt: contract.browserUpNotAttachedAt,
      browserUpNotAttachedHint: hint,
      readyPath: ctx.readyPath,
      budgetMs: ctx.budgetMs,
      elapsedMs: ctx.elapsedMs,
      sayToPerson: said.sayToPerson,
      nextStep: {
        kind: "relaunch",
        tool: "extension_dev",
        args: {
          projectPath: ctx.projectPath,
          browser: ctx.browser,
          replace: true,
          profile,
        },
        say: wayOut,
      },
    },
    warnings: ctx.warnings,
    hint: said.hint,
  });
}

export function browserUpNotAttachedRelay(
  ready: Record<string, unknown>,
): NotAttachedRelay | null {
  if (ready.status !== "compiled-not-attached") return null;
  if (typeof ready.browserUpNotAttachedHint !== "string") return null;

  const nextStep = ready.nextStep as { say?: unknown } | undefined;
  const wayOut = typeof nextStep?.say === "string" ? nextStep.say : "";
  const said = sentences(ready.browserUpNotAttachedHint, wayOut);

  return {
    value: {
      browserUpNotAttachedHint: ready.browserUpNotAttachedHint,
      profilePath: ready.profilePath ?? null,
      profileReused: ready.profileReused ?? null,
      browserPid: ready.browserPid ?? null,
      waitedMs: ready.waitedMs ?? null,
      sayToPerson: said.sayToPerson,
      ...(nextStep ? { nextStep } : {}),
    },
    message: said.message,
    hint: said.hint,
  };
}

export function observedNotAttachedRelay(
  ready: Record<string, unknown>,
): NotAttachedRelay | null {
  if (ready.status !== "compiled-not-attached") return null;
  if (typeof ready.failedLegSays !== "string") return null;

  const nextStep = ready.nextStep as { say?: unknown } | undefined;
  if (typeof nextStep?.say !== "string") return null;

  return {
    value: {
      failedLeg: ready.failedLeg,
      failedLegSays: ready.failedLegSays,
      legs: ready.legs,
      sayToPerson: ready.sayToPerson,
      nextStep,
    },
    message: `The extension compiled, but the runtime executor never attached. ${ready.failedLegSays}`,
    hint: `${ready.failedLegSays} ${nextStep.say} ${REBUILD_NOT_REACHING_NOTE}`,
  };
}

export async function compiledNotAttachedAnswer(
  ctx: NotAttachedContext,
): Promise<string> {
  const signingFrame = await safariSigningFrame(ctx.projectPath, ctx.browser);
  const undiagnosed = isSafariTarget(ctx.browser) ? "" : `, and ${NO_ATTACH_DIAGNOSIS_NOTE}`;
  const observed = await observeAttachLegs(ctx.contract, ctx);
  const wayOut = observed.freshProfile ? wayOutSentence(observed.freshProfile) : null;

  return envelope({
    ok: false,
    command: ctx.command,
    status: "compiled-not-attached",
    error: {
      code: "E_NOT_ATTACHED",
      message: `The extension compiled, but the runtime executor never attached within this call's ${ctx.budgetMs}ms budget. The build is fine; the browser side is not connected, so extension_eval/storage/reload/open will fail with "no executor connected"${undiagnosed}.${observed.failedLegSays ? ` Read here instead: ${observed.failedLegSays}` : ""}${ctx.recovery ? ` ${ctx.recovery.say}` : ""} ${REBUILD_NOT_REACHING_NOTE}`,
    },
    value: {
      compiled: true,
      browserAttached: false,
      readyPath: ctx.readyPath,
      budgetMs: ctx.budgetMs,
      elapsedMs: ctx.elapsedMs,
      ...(observed.failedLeg ? { failedLeg: observed.failedLeg, failedLegSays: observed.failedLegSays } : {}),
      ...(Object.keys(observed.legs).length ? { legs: observed.legs } : {}),
      ...(ctx.recovery ? { executorRecovery: ctx.recovery } : {}),
      rebuildsReachBrowser: false,
      ...(observed.freshProfile && wayOut
        ? {
            sayToPerson: `${observed.failedLegSays} ${wayOut}`,
            nextStep: {
              kind: "relaunch",
              tool: "extension_dev",
              args: { projectPath: ctx.projectPath, browser: ctx.browser, replace: true, profile: observed.freshProfile },
              say: wayOut,
            },
          }
        : {}),
      ...(signingFrame ? { signing: signingFrame.signing } : {}),
    },
    warnings: [...(ctx.warnings ?? []), ...(signingFrame?.warnings ?? [])],
    hint: [
      observed.failedLegSays && wayOut
        ? `${observed.failedLegSays} ${wayOut}`
        : notAttachedHint(
            ctx.browser,
            findSessionInfo(ctx.projectPath, ctx.browser)?.enableExtension === true,
          ),
      ...(signingFrame?.hints ?? []),
    ].join(" "),
  });
}
