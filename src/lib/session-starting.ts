// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import fs from "node:fs";
import path from "node:path";

import { contractPidState } from "./contract-pids";
import { envelope } from "./envelope";
import { findSessionInfo, sessionSinceMs } from "./process-manager";
import { pidState } from "./process-identity";
import { liveProjectSessions, resolveSessionBrowser } from "./session-browser";
import { engineProjectRoot, readyContractPath } from "./session-paths";
import { declaredDependencyNames, findWorkspaceMember } from "./workspace-member";

import type { ReadyContract } from "./types";

export const CONTRACT_MTIME_GRANULARITY_SLACK_MS = 2_000;

export type StartingWaitingOn = "dependency-install" | "first-compile" | "engine-start";

export interface StartingSession {
  browser: string;
  pid: number;
  waitingOn: StartingWaitingOn;
  readyPath: string;
}

const INSTALL_LINE = /Installing (?:the )?(?:project )?dependencies/i;
const LOG_TAIL_BYTES = 16_384;

function logTail(logPath: string | undefined): string {
  if (!logPath) return "";

  try {
    const size = fs.statSync(logPath).size;
    const length = Math.min(size, LOG_TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    const fd = fs.openSync(logPath, "r");

    try {
      fs.readSync(fd, buffer, 0, length, size - length);
    } finally {
      fs.closeSync(fd);
    }

    return buffer.toString("utf8");
  } catch {
    return "";
  }
}

/* @invariant A PROJECT NEEDS AN INSTALL EXACTLY WHEN THE ENGINE WOULD RUN
 * ONE. The engine installs when the project declares a dependency and none
 * of them is in its node_modules, unless that folder is a pnpm or Deno
 * store, and for a workspace member also when none is hoisted to the
 * workspace root (extension.js programs/develop/lib/paths.ts needsInstall).
 * The first version asked only whether node_modules existed: a folder that
 * held nothing but .cache read as installed, so two builds installed at
 * once with no record between them, and a hoisted member, which never has a
 * node_modules of its own, took the record on every build and read as
 * "installing dependencies" for as long as its session started.
 */
const INSTALLED_STORE_MARKS = [".pnpm", ".modules.yaml", ".deno"];

export function modulesMissing(projectPath: string): boolean {
  const root = engineProjectRoot(projectPath);
  const declared = declaredDependencyNames(root);
  if (declared.length === 0) return false;

  const modules = path.join(root, "node_modules");
  const holds = (dir: string, names: string[]): boolean => names.some((name) => fs.existsSync(path.join(dir, name)));

  if (holds(modules, INSTALLED_STORE_MARKS) || holds(modules, declared)) return false;

  const member = findWorkspaceMember(root);

  return !member || !holds(path.join(member.root, "node_modules"), declared);
}

function beforeTheContract(projectPath: string, logPath: string | undefined): StartingWaitingOn {
  return INSTALL_LINE.test(logTail(logPath)) || modulesMissing(projectPath) ? "dependency-install" : "engine-start";
}

function freshContract(projectPath: string, browser: string, readyPath: string): ReadyContract | null {
  try {
    const stat = fs.statSync(readyPath);
    const since = sessionSinceMs(projectPath, browser);
    if (since !== null && stat.mtimeMs < since - CONTRACT_MTIME_GRANULARITY_SLACK_MS) return null;

    return JSON.parse(fs.readFileSync(readyPath, "utf8")) as ReadyContract;
  } catch {
    return null;
  }
}

/* @invariant A DEV SESSION THAT EXISTS AND HAS NOT COMPILED YET IS "STARTING",
 * AND EVERY TOOL SAYS SO THE SAME WAY (ledger 922). Starting means: a dev
 * session is recorded for the project and browser, by this server's registry
 * or its marker, its process is alive, and the engine's ready.json is either
 * not stamped for this run yet or stamped with status "starting". A contract
 * stamped "starting" by a live engine this server did not spawn (a session
 * run by hand) counts too. Ready, error and stopped contracts are not
 * starting, and neither is a production session: each has its own answer.
 * What the session is waiting on is read, never guessed: a contract stamped
 * "starting" is the first compile; before the contract, the engine's install
 * line in the session log or a package.json that declares dependencies
 * beside no node_modules is the dependency install; anything else is the engine starting. In the live
 * smoke of 2026-11-18 this window lasted 20 to 95 seconds on a fresh
 * project, and the session tools answered it as "no session", "eval
 * disabled" and "no logs", each with a hint to start or replace the session
 * that was about to be ready.
 */
export function startingSession(projectPath: string, browser: string): StartingSession | null {
  const readyPath = readyContractPath(projectPath, browser);
  const contract = freshContract(projectPath, browser, readyPath);

  if (contract && contract.status !== "starting") return null;
  if (contract && contract.command !== undefined && contract.command !== "dev") return null;

  const info = findSessionInfo(projectPath, browser);

  if (info) {
    if (info.command !== "dev" || pidState(info.pid, info.processStartedAt) !== "alive") return null;

    return {
      browser,
      pid: info.pid,
      waitingOn: contract ? "first-compile" : beforeTheContract(projectPath, info.logPath),
      readyPath,
    };
  }

  if (!contract || typeof contract.pid !== "number") return null;
  if (contractPidState(projectPath, browser, contract, "engine") !== "alive") return null;

  return { browser, pid: contract.pid, waitingOn: "first-compile", readyPath };
}

const WAITING_ON_WORDS: Record<StartingWaitingOn, string> = {
  "dependency-install": "installing the project's dependencies, which a first run does before it compiles",
  "first-compile": "compiling for the first time",
  "engine-start": "starting its engine, which has not stamped ready.json yet",
};

export function startingSentence(starting: StartingSession, projectPath: string): string {
  return `The dev session for ${projectPath} on ${starting.browser} (pid ${starting.pid}) is still starting: it is ${WAITING_ON_WORDS[starting.waitingOn]}.`;
}

export const FIRST_RUN_NOTE = "A first run installs dependencies and can take a couple of minutes.";
export const SOURCE_NOT_LOADABLE_NOTE =
  "Do not load the source folder into a browser yourself: it cannot run unbuilt, because the build is what resolves the imports in its content scripts.";

export function sessionStartingEnvelope(command: string, projectPath: string, starting: StartingSession): string {
  return envelope({
    ok: false,
    command,
    status: "starting",
    error: {
      code: "E_SESSION_STARTING",
      name: "SessionStarting",
      message: `${startingSentence(starting, projectPath)} Nothing ran.`,
      retry: "safe",
    },
    value: {
      projectPath,
      browser: starting.browser,
      pid: starting.pid,
      waitingOn: starting.waitingOn,
      readyPath: starting.readyPath,
    },
    hint: `Call extension_wait with this projectPath and browser: "${starting.browser}", then call ${command} again. ${FIRST_RUN_NOTE} The session exists: do not start or replace it.`,
  });
}

function namedBrowser(args: Record<string, unknown>): string | undefined {
  return typeof args.browser === "string" && args.browser.trim() ? args.browser : undefined;
}

export function sessionStartingRefusal(command: string, args: Record<string, unknown>): string | null {
  const projectPath = typeof args.projectPath === "string" && args.projectPath.trim() ? args.projectPath : null;
  if (!projectPath) return null;

  const explicit = namedBrowser(args);
  const { browser } = resolveSessionBrowser(projectPath, explicit);
  const starting = startingSession(projectPath, browser);

  if (!starting) return null;
  if (!explicit && liveProjectSessions(projectPath).length > 1) return null;

  return sessionStartingEnvelope(command, projectPath, starting);
}
