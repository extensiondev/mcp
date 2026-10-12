// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { envelope } from "../lib/envelope";
import { projectApiGet, projectApiReadFailure } from "../lib/project-api";
import { isRow, text } from "../lib/ship-act";
import { openFor, type Scope } from "./release-history";

const COMMAND = "extension_release_status";

type Row = Record<string, unknown>;

export async function readPromotionRuns(scope: Scope & { since?: string }): Promise<string> {
  const opened = await openFor(scope, "PromotionRuns");
  if (!opened.ok) return opened.out;

  const api = opened.api;
  const where = { workspace: api.ref.workspace, project: api.ref.project };
  const read = await projectApiGet<Row>(api, "releases/promotion-runs", { since: text(scope.since) || undefined });

  if (!read.ok) return projectApiReadFailure(COMMAND, read, { api: scope.api, name: "PromotionRuns", value: where });

  const recent = (Array.isArray(read.json.recent) ? read.json.recent : []).filter(isRow);
  const degraded = read.json.degraded === true;

  return envelope({
    ok: true,
    command: COMMAND,
    status: "read",
    value: { ...where, since: text(read.json.since) || null, recent, ...(degraded ? { degraded: true } : {}) },
    hint: recent.length
      ? `The ${recent.length} newest release workflow runs since ${text(read.json.since)}, newest first; a promote or a rollback starts one per browser.`
      : `No release workflow ran since ${text(read.json.since) || "the start of the window"}. Pass since (up to 30 days back) to look further.`,
    warnings: [degraded ? "The platform could not list the runs just now, so an empty list here is unknown, not empty." : null],
  });
}

export async function readRollout(scope: Scope): Promise<string> {
  const opened = await openFor(scope, "Rollout");
  if (!opened.ok) return opened.out;

  const api = opened.api;
  const where = { workspace: api.ref.workspace, project: api.ref.project };
  const read = await projectApiGet<Row>(api, "stores/chrome/rollout");

  if (!read.ok) return projectApiReadFailure(COMMAND, read, { api: scope.api, name: "Rollout", value: where });

  const rollout = isRow(read.json.rollout) ? read.json.rollout : null;
  const percentage = rollout && typeof rollout.percentage === "number" ? rollout.percentage : null;

  return envelope({
    ok: true,
    command: COMMAND,
    status: "read",
    value: { ...where, store: "chrome", rollout },
    hint: !rollout
      ? "The platform reports no Chrome rollout state for this project."
      : rollout.stagedPublish !== true
        ? "Chrome publishes this project to everyone at once; there is no staged rollout to raise."
        : rollout.canRaise === true
          ? `Chrome's staged rollout serves ${percentage}% of users; extension_submit (action: "rollout", deployPercentage) raises it, with an owner's approval.`
          : `Chrome's staged rollout serves ${percentage === null ? "an unknown share" : `${percentage}%`} of users and cannot be raised from here.`,
  });
}

export async function readCutReadiness(scope: Scope): Promise<string> {
  const opened = await openFor(scope, "Cut");
  if (!opened.ok) return opened.out;

  const api = opened.api;
  const where = { workspace: api.ref.workspace, project: api.ref.project };
  const read = await projectApiGet<Row>(api, "releases/cut");

  if (!read.ok) return projectApiReadFailure(COMMAND, read, { api: scope.api, name: "Cut", value: where });

  const allowed = read.json.allowed === true;

  return envelope({
    ok: true,
    command: COMMAND,
    status: "read",
    value: { ...where, allowed, limit: read.json.limit ?? null, used: read.json.used ?? null, dispatchDisabled: read.json.dispatchDisabled === true },
    hint: allowed
      ? 'A release pull request opened now could build after merging. extension_release_promote (action: "cut") opens one, with an owner\'s approval.'
      : read.json.dispatchDisabled === true
        ? "Build dispatch is paused for every project, so a release pull request opened now could not build after merging."
        : "The workspace's build allowance is spent, so a release pull request opened now could not build after merging.",
  });
}
