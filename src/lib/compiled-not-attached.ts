// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import path from "node:path";

import { envelope, sessionCommandSinceEnvelopeOwnsCommand } from "./envelope";
import { findSessionInfo } from "./process-manager";
import { isSafariTarget, notAttachedHint } from "./safari-dev-options";
import { safariSigningFrame } from "./safari-signing";
import { browserProfileRootDir } from "./session-paths";
import { sessionPorts } from "./session-ports";

import type { ReadyContract } from "./types";

export const NO_ATTACH_DIAGNOSIS_NOTE =
  "the engine running here reports no attach diagnosis; update Extension.js to read why";

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

export async function compiledNotAttachedAnswer(
  ctx: NotAttachedContext,
): Promise<string> {
  const signingFrame = await safariSigningFrame(ctx.projectPath, ctx.browser);
  const undiagnosed = isSafariTarget(ctx.browser) ? "" : `, and ${NO_ATTACH_DIAGNOSIS_NOTE}`;

  return envelope({
    ok: false,
    command: ctx.command,
    status: "compiled-not-attached",
    error: {
      code: "E_NOT_ATTACHED",
      message: `The extension compiled, but the runtime executor never attached within this call's ${ctx.budgetMs}ms budget. The build is fine; the browser side is not connected, so extension_eval/storage/reload/open will fail with "no executor connected"${undiagnosed}.`,
    },
    value: {
      compiled: true,
      browserAttached: false,
      readyPath: ctx.readyPath,
      budgetMs: ctx.budgetMs,
      elapsedMs: ctx.elapsedMs,
      ...(signingFrame ? { signing: signingFrame.signing } : {}),
    },
    warnings: [...(ctx.warnings ?? []), ...(signingFrame?.warnings ?? [])],
    hint: [
      notAttachedHint(
        ctx.browser,
        findSessionInfo(ctx.projectPath, ctx.browser)?.enableExtension === true,
      ),
      ...(signingFrame?.hints ?? []),
    ].join(" "),
  });
}
