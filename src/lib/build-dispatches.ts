// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { isoSeconds } from "./builds-list-row";

export interface BuildDispatch {
  sha: string;
  dispatchedAt: string;
}

export interface DispatchScope {
  base: string;
  projectId: string;
}

export const UNRECORDED_BACKOFF_START_SECONDS = 3;
export const UNRECORDED_BACKOFF_CAP_SECONDS = 15;

const DISPATCHES_PER_PROJECT = 32;
const PROJECTS_LIMIT = 128;

const dispatches = new Map<string, BuildDispatch[]>();

function scopeKey(scope: DispatchScope): string {
  return `${scope.base}\n${scope.projectId}`;
}

export function sameSha(a: string, b: string): boolean {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  if (Math.min(x.length, y.length) < 7) return x === y && x.length > 0;

  return x.startsWith(y) || y.startsWith(x);
}

export function rememberBuildDispatch(scope: DispatchScope, sha: string, dispatchedAt: string): void {
  const key = scopeKey(scope);
  const clean = sha.trim().toLowerCase();
  if (!clean) return;

  const kept = (dispatches.get(key) ?? []).filter((entry) => !sameSha(entry.sha, clean));
  kept.unshift({ sha: clean, dispatchedAt: isoSeconds(dispatchedAt) || dispatchedAt });
  dispatches.delete(key);
  dispatches.set(key, kept.slice(0, DISPATCHES_PER_PROJECT));

  for (const oldest of dispatches.keys()) {
    if (dispatches.size <= PROJECTS_LIMIT) break;

    dispatches.delete(oldest);
  }
}

export function buildDispatchOf(scope: DispatchScope, sha: string): BuildDispatch | null {
  const clean = sha.trim();
  if (!clean) return null;

  return (dispatches.get(scopeKey(scope)) ?? []).find((entry) => sameSha(entry.sha, clean)) ?? null;
}

export function latestBuildDispatch(scope: DispatchScope): BuildDispatch | null {
  return dispatches.get(scopeKey(scope))?.[0] ?? null;
}

export function forgetBuildDispatch(scope: DispatchScope, sha: string): void {
  const key = scopeKey(scope);
  const kept = (dispatches.get(key) ?? []).filter((entry) => !sameSha(entry.sha, sha));

  if (kept.length) dispatches.set(key, kept);
  else dispatches.delete(key);
}

export function unrecordedBackoffSeconds(miss: number): number {
  return Math.min(UNRECORDED_BACKOFF_CAP_SECONDS, UNRECORDED_BACKOFF_START_SECONDS * 2 ** Math.max(0, miss));
}

export function unrecordedGetCall(sha: string, waitSeconds = 300): string {
  return `extension_builds (action: "get", buildId: "${sha}", waitSeconds: ${waitSeconds})`;
}
