// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { execFileSync } from "node:child_process";
import fs from "node:fs";

import { envelope } from "./envelope";
import { pidState } from "./process-identity";
import { findSessionInfo } from "./process-manager";
import { isSafariTarget, notAttachedHint } from "./safari-dev-options";
import { parseSafariEngineSays } from "./safari-enable-log";

export type SafariAppStage = "converting" | "building" | "built" | "failed";

const STAGE_MARKERS: Array<[SafariAppStage, RegExp]> = [
  ["converting", /Converting the web extension into a Safari app project/g],
  ["building", /Building the Safari app with xcodebuild/g],
  ["built", /Built the Safari app\./g],
  ["failed", /xcodebuild failed \(exit|Safari packaging tool \S*xcodebuild/g],
];

export function parseSafariAppStage(log: string): SafariAppStage | null {
  let latest: { stage: SafariAppStage; at: number } | null = null;

  for (const [stage, marker] of STAGE_MARKERS) {
    for (const match of log.matchAll(marker)) {
      if (!latest || match.index >= latest.at) latest = { stage, at: match.index };
    }
  }

  return latest?.stage ?? null;
}

export function parseElapsedMs(etime: string): number | null {
  const match = etime.trim().match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/);
  if (!match) return null;

  const [, days = "0", hours = "0", minutes, seconds] = match;

  return (((Number(days) * 24 + Number(hours)) * 60 + Number(minutes)) * 60 + Number(seconds)) * 1000;
}

export interface XcodebuildRun {
  pid: number;
  elapsedMs: number | null;
}

export function findXcodebuildUnder(psOutput: string, rootPid: number): XcodebuildRun | null {
  const rows = psOutput
    .split("\n")
    .map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/))
    .filter((match): match is RegExpMatchArray => match !== null)
    .map(([, pid, ppid, etime, command]) => ({ pid: Number(pid), ppid: Number(ppid), etime: etime!, command: command! }));
  const tree = new Set([rootPid]);

  for (let grew = true; grew; ) {
    grew = false;

    for (const row of rows) {
      if (tree.has(row.ppid) && !tree.has(row.pid)) {
        tree.add(row.pid);
        grew = true;
      }
    }
  }

  const run = rows.find((row) => row.pid !== rootPid && tree.has(row.pid) && /(^|\/)xcodebuild(\s|$)/.test(row.command));

  return run ? { pid: run.pid, elapsedMs: parseElapsedMs(run.etime) } : null;
}

export const xcodebuildProbe = {
  processTable: (): string | null => {
    try {
      return execFileSync("ps", ["-Ao", "pid=,ppid=,etime=,command="], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
    } catch {
      return null;
    }
  },
};

export interface SafariAppBuilding {
  stage: "converting" | "building";
  xcodebuild: XcodebuildRun | null;
}

export function safariAppBuilding(projectPath: string, browser: string): SafariAppBuilding | null {
  if (!isSafariTarget(browser)) return null;

  const session = findSessionInfo(projectPath, browser);
  if (!session?.logPath || pidState(session.pid, session.processStartedAt) === "dead") return null;

  let log: string;

  try {
    log = fs.readFileSync(session.logPath, "utf8");
  } catch {
    return null;
  }

  const stage = parseSafariAppStage(log);
  if (stage !== "converting" && stage !== "building") return null;

  const table = xcodebuildProbe.processTable();

  return { stage, xcodebuild: table ? findXcodebuildUnder(table, session.pid) : null };
}

export function buildingAppSentence(building: SafariAppBuilding): string {
  const elapsed = building.xcodebuild?.elapsedMs;
  const running =
    building.stage === "converting"
      ? "The session is still converting the extension into a Safari app project, and the Xcode build comes next"
      : `The session is still building the Safari app with xcodebuild${typeof elapsed === "number" ? ` (running for ${Math.round(elapsed / 1000)} s)` : ""}`;

  return (
    `${running}, so Safari has not launched and the enable step has not run yet; nothing is wrong with it. ` +
    "Safari opens when the Xcode build finishes; a first (cold) Xcode build compiles its module caches and can take several minutes. Call extension_wait again."
  );
}

export function buildingAppAnswer(
  building: SafariAppBuilding,
  ctx: { command: string; readyPath: string; budgetMs: number; elapsedMs: number; warnings?: Array<string | null | undefined | false> },
): string {
  const sentence = buildingAppSentence(building);

  return envelope({
    ok: false,
    command: ctx.command,
    status: "building-app",
    error: { code: "E_SAFARI_APP_BUILDING", message: sentence },
    value: {
      compiled: true,
      browserAttached: false,
      appStage: building.stage,
      ...(building.xcodebuild ? { xcodebuildPid: building.xcodebuild.pid, xcodebuildElapsedMs: building.xcodebuild.elapsedMs } : {}),
      readyPath: ctx.readyPath,
      budgetMs: ctx.budgetMs,
      elapsedMs: ctx.elapsedMs,
    },
    warnings: ctx.warnings,
    hint: sentence,
  });
}

function readSessionLog(projectPath: string, browser: string): string {
  const session = findSessionInfo(projectPath, browser);
  if (!session?.logPath) return "";

  try {
    return fs.readFileSync(session.logPath, "utf8");
  } catch {
    return "";
  }
}

export function safariNotAttachedHint(projectPath: string, browser: string, enableExtension: boolean): string {
  const building = safariAppBuilding(projectPath, browser);
  if (building) return buildingAppSentence(building);

  const engineSays = isSafariTarget(browser) && enableExtension ? parseSafariEngineSays(readSessionLog(projectPath, browser)) : undefined;

  return notAttachedHint(browser, enableExtension, engineSays);
}
