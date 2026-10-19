// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { ConsoleProjectPage } from "@extension.dev/urls/paths";

import { consoleProjectUrl } from "../lib/registry";
import { envelope } from "../lib/envelope";
import { approvalRoundTrip } from "../lib/approval-outcome";
import {
  actionFingerprint,
  evaluateApproval,
  requestApprovalAfterRefusal,
  type ApprovalGateInput,
} from "../lib/approval-gate";
import { projectApiSend } from "../lib/project-api";
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
  const runUrl = text(json.runUrl);
  const value: Row = {};

  if (deploymentId) value.deploymentId = deploymentId;
  if (dispatchedAt) value.dispatchedAt = dispatchedAt;
  if (text(json.runCorrelation)) value.runCorrelation = text(json.runCorrelation);
  if (runId) value.runId = runId;
  if (runUrl) value.runUrl = runUrl;

  const reused = "A rebuild keeps the same build id as the build before it, so";

  if (runId) {
    return { value, match: { runId }, sentence: `${reused} this rebuild is the one whose run reads runId ${runId}${runUrl ? ` (${runUrl})` : ""}; a build showing another runId is the earlier run.` };
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

/* @invariant A REBUILD IS A REAL CI RUN, ASKED FOR AS THE AGENT AND NEVER FORCED.
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
    reason: `A rebuild started through this connection spends the workspace's build units, so a workspace owner approves this exact rebuild first. Call again with buildId ${scope.commit} and buildEnv ${scope.buildEnv} so the run matches what was approved.`,
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

  return envelope({
    ok: true,
    command: COMMAND,
    status: "dispatched",
    value: {
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
    },
    hint: `This started a real CI run for ${project} at ${commit || "the branch head"} (${buildEnv || "staging"}) on ${browsers.join(", ") || "the enabled browsers"}, and it counts against the workspace's build allowance. It takes minutes: follow it with extension_builds action:"get" or action:"logs" with buildId ${commit || "<the new build>"}. ${run.sentence} Do not rebuild again to check on it.`,
    warnings: [stripped.length ? `The platform left out ${stripped.join(", ")}, which this plan does not build.` : null],
  });
}
