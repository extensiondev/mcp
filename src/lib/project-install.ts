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

import { noteCallWait } from "./call-waits";
import { envelope } from "./envelope";
import { descendantPids, runPackageInstall } from "./exec";
import { kernelCommandLine, pidState, processStartedAt } from "./process-identity";
import { sessionStateDir } from "./process-manager";
import { liveProjectSessions } from "./session-browser";
import { engineProjectRoot, readyContractPath } from "./session-paths";
import { modulesMissing, startingSession } from "./session-starting";
import { findWorkspaceMember, lockfileManager, pinnedManager } from "./workspace-member";

/* @invariant ONE DEPENDENCY INSTALL PER PROJECT AT A TIME, AND EVERY BUILD
 * KNOWS WHEN ONE IS RUNNING. The engine installs a project's dependencies
 * itself, on the first run that finds none, and it reads a node_modules that
 * holds any declared dependency as installed. So a build that starts while
 * an install is still writing that folder skips the install and runs against
 * half of it: on 2026-11-18 (ledger 941) that answered E_BUILD_FAILED "sh:
 * 1: extension: not found" with retry "no" in 5 agent runs, after the first
 * build of the pair had been stopped at its budget in the middle of npm
 * install. A build that will install takes this record first, a folder
 * under the session state folder that holds one file, so a second call in
 * this process and a second server process on the same project both see it.
 * The record names the processes that hold the install: the server
 * while its call runs, beside it the engine or package manager that call
 * started, from the moment that child has a PID, then the engine process
 * alone when the call ends at its budget and leaves that engine running. The
 * child is named at once under the moment it was spawned, which reads as its
 * start time within the tolerance, and again under the start time the
 * process table gives, so no read of that table stands between a spawn and
 * its record. A server killed in the middle of an install therefore leaves a
 * record its child still holds, and the next server waits for that install
 * instead of starting a second one in the same folder. A record whose
 * holders are all gone is stale and is removed by whoever reads it. A dev
 * session that is still installing counts as a running install too, read
 * from the session itself.
 *
 * ONE FOLDER HAS ONE RECORD, HOWEVER ITS PATH IS SPELLED. The record is
 * keyed by the path the operating system gives back for the folder, which
 * resolves a symlink and, on a disk that ignores case, the case the caller
 * typed; Windows paths are lowercased as well. Keyed by the path as typed,
 * /Users/x/App and /users/x/app held two records for one node_modules.
 *
 * AN INSTALL IS A PACKAGE MANAGER FOLLOWED BY ITS INSTALL VERB, WHEREVER IN
 * THE COMMAND LINE THE TWO SIT. The line is read as the kernel's own
 * argument list where /proc gives one, which keeps a path with a space in
 * one piece, and from ps otherwise. Read only at the first two words, a
 * Node path with a space, Yarn's yarn-4.5.0.cjs and an install run through
 * corepack all read as no install, and the engine above them was stopped at
 * its budget in the middle of one.
 *
 * NO STEP OF TAKING THE RECORD READS AND THEN ACTS. The record is taken by
 * renaming a folder that already holds its file onto the record's path,
 * which the file system refuses while a file is in the folder there. Each
 * taking names its file with its own random token, and a stale file is
 * removed under the name that was read, so a reader that judged an old
 * record stale can never remove the one a quicker server wrote in between.
 * The first version compared the text and then deleted the path, and four
 * servers released on one stale record shared it in 4 or 5 rounds of 250;
 * moving the record aside to compare it lost the put back more often still.
 *
 * EVERY TOOL THAT RUNS THE ENGINE SETTLES THE INSTALL FIRST, AND A FOLDER AN
 * INSTALL LEFT INCOMPLETE IS REPAIRED, NOT REPORTED AS A COMPILE ERROR
 * (ledger 948). extension_dev and extension_start wait on the same record
 * and, on a project with no node_modules, hand it to the session they
 * spawn, which holds it until that engine stamps its ready.json or, where
 * the process tree can be read, until node_modules is there and no package
 * manager runs under the engine. A folder
 * is incomplete when the extension package sits in node_modules with no
 * binary linked beside it, the state npx answers "extension: not found"
 * for, or when this server stopped an engine at its budget in the middle of
 * an install and left a note saying so. The server then reruns the install
 * itself under the record, with lifecycle scripts off as the engine runs
 * it, and an install that outlasts the call is left running, never killed.
 */

export interface InstallHolder {
  pid: number;
  startedAt: string | null;
  role: "server" | "engine" | "installer" | "session";
  browser?: string;
  readyPath?: string;
}

export interface RunningInstall {
  pid: number;
  owner: "build-call" | "build-engine" | "installer" | "session";
  browser?: string;
}

interface InstallRecord {
  projectRoot: string;
  since: string;
  holders: InstallHolder[];
}

export interface InstallTurn {
  release: () => void;
  join: (pid: number, role: "engine" | "installer") => void;
  handOver: (pid: number, as?: { role: "engine" | "installer" } | { role: "session"; browser: string; readyPath: string }) => void;
}

export const INSTALL_WAIT_MS = 135_000;
export const SESSION_INSTALL_WAIT_MS = 30_000;
export const REPAIR_BUDGET_MS = 180_000;
export const INSTALL_POLL_MS = 1_000;

const CONTRACT_MTIME_SLACK_MS = 2_000;
const callsInFlight = new Set<string>();
let ownStartedAt: string | null | undefined;

function projectKey(projectPath: string): string {
  const root = engineProjectRoot(projectPath);

  let key: string;

  try {
    key = fs.realpathSync.native(root);
  } catch {
    key = path.resolve(root);
  }

  return process.platform === "win32" ? key.toLowerCase() : key;
}

function recordStem(projectPath: string): string {
  const digest = crypto.createHash("sha256").update(projectKey(projectPath)).digest("hex").slice(0, 16);

  return path.join(sessionStateDir(), "installs", digest);
}

export function installRecordPath(projectPath: string): string {
  return `${recordStem(projectPath)}.lock`;
}

export function installStoppedPath(projectPath: string): string {
  return `${recordStem(projectPath)}.stopped`;
}

export function noteInstallStopped(projectPath: string): void {
  try {
    fs.mkdirSync(path.dirname(installStoppedPath(projectPath)), { recursive: true });
    fs.writeFileSync(installStoppedPath(projectPath), new Date().toISOString());
  } catch {
  }
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

function stampedSince(readyPath: string | undefined, since: string): boolean {
  if (!readyPath) return false;

  try {
    return fs.statSync(readyPath).mtimeMs >= Date.parse(since) - CONTRACT_MTIME_SLACK_MS;
  } catch {
    return false;
  }
}

function holds(holder: InstallHolder, key: string, since: string): boolean {
  if (typeof holder?.pid !== "number") return false;
  if (holder.role === "server" && holder.pid === process.pid) return callsInFlight.has(key);
  if (pidState(holder.pid, holder.startedAt) !== "alive") return false;

  if (holder.role !== "session") return true;
  if (stampedSince(holder.readyPath, since)) return false;

  return process.platform === "win32" || !fs.existsSync(path.join(key, "node_modules")) || installerUnder(holder.pid) !== null;
}

function recordEntries(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

function dropEmpty(dir: string): void {
  try {
    fs.rmdirSync(dir);
  } catch {
  }
}

const OWNER_OF_ROLE: Record<InstallHolder["role"], RunningInstall["owner"]> = {
  server: "build-call",
  engine: "build-engine",
  installer: "installer",
  session: "session",
};

function recordedInstall(projectPath: string): RunningInstall | null {
  const dir = installRecordPath(projectPath);
  const key = projectKey(projectPath);
  const entries = recordEntries(dir);

  for (const name of entries) {
    const file = path.join(dir, name);
    const record = name.endsWith(".json") ? parseRecord(readText(file) ?? "") : null;
    const holder = record?.holders.find((entry) => holds(entry, key, record.since));

    if (holder) return { pid: holder.pid, owner: OWNER_OF_ROLE[holder.role] ?? "build-call", ...(holder.browser ? { browser: holder.browser } : {}) };

    fs.rmSync(file, { force: true });
  }

  if (entries.length > 0) dropEmpty(dir);

  return null;
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

function claim(draft: string, dir: string): void {
  try {
    fs.renameSync(draft, dir);
  } catch {
    dropEmpty(dir);
    fs.renameSync(draft, dir);
  }
}

export function takeInstallTurn(projectPath: string): InstallTurn | "taken" | "unavailable" {
  const dir = installRecordPath(projectPath);
  const key = projectKey(projectPath);

  if (callsInFlight.has(key) || recordedInstall(projectPath)) return "taken";

  ownStartedAt ??= processStartedAt(process.pid);

  const since = new Date().toISOString();
  const token = crypto.randomBytes(8).toString("hex");
  const file = path.join(dir, `${token}.json`);
  const draft = `${dir}.${process.pid}.${token}.draft`;
  const own: InstallHolder = { pid: process.pid, startedAt: ownStartedAt, role: "server" };
  const text = (holders: InstallHolder[]): string => JSON.stringify({ projectRoot: key, since, holders } satisfies InstallRecord);

  callsInFlight.add(key);

  try {
    fs.mkdirSync(draft, { recursive: true });
    fs.writeFileSync(path.join(draft, `${token}.json`), text([own]));
    claim(draft, dir);
  } catch {
    callsInFlight.delete(key);
    fs.rmSync(draft, { recursive: true, force: true });

    return fs.existsSync(dir) ? "taken" : "unavailable";
  }

  let held = true;

  const rewrite = (holders: InstallHolder[]): void => {
    const next = `${draft}.json`;

    try {
      fs.writeFileSync(next, text(holders));
      fs.renameSync(next, file);
    } catch (err) {
      fs.rmSync(next, { force: true });

      throw err;
    }
  };

  const drop = (): void => {
    fs.rmSync(file, { force: true });
    dropEmpty(dir);
  };

  return {
    release: () => {
      if (!held) return;

      held = false;
      callsInFlight.delete(key);
      drop();
    },
    join: (pid, role) => {
      const name = (startedAt: string | null): void => {
        if (!held || startedAt === null) return;

        try {
          rewrite([own, { pid, startedAt, role }]);
        } catch {
        }
      };

      name(new Date().toISOString());
      name(processStartedAt(pid));
    },
    handOver: (pid, as = { role: "engine" }) => {
      if (!held) return;

      held = false;

      try {
        rewrite([{ pid, startedAt: processStartedAt(pid), ...as }]);
      } catch {
        drop();
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
    .replace(/(-cli)?\.[cm]?js$/i, "")
    .replace(/-\d[\w.-]*$/, "");
}

export function isInstallCommand(commandLine: string | string[]): boolean {
  const tokens = typeof commandLine === "string" ? commandLine.trim().split(/\s+/) : commandLine;

  return tokens.some((token, at) => PACKAGE_MANAGERS.has(managerName(token)) && INSTALL_VERBS.has(tokens[at + 1] ?? ""));
}

function commandLine(pid: number): string | string[] {
  const fromKernel = kernelCommandLine(pid);
  if (fromKernel) return fromKernel;

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

export interface IncompleteInstall {
  root: string;
  reason: "binary-missing" | "stopped";
}

const ENGINE_PACKAGE = "extension";
const ENGINE_BINARY = process.platform === "win32" ? "extension.cmd" : "extension";

function declaresEngine(root: string): boolean {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as Record<string, Record<string, unknown> | undefined>;

    return ENGINE_PACKAGE in (parsed.dependencies ?? {}) || ENGINE_PACKAGE in (parsed.devDependencies ?? {});
  } catch {
    return false;
  }
}

export function incompleteInstall(projectPath: string): IncompleteInstall | null {
  const root = engineProjectRoot(projectPath);

  if (fs.existsSync(installStoppedPath(projectPath))) return { root, reason: "stopped" };
  if (!declaresEngine(root)) return null;

  for (let dir = root; ; dir = path.dirname(dir)) {
    const modules = path.join(dir, "node_modules");

    if (fs.existsSync(path.join(modules, ENGINE_PACKAGE))) {
      return fs.existsSync(path.join(modules, ".bin", ENGINE_BINARY)) ? null : { root: dir, reason: "binary-missing" };
    }

    if (path.dirname(dir) === dir) return null;
  }
}

/* @invariant THE REPAIR RUNS THE INSTALL THE ENGINE WOULD RUN, WHERE THE
 * ENGINE WOULD RUN IT, OR NAMES IT AND RUNS NOTHING. A workspace member is
 * installed from its workspace root with the root's package manager, pnpm
 * filtered to the member, and a project outside any workspace by its own
 * lockfile, then its packageManager field, then npm, with pnpm confined to
 * the project (extension.js programs/develop/lib/package-manager.ts). The
 * first version read the lockfile of the one folder it was given and fell
 * back to npm: in a pnpm workspace member that is npm install, which fails
 * on "workspace:" or writes a package-lock.json and a nested tree into the
 * member, on every call. Yarn and Deno are named for the person to run, as
 * is a package manager that is not on the PATH this server runs with.
 */
export interface RepairPlan {
  cwd: string;
  manager: string;
  args: string[] | null;
}

function installsWithDeno(root: string): boolean {
  const has = (name: string): boolean => fs.existsSync(path.join(root, name));

  return has("deno.lock") || ((has("deno.json") || has("deno.jsonc")) && !has("package.json"));
}

function namesWorkspaceProtocol(root: string): boolean {
  try {
    return /"workspace:/.test(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  } catch {
    return false;
  }
}

export function repairPlan(projectRoot: string): RepairPlan {
  const member = findWorkspaceMember(projectRoot);
  const manager = member?.manager ?? lockfileManager(projectRoot) ?? pinnedManager(projectRoot) ?? (installsWithDeno(projectRoot) ? "deno" : "npm");
  const cwd = member?.root ?? projectRoot;

  if (manager === "yarn" || manager === "deno") return { cwd, manager, args: null };
  if (manager !== "pnpm") return { cwd, manager, args: ["install", "--ignore-scripts"] };
  if (member) return { cwd, manager, args: ["install", "--ignore-scripts", "--filter", `{${member.relativeDir}}...`] };

  const ownWorkspace = fs.existsSync(path.join(projectRoot, "pnpm-workspace.yaml")) || namesWorkspaceProtocol(projectRoot);

  return { cwd, manager, args: ["install", "--ignore-scripts", ...(ownWorkspace ? [] : ["--ignore-workspace"])] };
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
      if (!modulesMissing(projectPath) && !incompleteInstall(projectPath)) return outcome(null, waitedOn, null);

      const turn = takeInstallTurn(projectPath);
      if (turn === "unavailable") return outcome(null, waitedOn, null);
      if (turn !== "taken") return outcome(turn, waitedOn, null);
    }

    waitedOn = running ?? waitedOn;

    if (Date.now() - began >= waitBudgetMs) return outcome(null, waitedOn, running);

    await sleep(INSTALL_POLL_MS);
  }
}

export interface InstallRepair {
  root: string;
  ranIn: string;
  command: string;
  tookMs: number;
}

export interface InstallRefusal {
  root: string;
  installRoot: string;
  byHand: string;
  command: string | null;
  output: string;
  reason: "failed" | "not-rerun" | "manager-missing";
}

export type SettledInstall =
  | { state: "clear"; turn: InstallTurn | null; waitedMs: number; waitedOn: RunningInstall | null; repaired: InstallRepair | null }
  | { state: "running"; running: RunningInstall; waitedMs: number }
  | ({ state: "incomplete" } & InstallRefusal);

export async function settleInstall(
  projectPath: string,
  budgets: { waitMs: number; repairMs: number } = { waitMs: INSTALL_WAIT_MS, repairMs: REPAIR_BUDGET_MS },
): Promise<SettledInstall> {
  const outcome = await installTurn(projectPath, budgets.waitMs);

  if (outcome.running) return { state: "running", running: outcome.running, waitedMs: outcome.waitedMs };

  const incomplete = incompleteInstall(projectPath);
  const clear = (turn: InstallTurn | null, repaired: InstallRepair | null): SettledInstall => ({
    state: "clear",
    turn,
    waitedMs: outcome.waitedMs,
    waitedOn: outcome.waitedOn,
    repaired,
  });

  if (!incomplete || !outcome.turn) return clear(outcome.turn, null);

  const { turn } = outcome;
  const plan = repairPlan(engineProjectRoot(projectPath));

  const refusal = (reason: InstallRefusal["reason"], command: string | null, output: string): SettledInstall => {
    turn.release();

    return { state: "incomplete", root: incomplete.root, installRoot: plan.cwd, byHand: `${plan.manager} install`, command, output, reason };
  };

  if (!plan.args) {
    fs.rmSync(installStoppedPath(projectPath), { force: true });

    return refusal("not-rerun", null, "");
  }

  const began = Date.now();
  const said = `${plan.manager} ${plan.args.join(" ")}`;
  let result: Awaited<ReturnType<typeof runPackageInstall>>;

  try {
    result = await runPackageInstall(plan.manager, plan.args, {
      cwd: plan.cwd,
      timeoutMs: budgets.repairMs,
      onSpawn: (pid) => turn.join(pid, "installer"),
    });
  } catch (err) {
    turn.release();

    throw err;
  }

  if (result.notFound) {
    fs.rmSync(installStoppedPath(projectPath), { force: true });

    return refusal("manager-missing", null, "");
  }

  if (result.leftRunningPid) {
    fs.rmSync(installStoppedPath(projectPath), { force: true });
    turn.handOver(result.leftRunningPid, { role: "installer" });

    return { state: "running", running: { pid: result.leftRunningPid, owner: "installer" }, waitedMs: Date.now() - began };
  }

  if (result.code === 0) fs.rmSync(installStoppedPath(projectPath), { force: true });
  if (result.code !== 0 || incompleteInstall(projectPath)) return refusal("failed", said, result.output.trim().slice(-2000));

  const repaired = { root: incomplete.root, ranIn: plan.cwd, command: said, tookMs: Date.now() - began };

  if (modulesMissing(projectPath)) return clear(turn, repaired);

  turn.release();

  return clear(null, repaired);
}

function seconds(ms: number): string {
  return ms < 1_000 ? `${ms} ms` : `${(ms / 1_000).toFixed(1)} s`;
}

function installOwnerWords(install: RunningInstall): string {
  if (install.owner === "session") return `the ${install.browser ?? "other"} session (pid ${install.pid})`;
  if (install.owner === "build-engine") return `the engine an earlier extension_build call left running (pid ${install.pid})`;
  if (install.owner === "installer") return `the install an earlier call left running (pid ${install.pid})`;

  return `another extension_build call on this project (server pid ${install.pid})`;
}

export function installPidOf(install: RunningInstall): { installPid?: number } {
  return install.owner === "build-call" ? {} : { installPid: install.pid };
}

export function installRunningHint(command: string, then: string): string {
  return `Call ${command} again with the same arguments: it waits for this install to end, then ${then}. Do not start an install by hand and do not poll the process table; the next call does the waiting.`;
}

export const INSTALL_RUNNING_HINT = installRunningHint("extension_build", "builds");

export function installLeftRunningMessage(browser: string, budgetMs: number, enginePid: number): string {
  return `The build did not finish in ${budgetMs} ms because the engine is still installing the project's dependencies (pid ${enginePid}). Nothing was stopped: the install keeps running, and the ${browser} build follows it in the same process.`;
}

export function installStillRunningMessage(install: RunningInstall, waitedMs: number, nothing = "Nothing was built"): string {
  return `${nothing}: ${installOwnerWords(install)} is still installing this project's dependencies, and this call waited ${seconds(waitedMs)} for it to end.`;
}

export function waitedForInstallNote(install: RunningInstall, waitedMs: number, did = "built"): string {
  return `This call waited ${seconds(waitedMs)} for ${installOwnerWords(install)} to finish installing this project's dependencies before it ${did}; one install runs on a project at a time.`;
}

function ranWhere(root: string, ranIn: string): string {
  return ranIn === root ? "there" : `in ${ranIn}`;
}

export function repairedInstallNote(repair: InstallRepair, did = "building"): string {
  return `node_modules under ${repair.root} was left incomplete by an install that did not finish (the extension package was there with no binary linked, or this server had stopped an engine in the middle of installing), so this call ran ${repair.command} ${ranWhere(repair.root, repair.ranIn)} first (${seconds(repair.tookMs)}) before ${did}.`;
}

export function incompleteInstallMessage(refusal: InstallRefusal, nothing = "Nothing was built"): string {
  const found = `${nothing}: node_modules under ${refusal.root} is incomplete (an install did not finish)`;

  if (refusal.reason === "manager-missing") return `${found}, and ${refusal.byHand.split(" ")[0]}, which installs this project, is not on the PATH this server runs with.`;
  if (refusal.reason === "not-rerun") return `${found}, and this server does not rerun this project's package manager itself.`;

  return `${found}, and ${refusal.command}, which this call ran ${ranWhere(refusal.root, refusal.installRoot)} to repair it, did not complete it.`;
}

export function incompleteInstallHint(command: string, refusal: InstallRefusal): string {
  return refusal.reason === "failed"
    ? `Read value.output for the package manager's own report and fix what it names (the network, the registry or a dependency version), then call ${command} again: it reruns the install first. This is not a compile error.`
    : `Run ${refusal.byHand} in ${refusal.installRoot}, then call ${command} again. This is not a compile error.`;
}

export const INSTALL_STOPPED_HINT =
  "Call extension_build again with the same arguments: it reinstalls the dependencies first, then builds.";

export function installStoppedMessage(budgetMs: number, signal: string | null | undefined): string {
  return `This server stopped the build after ${budgetMs} ms (${signal ?? "a signal"}) while the engine was installing the project's dependencies, so that install was stopped with it and node_modules may be incomplete.`;
}

export interface SessionInstallGate {
  refusal?: string;
  spentMs: number;
  spawned: (pid: number | undefined, browser: string) => void;
}

export async function sessionInstallGate(command: string, projectPath: string): Promise<SessionInstallGate> {
  const began = Date.now();
  const install = await settleInstall(projectPath, { waitMs: SESSION_INSTALL_WAIT_MS, repairMs: SESSION_INSTALL_WAIT_MS });
  const idle = { spentMs: Date.now() - began, spawned: () => undefined };

  if (install.state === "running") {
    return {
      ...idle,
      refusal: envelope({
        ok: true,
        command,
        status: "installing",
        value: {
          started: false,
          waitingOn: "dependency-install",
          ...installPidOf(install.running),
          waitedMs: install.waitedMs,
          retry: "safe",
        },
        hint: `${installStillRunningMessage(install.running, install.waitedMs, "No session was started")} ${installRunningHint(command, "starts the session")}`,
      }),
    };
  }

  if (install.state === "incomplete") {
    return {
      ...idle,
      refusal: envelope({
        ok: false,
        command,
        status: "install-incomplete",
        error: {
          code: "E_CLI",
          name: "InstallIncomplete",
          message: incompleteInstallMessage(install, "No session was started"),
          retry: "safe",
        },
        value: { started: false, installRoot: install.installRoot, ...(install.command ? { installCommand: install.command } : {}), ...(install.output ? { output: install.output } : {}) },
        hint: incompleteInstallHint(command, install),
      }),
    };
  }

  if (install.waitedOn) noteCallWait(waitedForInstallNote(install.waitedOn, install.waitedMs, "started the session"));
  if (install.repaired) noteCallWait(repairedInstallNote(install.repaired, "starting the session"));

  const { turn } = install;

  return {
    spentMs: install.waitedOn || install.repaired ? Date.now() - began : 0,
    spawned: (pid, browser) => {
      if (pid === undefined) turn?.release();
      else turn?.handOver(pid, { role: "session", browser, readyPath: readyContractPath(projectPath, browser) });
    },
  };
}
