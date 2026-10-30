// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import type { ProcessInfo } from "./types";

export interface RegistrationStamp {
  pid: number;
  at: number;
}

export interface LocalState {
  sessions: Map<string, ProcessInfo>;
  registrations: Map<string, RegistrationStamp>;
  extensionTargets: Map<string, string>;
  recoveredSessions: Set<string>;
}

export function createLocalState(): LocalState {
  return {
    sessions: new Map(),
    registrations: new Map(),
    extensionTargets: new Map(),
    recoveredSessions: new Set(),
  };
}

/* @invariant THE STATE A LOCAL SESSION LEAVES IN THIS PROCESS BELONGS TO THE
 * PROCESS, NOT TO THE BUILD THAT MADE IT. Until ledger 300 a rebuilt server
 * reloaded its platform code and left every local tool on the code it had
 * loaded, because the dev sessions it had spawned were registered in a Map
 * that lived in that module's scope: a reloaded build would have started
 * with an empty registry, its fork guard and extension_stop all:true blind
 * to the browsers already running, and the owner ran /mcp seven times in
 * three hours instead. The child processes themselves were never the
 * obstacle: a session is stopped by pid and found again through its marker
 * file, and the only handle a build keeps is the exit listener it attached
 * when it spawned, which keeps working in the generation that attached it.
 * So the registry, the remembered extension targets and the
 * one-recovery-per-session set are one object the first generation creates
 * and every rebuilt build adopts through the reload handover, by reference:
 * the generation that spawned a session and the generation answering the
 * next call read and write the same maps, and a build that cannot adopt it
 * (one without this contract) is told apart by the handover it echoes back,
 * so its local tools stay on the loaded code and say why.
 */
let state: LocalState = createLocalState();

export function localState(): LocalState {
  return state;
}

export function isLocalState(candidate: unknown): candidate is LocalState {
  if (!candidate || typeof candidate !== "object") return false;

  const row = candidate as Record<string, unknown>;

  return (
    row.sessions instanceof Map &&
    row.registrations instanceof Map &&
    row.extensionTargets instanceof Map &&
    row.recoveredSessions instanceof Set
  );
}

export function adoptLocalState(next: unknown): boolean {
  if (!isLocalState(next)) return false;

  state = next;

  return true;
}
