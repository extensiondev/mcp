// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { AsyncLocalStorage } from "node:async_hooks";

import type { StoredCredentials } from "./credentials";

const scope = new AsyncLocalStorage<StoredCredentials>();

export function withApprovalLogin<T>(login: StoredCredentials | null, run: () => T): T {
  return login ? scope.run(login, run) : run();
}

export function approvalLogin(): StoredCredentials | null {
  return scope.getStore() ?? null;
}

const answered = new AsyncLocalStorage<string>();

export function withAnsweredProject<T>(ref: string | null | undefined, run: () => T): T {
  const project = String(ref ?? "").trim();

  return project ? answered.run(project, run) : run();
}

export function answeredProject(): string {
  return answered.getStore() ?? "";
}
