// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { isoSeconds, isRow, text } from "./builds-list-row";

const SHA_PREFIX = 7;

export const DOCS_ONLY = "DOCS_ONLY";

export const QUOTA_EXCEEDED = "QUOTA_EXCEEDED";

export const PUSH_BUILDS_EXHAUSTED = "PUSH_BUILDS_EXHAUSTED";

export const CONFIGURED_SKIP_OUTCOMES = new Set(["BRANCH_FILTERED", "PATH_FILTERED", DOCS_ONLY, "PULL_REQUEST_BUILDS_OFF"]);

export const REFUSED_OUTCOMES = new Set([QUOTA_EXCEEDED, PUSH_BUILDS_EXHAUSTED]);

const SKIP_STEPS: Record<string, string> = {
  PATH_FILTERED: "none of its changed paths touched the project's root directory, so push a change inside it, or run extension_builds {action: \"rebuild\", buildId: \"<sha>\"} on it",
  BRANCH_FILTERED: "the branch is not the project's deployment branch, so push to that branch, clear the deployment branch in the project settings, or run extension_builds {action: \"rebuild\", buildId: \"<sha>\"} on it",
  PULL_REQUEST_BUILDS_OFF: "pull request builds are off for the project, so merge it to the deployment branch, or turn them on in the project settings",
  PUSH_BUILDS_EXHAUSTED: "the workspace's push builds for this month are spent; extension_workspace info reads the allowance",
  QUOTA_EXCEEDED: "the workspace's monthly build cap refused it; extension_workspace info reads the allowance",
  DISPATCH_DISABLED: "build dispatch is paused on the platform; push again once extension_builds no longer reports dispatch disabled",
  FORK_PULL_REQUEST: "pull requests from forks are never built; push the commit to the project's own repository",
};

export interface HeadPush {
  commit: string;
  outcome: string;
  receivedAt: string;
  dispatched: boolean;
}

function sameSha(a: string, b: string): boolean {
  return a.length >= SHA_PREFIX && b.length >= SHA_PREFIX && (a.startsWith(b) || b.startsWith(a));
}

export function headPushOf(lastPush: unknown, head: string): HeadPush | null {
  if (!isRow(lastPush)) return null;

  const commit = text(lastPush.commit).toLowerCase();
  if (!sameSha(commit, head.toLowerCase())) return null;

  return {
    commit,
    outcome: text(lastPush.outcome).toUpperCase(),
    receivedAt: isoSeconds(lastPush.receivedAt),
    dispatched: lastPush.dispatched === true,
  };
}

export function isDocsOnly(push: HeadPush | null): push is HeadPush {
  return push !== null && push.outcome === DOCS_ONLY && !push.dispatched;
}

export function docsOnlySentence(subject: string, reads: string, newest: string): string {
  return `${subject} changes docs only; ${reads} ${newest}, the newest build, which carries the same package`;
}

function received(push: HeadPush): string {
  return push.receivedAt ? ` (received ${push.receivedAt})` : "";
}

export function skippedPushSentence(push: HeadPush, subject: string): string {
  const verb = CONFIGURED_SKIP_OUTCOMES.has(push.outcome) ? "skipped it" : "did not build it";
  const step = SKIP_STEPS[push.outcome] ?? "extension_builds says what happened to the push";

  return `${subject} was pushed${received(push)} and the platform ${verb} as ${push.outcome}: ${step.replace("<sha>", push.commit.slice(0, SHA_PREFIX))}`;
}

export function dispatchedPushSentence(push: HeadPush, subject: string): string {
  return `${subject} was pushed${received(push)} and the platform dispatched it, but its build is not on the list yet; extension_builds lists it once the run is recorded`;
}

export interface BuildCap {
  used: number | null;
  limit: number | null;
  month: string;
}

export function capResetsAt(month: string): string | null {
  const match = /^(\d{4})-(\d{2})$/.exec(month.trim());
  if (!match) return null;

  const index = Number(match[2]);
  if (index < 1 || index > 12) return null;

  return new Date(Date.UTC(Number(match[1]), index, 1)).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function capReason(push: HeadPush, cap: BuildCap | null): string {
  const resets = cap ? capResetsAt(cap.month) : null;
  const reset = resets ? `; the cap resets ${resets}` : "";

  if (push.outcome === PUSH_BUILDS_EXHAUSTED) return `as ${push.outcome}: the workspace's push builds for this month are spent${reset} (extension_workspace info reads the allowance)`;
  if (cap && cap.used !== null && cap.limit !== null && cap.used >= cap.limit) return `over the monthly build cap (${cap.used} of ${cap.limit} builds this month${reset})`;

  const counts = cap && cap.used !== null && cap.limit !== null ? ` while ${cap.used} of ${cap.limit} builds this month are used` : "";

  return `as ${push.outcome} (the platform's build counter refused the dispatch${counts}; extension_workspace info reads the allowance)`;
}

export function refusedPushSentence(push: HeadPush, subject: string, cap: BuildCap | null, newest: string | null): string {
  const submittable = newest ? `the newest submittable build is ${newest}` : "no completed build is listed to submit";

  return `${subject} was pushed${received(push)} and the platform refused it ${capReason(push, cap)}; ${submittable}`;
}
