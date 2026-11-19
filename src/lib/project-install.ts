// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { descendantPids } from "./exec";
import { pidState, processStartedAt } from "./process-identity";
import { sessionStateDir } from "./process-manager";
import { liveProjectSessions } from "./session-browser";
import { engineProjectRoot } from "./session-paths";
import { modulesMissing, startingSession } from "./session-starting";

/* @invariant ONE DEPENDENCY INSTALL PER PROJECT AT A TIME, AND EVERY BUILD
 * KNOWS WHEN ONE IS RUNNING. The engine installs a project's dependencies
 * itself, on the first run that finds none, and it reads a node_modules that
 * holds any declared dependency as installed. So a build that starts while
 * an install is still writing that folder skips the install and runs against
 * half of it: on 2026-11-18 (ledger 941) that answered E_BUILD_FAILED "sh:
 * 1: extension: not found" with retry "no" in 5 agent runs, after the first
 * build of the pair had been stopped at its budget in the middle of npm
 * install. A build that will install takes this record first, a file made
 * with the exclusive flag under the session state folder, so a second call
 * in this process and a second server process on the same project both see
 * it. The record names the processes that hold the install: the server
 * while its call runs, then the engine process when the call ends at its
 * budget and leaves that engine running. A record whose holders are all gone
 * is stale and is removed by whoever reads it. A dev session that is still
 * installing counts as a running install too, read from the session itself.
 */

export interface InstallHolder {
  pid: number;
  startedAt: string | null;
  role: "server" | "engine";
}

export interface RunningInstall {
  pid: number;
  owner: "build-call" | "build-engine" | "session";
  browser?: string;
}

interface InstallRecord {
  projectRoot: string;
  since: string;
  holders: InstallHolder[];
}

export interface InstallTurn {
  release: () => void;
  handOver: (enginePid: number) => void;
}

export const INSTALL_WAIT_MS = 135_000;
export const INSTALL_POLL_MS = 1_000;

const callsInFlight = new Set<string>();
let ownStartedAt: string | null | undefined;

function projectKey(projectPath: string): string {
  const root = engineProjectRoot(projectPath);

  try {
    return fs.realpathSync(root);
  } catch {
    return path.resolve(root);
  }
}

export function installRecordPath(projectPath: string): string {
  const digest = crypto.createHash("sha256").update(projectKey(projectPath)).digest("hex").slice(0, 16);

  return path.join(sessionStateDir(), "installs", `${digest}.json`);
}

function readText(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

function parseRecord(text: string): InstallRecord | null {
  try {
    const parsed = JSON.parse(text) as Partial<InstallRecord>;

    return Array.isArray(parsed.holders) && typeof parsed.since === "string" ? (parsed as InstallRecord) : null;
  } catch {
    return null;
  }
}

function holds(holder: InstallHolder, key: string): boolean {
  if (typeof holder?.pid !== "number") return false;
  if (holder.role === "server" && holder.pid === process.pid) return callsInFlight.has(key);

  return pidState(holder.pid, holder.startedAt) === "alive";
}

function removeIfUnchanged(file: string, text: string): void {
  if (readText(file) === text) fs.rmSync(file, { force: true });
}

function recordedInstall(projectPath: string): RunningInstall | null {
  const file = installRecordPath(projectPath);
  const text = readText(file);
  if (text === null) return null;

  const key = projectKey(projectPath);
  const holder = parseRecord(text)?.holders.find((entry) => holds(entry, key));

  if (!holder) {
    removeIfUnchanged(file, text);

    return null;
  }

  return { pid: holder.pid, owner: holder.role === "engine" ? "build-engine" : "build-call" };
}

function sessionInstall(projectPath: string): RunningInstall | null {
  for (const session of liveProjectSessions(projectPath)) {
    const starting = startingSession(projectPath, session.browser);

    if (starting?.waitingOn === "dependency-install") return { pid: starting.pid, owner: "session", browser: session.browser };
  }

  return null;
}

export function runningInstall(projectPath: string): RunningInstall | null {
  return recordedInstall(projectPath) ?? sessionInstall(projectPath);
}

function writeWhole(file: string, record: InstallRecord, exclusive: boolean): void {
  const draft = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.draft`;

  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(draft, JSON.stringify(record));

  try {
    if (exclusive) fs.linkSync(draft, file);
    else fs.renameSync(draft, file);
  } finally {
    fs.rmSync(draft, { force: true });
  }
}

export function takeInstallTurn(projectPath: string): InstallTurn | "taken" | "unavailable" {
  const file = installRecordPath(projectPath);
  const key = projectKey(projectPath);

  if (callsInFlight.has(key) || recordedInstall(projectPath)) return "taken";

  ownStartedAt ??= processStartedAt(process.pid);

  const since = new Date().toISOString();
  const record = (holders: InstallHolder[]): InstallRecord => ({ projectRoot: key, since, holders });

  callsInFlight.add(key);

  try {
    writeWhole(file, record([{ pid: process.pid, startedAt: ownStartedAt, role: "server" }]), true);
  } catch (err) {
    callsInFlight.delete(key);

    return (err as NodeJS.ErrnoException)?.code === "EEXIST" ? "taken" : "unavailable";
  }

  let held = true;

  return {
    release: () => {
      if (!held) return;

      held = false;
      callsInFlight.delete(key);
      fs.rmSync(file, { force: true });
    },
    handOver: (enginePid) => {
      if (!held) return;

      held = false;

      try {
        writeWhole(file, record([{ pid: enginePid, startedAt: processStartedAt(enginePid), role: "engine" }]), false);
      } catch {
        fs.rmSync(file, { force: true });
      }

      callsInFlight.delete(key);
    },
  };
}

const PACKAGE_MANAGERS = new Set(["npm", "pnpm", "yarn", "bun", "deno"]);
const INSTALL_VERBS = new Set(["install", "i", "ci", "add"]);

function managerName(token: string): string {
  return path
    .basename(token)
    .replace(/\.(cmd|exe)$/i, "")
    .replace(/(-cli)?\.[cm]?js$/i, "");
}

export function isInstallCommand(commandLine: string): boolean {
  const tokens = commandLine.trim().split(/\s+/);
  const at = tokens.slice(0, 2).findIndex((token) => PACKAGE_MANAGERS.has(managerName(token)));

  return at !== -1 && INSTALL_VERBS.has(tokens[at + 1] ?? "");
}

function commandLine(pid: number): string {
  try {
    return execFileSync("ps", ["-o", "args=", "-p", String(pid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

export function installerUnder(pid: number): number | null {
  if (process.platform === "win32") return null;

  return descendantPids(pid).find((child) => isInstallCommand(commandLine(child))) ?? null;
}

export interface InstallTurnOutcome {
  turn: InstallTurn | null;
  waitedMs: number;
  waitedOn: RunningInstall | null;
  running: RunningInstall | null;
}

export async function installTurn(projectPath: string, waitBudgetMs: number = INSTALL_WAIT_MS): Promise<InstallTurnOutcome> {
  const began = Date.now();
  const outcome = (turn: InstallTurn | null, waitedOn: RunningInstall | null, running: RunningInstall | null): InstallTurnOutcome => ({
    turn,
    waitedMs: Date.now() - began,
    waitedOn,
    running,
  });
  let waitedOn: RunningInstall | null = null;

  for (;;) {
    const running = runningInstall(projectPath);

    if (!running) {
      if (!modulesMissing(projectPath)) return outcome(null, waitedOn, null);

      const turn = takeInstallTurn(projectPath);
      if (turn === "unavailable") return outcome(null, waitedOn, null);
      if (turn !== "taken") return outcome(turn, waitedOn, null);
    }

    waitedOn = running ?? waitedOn;

    if (Date.now() - began >= waitBudgetMs) return outcome(null, waitedOn, running);

    await sleep(INSTALL_POLL_MS);
  }
}

function seconds(ms: number): string {
  return ms < 1_000 ? `${ms} ms` : `${(ms / 1_000).toFixed(1)} s`;
}

function installOwnerWords(install: RunningInstall): string {
  if (install.owner === "session") return `the dev session on ${install.browser ?? "another browser"} (pid ${install.pid})`;
  if (install.owner === "build-engine") return `the engine an earlier extension_build call left running (pid ${install.pid})`;

  return `another extension_build call on this project (server pid ${install.pid})`;
}

export function installPidOf(install: RunningInstall): { installPid?: number } {
  return install.owner === "build-call" ? {} : { installPid: install.pid };
}

export const INSTALL_RUNNING_HINT =
  "Call extension_build again with the same arguments: it waits for this install to end, then builds. Do not start an install by hand and do not poll the process table; the next call does the waiting.";

export function installLeftRunningMessage(browser: string, budgetMs: number, enginePid: number): string {
  return `The build did not finish in ${budgetMs} ms because the engine is still installing the project's dependencies (pid ${enginePid}). Nothing was stopped: the install keeps running, and the ${browser} build follows it in the same process.`;
}

export function installStillRunningMessage(install: RunningInstall, waitedMs: number): string {
  return `Nothing was built: ${installOwnerWords(install)} is still installing this project's dependencies, and this call waited ${seconds(waitedMs)} for it to end.`;
}

export function waitedForInstallNote(install: RunningInstall, waitedMs: number): string {
  return `This call waited ${seconds(waitedMs)} for ${installOwnerWords(install)} to finish installing this project's dependencies before it built; one install runs on a project at a time.`;
}
