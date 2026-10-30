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

export const CONFIGURED_SKIP_OUTCOMES = new Set(["BRANCH_FILTERED", "PATH_FILTERED", DOCS_ONLY, "PULL_REQUEST_BUILDS_OFF"]);

const SKIP_STEPS: Record<string, string> = {
  PATH_FILTERED: "none of its changed paths touched the project's root directory, so push a change inside it, or run extension_builds {action: \"rebuild\", buildId: \"<sha>\"} on it",
  BRANCH_FILTERED: "the branch is not the project's deployment branch, so push to that branch, clear the deployment branch in the project settings, or run extension_builds {action: \"rebuild\", buildId: \"<sha>\"} on it",
  PULL_REQUEST_BUILDS_OFF: "pull request builds are off for the project, so merge it to the deployment branch, or turn them on in the project settings",
  PUSH_BUILDS_EXHAUSTED: "the workspace's push builds for this month are spent; extension_workspace info reads the allowance",
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
