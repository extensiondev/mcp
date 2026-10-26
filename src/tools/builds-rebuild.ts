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
  dispatchedHint,
  linksOf,
  madeSentence,
  missedRead,
  stampNow,
  trackLinks,
  type Verdict,
} from "../lib/act-outcome";
import { consoleProjectUrl } from "../lib/registry";
import { envelope } from "../lib/envelope";
import { approvalRoundTrip } from "../lib/approval-outcome";
import {
  actionFingerprint,
  evaluateApproval,
  requestApprovalAfterRefusal,
  type ApprovalGateInput,
} from "../lib/approval-gate";
import { projectApiGet, projectApiSend, type ProjectApi, type ProjectApiRefusal } from "../lib/project-api";
import {
  BUILD_ENVS,
  COMMAND,
  actRefusal,
  badRequest,
  isRow,
  openFor,
  text,
  type ActArgs,
  type Row,
} from "./builds-acts";

const REBUILD_ACTION = "extension_builds.rebuild";
const FULL_SHA = /^[a-f0-9]{40}$/;

const REBUILD_CONSUMED_NEXT = 'The call that used it may already have started the run: read extension_builds (action: "list") first, and request a fresh approval only if no run for that commit is there.';

/* @invariant A REBUILD OF A COMMIT THAT ALREADY BUILT KEEPS ITS BUILD ID, SO
 * THE RUN IS WHAT TELLS THIS REBUILD FROM THE BUILD BEFORE IT. The platform
 * names the run when exactly one carries this dispatch's deployment id, and
 * otherwise hands back the deployment id and the dispatch time to match on.
 */
function runHandle(json: Row): { value: Row; match?: Row; sentence: string } {
  const deploymentId = text(json.deploymentId);
  const dispatchedAt = text(json.dispatchedAt);
  const runId = typeof json.runId === "number" && json.runId > 0 ? json.runId : undefined;
  const value: Row = {};

  if (deploymentId) value.deploymentId = deploymentId;
  if (dispatchedAt) value.dispatchedAt = dispatchedAt;
  if (runId) value.internal = { runId };

  const reused = "A rebuild keeps the same build id as the build before it, so";

  if (runId) {
    return {
      value,
      match: { internal: { runId } },
      sentence: `${reused} this rebuild is the one whose run.internal.runId in extension_builds get equals this answer's internal.runId; a build showing another one is the earlier run.`,
    };
  }

  if (deploymentId) {
    return {
      value,
      match: { deploymentId, ...(dispatchedAt ? { startedAfter: dispatchedAt } : {}) },
      sentence: `${reused} this rebuild is the one whose deploymentId reads ${deploymentId}${dispatchedAt ? `, or whose startedAt is after ${dispatchedAt}` : ""}; its run had not shown up when the platform answered.`,
    };
  }

  return { value, sentence: `${reused} a build showing a startedAt from before this call is the earlier run.` };
}

function judgeRebuild(detail: Row, match: Row | undefined, acceptedAt: string): Verdict {
  const run = isRow(detail.run) ? detail.run : {};
  const internal = isRow(run.internal) ? run.internal : isRow(detail.internal) ? detail.internal : {};
  const runId = typeof detail.runId === "number" ? detail.runId : typeof internal.runId === "number" ? internal.runId : null;
  const deploymentId = text(detail.deploymentId) || text(run.deploymentId);
  const startedAt = text(detail.startedAt) || text(run.startedAt) || text(detail.createdAt);
  const wantedRun = match && isRow(match.internal) && typeof match.internal.runId === "number" ? match.internal.runId : null;
  const wantedDeployment = match ? text(match.deploymentId) : "";
  const startedAfter = match ? text(match.startedAfter) : "";
  const matched = wantedRun !== null
    ? runId === wantedRun
    : wantedDeployment
      ? deploymentId === wantedDeployment || (Boolean(startedAt) && Boolean(startedAfter) && after(startedAt, startedAfter))
      : !startedAt || after(startedAt, acceptedAt);

  if (!matched) return { kind: "waiting", status: "earlier run" };

  const status = text(detail.status).toLowerCase();
  if (!status || PENDING_STATUSES.has(status)) return { kind: "waiting", status: status || null };
  if (FAILED_STATUSES.has(status)) return { kind: "recorded", status, failed: true };

  return { kind: "recorded", status };
}

const ALREADY_RUNNING_CODE = "BUILD_ALREADY_RUNNING";

const RUNNING_WORDS: Record<string, string> = {
  in_progress: "is already building",
  queued: "is already queued to build",
  starting: "was just pushed and its build is starting",
};

function judgeRunning(detail: Row, startedAfter: string): Verdict {
  const run = isRow(detail.run) ? detail.run : {};
  const startedAt = text(detail.startedAt) || text(run.startedAt) || text(detail.createdAt);

  if (startedAfter && startedAt && !after(startedAt, startedAfter)) return { kind: "waiting", status: "earlier run" };

  const status = text(detail.status).toLowerCase();
  if (!status || PENDING_STATUSES.has(status)) return { kind: "waiting", status: status || null };
  if (FAILED_STATUSES.has(status)) return { kind: "recorded", status, failed: true };

  return { kind: "recorded", status };
}

/* @invariant A REBUILD NEVER CANCELS THE BUILD IT ASKS FOR. The platform
 * answers BUILD_ALREADY_RUNNING, dispatching and spending nothing, when the
 * commit is already queued, running or starting from its push, because a
 * second build of it would cancel the first. That is the build this call
 * wanted, so the answer follows it like a rebuild of its own: the same build
 * page, the same bounded wait on the platform's record, and no success word
 * before the record shows one.
 */
async function alreadyRunning(sent: ProjectApiRefusal, args: ActArgs, api: ProjectApi, buildEnv: string, commitSha: string): Promise<string> {
  const body = isRow(sent.body) ? sent.body : {};
  const details = isRow(body.details) ? body.details : {};
  const commit = text(details.buildId) || text(details.commit) || commitSha.slice(0, 7).toLowerCase();
  const state = text(details.state) || "in_progress";
  const startedAt = text(details.startedAt) || null;
  const deploymentId = text(details.deploymentId);
  const project = `${api.ref.workspace}/${api.ref.project}`;
  const scope = args.project ? { project: args.project } : {};
  const base: Row = {
    action: "rebuild",
    project,
    commit,
    branch: text(details.branch) || null,
    buildEnv: buildEnv || "staging",
    dispatched: false,
    running: { state, startedAt, ...(deploymentId ? { deploymentId } : {}) },
    follow: {
      list: { action: "list", ...scope },
      get: { action: "get", buildId: commit, ...scope },
      logs: { action: "logs", buildId: commit, ...scope },
    },
    buildsPageUrl: consoleProjectUrl(api.ref, ConsoleProjectPage.builds, args.api),
  };
  const links = linksOf(trackLinks(COMMAND, { ...args, action: "rebuild", buildId: commit } as Row, "build-already-running", base).map((row) => (row.kind === "track" ? { ...row, kind: "build" as const } : row)));
  const buildPage = links.find((link) => link.kind === "build")?.url ?? String(base.buildsPageUrl);
  const startedAfter = state === "starting" && startedAt ? startedAt : "";
  const waited = await awaitRecordedOutcome<Row>({
    waitSeconds: args.waitSeconds,
    read: async () => {
      if (!commit) return { ok: false, message: "the platform named no commit for the running build, so its record cannot be read by build id" };

      const read = await projectApiGet<Row>(api, `builds/${encodeURIComponent(commit)}`);
      if (!read.ok) return missedRead(read);

      return { ok: true, record: isRow(read.json) ? read.json : {} };
    },
    judge: (detail) => judgeRunning(detail, startedAfter),
  });
  const value = { ...base, outcome: waited.outcome, links };
  const made = madeSentence(links);
  const readCall = `extension_builds (action: "get", buildId: "${commit}")`;
  const nothing = `Nothing was dispatched and nothing was spent: build ${commit} of ${project} ${RUNNING_WORDS[state] ?? RUNNING_WORDS.in_progress}${startedAt ? ` (since ${startedAt})` : ""}, and a second build of the same commit would cancel it.`;

  if (waited.failed) {
    return envelope({
      ok: false,
      command: COMMAND,
      status: "build-failed",
      value,
      error: { code: "E_PLATFORM", name: "BuildFailed", message: `The platform's record of build ${commit} reads ${waited.outcome.status}.` },
      hint: `${nothing} That build has now finished and failed: read extension_builds action:"logs" with buildId ${commit} for the failed browser and step, and the build page ${buildPage}. ${made}`,
    });
  }

  if (waited.outcome.recorded) {
    return envelope({
      ok: true,
      command: COMMAND,
      status: "built",
      value,
      hint: `${nothing} That build has now finished: the platform's record reads ${waited.outcome.status}; ${readCall} reads its artifacts and checks, and the build page is ${buildPage}. ${made}`,
    });
  }

  return envelope({
    ok: true,
    command: COMMAND,
    status: "build-already-running",
    value,
    hint: `${nothing} Follow it at ${buildPage}, or call ${readCall} to read where it is. Do not rebuild while it runs; rebuild it once it has finished if you still need another build. ${made}`,
  });
}

/* @invariant A REBUILD IS A REAL BUILD, ASKED FOR AS THE AGENT AND NEVER FORCED.
 * The dispatch spends the workspace's build allowance on real runners, so the
 * request names its origin as mcp for the meter, and never sends force: a
 * rebuild that would replace what a live channel serves is refused by the
 * platform, and that refusal says which environment to rebuild for instead.
 */
export async function rebuild(args: ActArgs): Promise<string> {
  const buildEnv = text(args.buildEnv).toLowerCase();

  if (buildEnv && !(BUILD_ENVS as readonly string[]).includes(buildEnv)) {
    return badRequest("rebuild", "BuildsInputError", `buildEnv must be ${BUILD_ENVS.join(" or ")}; got "${args.buildEnv}". Nothing was dispatched.`);
  }

  const commitSha = text(args.buildId);
  const approvalId = text(args.approvalId);

  if (approvalId && !FULL_SHA.test(commitSha.toLowerCase())) {
    return badRequest(
      "rebuild",
      "BuildsInputError",
      "A rebuild with an approvalId must name the full 40-character commit sha the approval was granted for, as buildId. Nothing was dispatched.",
    );
  }

  const opened = await openFor(args, "rebuild");
  if ("refused" in opened) return opened.refused;

  const api = opened.api;
  const body: Row = { origin: "mcp" };
  if (buildEnv) body.buildEnv = buildEnv;
  if (commitSha) body.commitSha = commitSha;

  const gateFor = (scope: { commit: string; buildEnv: string }): ApprovalGateInput => ({
    command: COMMAND,
    action: REBUILD_ACTION,
    scope,
    description: `Rebuild ${api.ref.workspace}/${api.ref.project} at ${scope.commit.slice(0, 7)} for ${scope.buildEnv}.`,
    token: api.token,
    api: args.api,
    refusedStatus: "rebuild-refused",
    body: { commitSha: scope.commit, buildEnv: scope.buildEnv },
    reason: `A rebuild is a plain act under the owner's own token, and the platform asked a workspace owner to approve this exact one before it runs. Call again with buildId ${scope.commit} and buildEnv ${scope.buildEnv} so the run matches what was approved.`,
    stateRead: 'extension_builds (action: "list") for the runs it started',
  });

  if (approvalId) {
    const gate = await evaluateApproval({
      ...gateFor({ commit: commitSha.toLowerCase(), buildEnv: buildEnv || "staging" }),
      approvalId,
      enabled: true,
    });
    if (gate.blocked) return gate.envelope;

    body.approvalId = approvalId;
  }

  const sent = await projectApiSend<Row>(api, "POST", "builds/dispatch", body);

  if (!sent.ok) {
    if (sent.code === ALREADY_RUNNING_CODE) return alreadyRunning(sent, args, api, buildEnv, commitSha);

    if (!approvalId && sent.code === "APPROVAL_REQUIRED") {
      const asked = isRow(sent.body) && isRow((sent.body as Row).approvalRequest) ? ((sent.body as Row).approvalRequest as Row) : {};
      const scope = isRow(asked.scope) ? (asked.scope as Row) : {};
      const wanted = { commit: text(scope.commit).toLowerCase(), buildEnv: text(scope.buildEnv) };

      if (
        text(asked.action) !== REBUILD_ACTION ||
        !FULL_SHA.test(wanted.commit) ||
        !wanted.buildEnv ||
        text(asked.fingerprint) !== actionFingerprint(REBUILD_ACTION, wanted)
      ) {
        return envelope({
          ok: false,
          command: COMMAND,
          status: "rebuild-refused",
          value: { action: "rebuild" },
          error: {
            code: "E_PLATFORM",
            name: "RebuildApprovalMismatch",
            message: "The platform asked for an approval this server cannot reproduce, so no approval was requested and nothing was dispatched.",
          },
        });
      }

      return requestApprovalAfterRefusal(gateFor(wanted));
    }

    const answered = approvalId
      ? approvalRoundTrip({
          command: COMMAND,
          platformCode: sent.code,
          message: sent.message,
          approvalId,
          undone: "Nothing was dispatched by this call.",
          api: args.api,
          value: { action: "rebuild" },
          next: { used: REBUILD_CONSUMED_NEXT },
          retryAfterSeconds: sent.retryAfterSeconds,
        })
      : undefined;

    if (answered) return answered;

    return actRefusal(sent, "rebuild", api, args, commitSha ? { buildId: commitSha } : {});
  }

  const commit = text(sent.json.commit) || commitSha;
  const browsers = text(sent.json.browsers).split(",").map((b) => b.trim()).filter(Boolean);
  const stripped = Array.isArray(sent.json.strippedBrowsers) ? sent.json.strippedBrowsers.map(text).filter(Boolean) : [];
  const project = `${api.ref.workspace}/${api.ref.project}`;
  const scope = args.project ? { project: args.project } : {};
  const run = runHandle(sent.json);
  const acceptedAt = text(sent.json.dispatchedAt) || stampNow();
  const base: Row = {
    action: "rebuild",
    project,
    commit,
    branch: text(sent.json.branch) || null,
    buildEnv: buildEnv || "staging",
    browsers,
    ...(stripped.length ? { strippedBrowsers: stripped } : {}),
    origin: text(sent.json.origin) || "mcp",
    ...run.value,
    follow: {
      list: { action: "list", ...scope },
      get: { action: "get", buildId: commit, ...scope },
      logs: { action: "logs", buildId: commit, ...scope },
      ...(run.match ? { match: run.match } : {}),
    },
    buildsPageUrl: consoleProjectUrl(api.ref, ConsoleProjectPage.builds, args.api),
  };
  const links = linksOf(trackLinks(COMMAND, { ...args, action: "rebuild", buildId: commit } as Row, "rebuild-dispatched", base).map((row) => (row.kind === "track" ? { ...row, kind: "build" as const } : row)));
  const buildPage = links.find((link) => link.kind === "build")?.url ?? String(base.buildsPageUrl);
  const readCall = `extension_builds (action: "get", buildId: "${commit || "<the new build>"}")`;
  const waited = await awaitRecordedOutcome<Row>({
    waitSeconds: args.waitSeconds,
    read: async () => {
      if (!commit) return { ok: false, message: "the platform named no commit for this rebuild, so its record cannot be read by build id" };

      const read = await projectApiGet<Row>(api, `builds/${encodeURIComponent(commit)}`);
      if (!read.ok) return missedRead(read);

      return { ok: true, record: isRow(read.json) ? read.json : {} };
    },
    judge: (detail) => judgeRebuild(detail, run.match, acceptedAt),
  });
  const made = madeSentence(links);
  const value = { ...base, outcome: waited.outcome, links };
  const started = `This started a real build for ${project} at ${commit || "the branch head"} (${buildEnv || "staging"}) on ${browsers.join(", ") || "the enabled browsers"}, and it counts against the workspace's build allowance.`;
  const stripWarning = stripped.length ? `The platform left out ${stripped.join(", ")}, which this plan does not build.` : null;

  if (waited.failed) {
    return envelope({
      ok: false,
      command: COMMAND,
      status: "build-failed",
      value,
      error: { code: "E_PLATFORM", name: "BuildFailed", message: `The platform's record of build ${commit} reads ${waited.outcome.status} after this rebuild.` },
      hint: `${started} The rebuild finished and failed: read extension_builds action:"logs" with buildId ${commit} for the failed browser and step, and the build page ${buildPage}. ${made}`,
      warnings: [stripWarning],
    });
  }

  if (waited.outcome.recorded) {
    return envelope({
      ok: true,
      command: COMMAND,
      status: "built",
      value,
      hint: `${started} The platform's record of build ${commit} now reads ${waited.outcome.status}; ${readCall} reads its artifacts and checks, and the build page is ${buildPage}. ${made}`,
      warnings: [stripWarning],
    });
  }

  return envelope({
    ok: true,
    command: COMMAND,
    status: "rebuild-dispatched",
    value,
    hint: `${dispatchedHint({ acceptedAt, trackUrl: buildPage, readCall })} ${started} It takes minutes: follow it with extension_builds action:"get" or action:"logs" with buildId ${commit || "<the new build>"}. ${run.sentence} Do not rebuild again to check on it. ${made}`,
    warnings: [stripWarning],
  });
}
