// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { ConsoleProjectPage } from "@extension.dev/urls/paths";

import {
  FAILED_STATUSES,
  PENDING_STATUSES,
  after,
  awaitRecordedOutcome,
  linksOf,
  madeSentence,
  missedRead,
  trackLinks,
  type ActLink,
  type ActOutcome,
  type Verdict,
} from "../lib/act-outcome";
import { buildName, buildNumberOf } from "../lib/builds-list-row";
import { consoleProjectUrl } from "../lib/registry";
import { envelope } from "../lib/envelope";
import { projectApiGet, type ProjectApi, type ProjectApiRefusal } from "../lib/project-api";
import { COMMAND, isRow, rebuildTarget, text, type ActArgs, type Row } from "./builds-acts";

export const ALREADY_RUNNING_CODE = "BUILD_ALREADY_RUNNING";

const RUNNING_WORDS: Record<string, string> = {
  in_progress: "is already building",
  queued: "is already queued to build",
  starting: "was just pushed and its build is starting",
};

export interface FinishedBuild {
  name: string;
  commit: string;
  state: string;
  startedAt: string | null;
  status: string;
  failed: boolean;
  outcome: ActOutcome;
}

interface RunningCall {
  sent: ProjectApiRefusal;
  args: ActArgs;
  api: ProjectApi;
  buildEnv: string;
  commitSha: string;
}

interface RunningRead {
  commit: string;
  state: string;
  startedAt: string | null;
  project: string;
  base: Row;
  links: ActLink[];
  buildPage: string;
  since: string;
}

function judgeRunning(detail: Row, startedAfter: string): Verdict {
  const run = isRow(detail.run) ? detail.run : {};
  const startedAt = text(detail.startedAt) || text(run.startedAt) || text(detail.createdAt);

  if (startedAfter && startedAt && !after(startedAt, startedAfter)) return { kind: "waiting", status: "earlier run" };

  const status = text(detail.status).toLowerCase();
  if (!status || PENDING_STATUSES.has(status)) return { kind: "waiting", status: status || null };
  if (FAILED_STATUSES.has(status)) return { kind: "recorded", status, failed: true };

  return { kind: "recorded", status };
}

function readRunning(call: RunningCall): RunningRead {
  const body = isRow(call.sent.body) ? call.sent.body : {};
  const details = isRow(body.details) ? body.details : {};
  const commit = text(details.buildId) || text(details.commit) || call.commitSha.slice(0, 7).toLowerCase();
  const state = text(details.state) || "in_progress";
  const startedAt = text(details.startedAt) || null;
  const deploymentId = text(details.deploymentId);
  const project = `${call.api.ref.workspace}/${call.api.ref.project}`;
  const scope = call.args.project ? { project: call.args.project } : {};
  const target = rebuildTarget(call.buildEnv);
  const base: Row = {
    action: "rebuild",
    project,
    commit,
    branch: text(details.branch) || null,
    buildEnv: target.buildEnv,
    channel: target.channel,
    dispatched: false,
    running: { state, startedAt, ...(deploymentId ? { deploymentId } : {}) },
    follow: {
      list: { action: "list", ...scope },
      get: { action: "get", buildId: commit, ...scope },
      logs: { action: "logs", buildId: commit, ...scope },
    },
    buildsPageUrl: consoleProjectUrl(call.api.ref, ConsoleProjectPage.builds, call.args.api),
  };
  const links = linksOf(
    trackLinks(COMMAND, { ...call.args, action: "rebuild", buildId: commit } as Row, "build-already-running", base).map((row) =>
      row.kind === "track" ? { ...row, kind: "build" as const } : row,
    ),
  );
  const buildPage = links.find((link) => link.kind === "build")?.url ?? String(base.buildsPageUrl);

  return { commit, state, startedAt, project, base, links, buildPage, since: startedAt ? ` (since ${startedAt})` : "" };
}

export function followedSentence(found: FinishedBuild): string {
  const since = found.startedAt ? ` (since ${found.startedAt})` : "";

  return `The platform first refused this call while ${found.name} ran${since}; that build has finished and its record reads ${found.status}, so this call sent the rebuild.`;
}

export async function followRunning(call: RunningCall): Promise<string | FinishedBuild> {
  const read = readRunning(call);
  const startedAfter = read.state === "starting" && read.startedAt ? read.startedAt : "";
  const waited = await awaitRecordedOutcome<Row>({
    waitSeconds: call.args.waitSeconds,
    read: async () => {
      if (!read.commit) return { ok: false, message: "the platform named no commit for the running build, so its record cannot be read by build id" };

      const got = await projectApiGet<Row>(call.api, `builds/${encodeURIComponent(read.commit)}`);
      if (!got.ok) return missedRead(got);

      return { ok: true, record: isRow(got.json) ? got.json : {} };
    },
    judge: (detail) => judgeRunning(detail, startedAfter),
  });
  const number = buildNumberOf(waited.record);
  const name = buildName(read.commit, number, "build");

  if (waited.outcome.recorded && waited.outcome.status) {
    return { name, commit: read.commit, state: read.state, startedAt: read.startedAt, status: waited.outcome.status, failed: waited.failed, outcome: waited.outcome };
  }

  const value = { ...read.base, ...(number ? { buildNumber: number } : {}), outcome: waited.outcome, links: read.links };
  const readCall = `extension_builds (action: "get", buildId: "${read.commit}")`;
  const target = rebuildTarget(call.buildEnv);

  return envelope({
    ok: true,
    command: COMMAND,
    status: "build-already-running",
    value,
    hint: `Nothing was dispatched and nothing was spent: ${name} of ${read.project} ${RUNNING_WORDS[read.state] ?? RUNNING_WORDS.in_progress}${read.since}, and a second build of the same commit would cancel it. Follow it at ${read.buildPage}, or call ${readCall} to read where it is. Do not rebuild while it runs; once it ends, call this again and the rebuild goes out. ${target.sentence} ${madeSentence(read.links)}`,
  });
}

export function heldAsRunning(call: RunningCall, found: FinishedBuild): string {
  const read = readRunning(call);
  const target = rebuildTarget(call.buildEnv);
  const value = {
    ...read.base,
    earlierBuild: { name: found.name, state: found.state, startedAt: found.startedAt, status: found.status },
    outcome: found.outcome,
    links: read.links,
  };

  return envelope({
    ok: false,
    command: COMMAND,
    status: "build-already-running",
    value,
    error: {
      code: "E_PLATFORM",
      name: "BuildsRefused",
      platformCode: ALREADY_RUNNING_CODE,
      message: `The platform refused this rebuild a second time as in flight (${read.state}${read.since}) while its own record of ${found.name} reads ${found.status}, so nothing was dispatched.`,
    },
    hint: `Nothing was dispatched and nothing was spent by either try. The platform's read of the run is behind its record of the build; call this again in a minute, or use Rebuild on the builds page ${String(read.base.buildsPageUrl)}, which offers Preview and Stable. ${target.sentence} ${madeSentence(read.links)}`,
  });
}
