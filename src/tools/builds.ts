// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { ConsoleProjectPage } from "@extension.dev/urls/paths";

import { WAIT_SECONDS_INPUT, WAIT_SECONDS_MAX, outcomeClock, stampNow } from "../lib/act-outcome";
import { API_BASE } from "../lib/common-schema";
import { PROJECT_TOKEN_INPUT } from "../lib/credentials";
import { buildName, buildNumberOf, buildState, channelsOf, isActiveState, isRow, pinsWords, text, type Row } from "../lib/builds-list-row";
import { browserFigures } from "../lib/build-browser-figures";
import { forgetBuildDispatch } from "../lib/build-dispatches";
import { unrecordedBrowsers, unrecordedRowReason } from "../lib/build-health";
import { envChannelOf, listItemFor, rowNameOf, runningBrowsers, runningClause, runningReason, unrecordedClause, unrecordedRow } from "../lib/build-row-states";
import { usageValue } from "../lib/build-usage";
import { artifactWithAddress } from "../lib/package-address";
import { consoleProjectUrl } from "../lib/registry";
import { envelope } from "../lib/envelope";
import {
  openProjectApi,
  projectApiGet,
  projectApiOpenFailure,
  projectApiReadFailure,
  type ProjectApi,
  type ProjectApiRefusal,
} from "../lib/project-api";
import { configure } from "./builds-configure";
import { createChannel } from "./builds-create-channel";
import { CONFIGURE_CHANNEL, DELETE_CHANNEL, configureChannel, deleteChannelConsoleOnly } from "./builds-channel";
import { DOWNLOAD_ACTION, download, type DownloadArgs } from "./builds-download";
import { notRecordedYet, readBuildWaiting } from "./builds-get-wait";
import { DEFAULT_LIMIT, MAX_LIMIT, listBuilds } from "./builds-list";
import { buildFailures, platformFault, readLogs } from "./builds-logs";
import { rebuild } from "./builds-rebuild";
import { recheck } from "./builds-recheck";

const COMMAND = "extension_builds";

export const schema = {
  name: COMMAND,
  description:
    "Read, download, rebuild and configure platform builds. list/get rows: env is the build environment, channels the pins holding it now. A rebuild spends allowance; a push, only on the build branch when it changes the root directory ([skip build] pushes, docs-only, other branches spend nothing).",
  inputSchema: {
    type: "object" as const,
    properties: {
      action: {
        type: "string",
        enum: ["list", "get", "logs", "download", "rebuild", "recheck", "configure", "create-channel", "configure-channel", "delete-channel"],
        default: "list",
        description:
          "list: recent builds, lastPush; get: one build; logs; download: a verified package; recheck: rerun integrity; rebuild; configure: buildSettings; create-, configure-channel; delete-channel: console only.",
      },
      buildId: {
        type: "string",
        description:
          "Commit sha, never the build number; required for get, logs, download, recheck.",
      },
      buildEnv: {
        type: "string",
        enum: ["staging", "production"],
        description: "rebuild: staging (default, Preview) or production (Stable, stores).",
      },
      buildSettings: {
        type: "object",
        description:
          "configure: per-browser changes, e.g. { firefox: { buildCommand: 'pnpm build' } }.",
      },
      approvalId: {
        type: "string",
        description:
          "Approved approval id.",
      },
      channel: {
        type: "string",
        description: "Channel name, max 40 chars.",
      },
      description: {
        type: "string",
        description: "Channel description, max 200 chars.",
      },
      color: {
        type: "string",
        description: "Channel color, #rrggbb.",
      },
      audience: {
        type: "string",
        enum: ["public", "private"],
        description:
          "private, or public (owner approval); default the project's visibility.",
      },
      browser: {
        type: "string",
        description: "chrome, edge, firefox, safari; download requires it and takes source.",
      },
      projectPath: {
        type: "string",
        description: "Project directory; picks its login.",
      },
      to: {
        type: "string",
        description: "download: directory (default the cache).",
      },
      limit: {
        type: "number",
        description: `list: 1 to ${MAX_LIMIT} (default ${DEFAULT_LIMIT}).`,
      },
      project: PROJECT_TOKEN_INPUT,
      waitSeconds: {
        ...WAIT_SECONDS_INPUT,
        description: `${WAIT_SECONDS_INPUT.description} get waits for a build's verdict (a rebuild or a push).`,
      },
      api: API_BASE,
    },
    required: [],
  },
};

function buildConsoleUrl(api: ProjectApi, buildId: string, apiHint?: string): string {
  return consoleProjectUrl(api.ref, ConsoleProjectPage.build(buildId), apiHint);
}

async function open(args: HandlerArgs) {
  return openProjectApi({ command: COMMAND, project: args.project, api: args.api, renew: true });
}

function integritySummary(json: unknown): Row {
  const body = isRow(json) ? json : {};
  const checks = Array.isArray(body.checks) ? body.checks.filter(isRow) : [];
  const failed = checks
    .filter((check) => check.ok === false)
    .map((check) => {
      const row: Row = { id: text(check.id) };
      const title = text(check.title);
      const detail = text(check.detail);
      if (title) row.title = title;
      if (detail) row.detail = detail;

      return row;
    });

  return { ok: body.ok === true, failed, checks: checks.length };
}

/* @invariant THE PACKAGE ROW NAMES THE CALL THAT SAVES IT. A row's
 * downloadUrl is the build's extension.dev package address (ledger 306),
 * which a signed-in member opens in a browser and which answers 401 to a
 * project token (ledger 152), so an agent reading the row needs the path
 * that works from here: the download action with this build and this
 * browser. Only the extension package rows carry it; metadata, integrity
 * and executable rows keep their link alone.
 */
function withDownloadHint(row: unknown, buildId: string): unknown {
  if (!isRow(row)) return row;

  const browser = text(row.browser).toLowerCase();
  const name = text(row.name).toLowerCase();
  if (!browser || name !== `${browser}-extension.zip`) return row;

  return { ...row, download: { action: DOWNLOAD_ACTION, buildId, browser } };
}

const RUN_ONLY_KEYS = ["runId", "workflowRunId", "runCorrelation"];
const RUN_LINK_KEYS = ["runUrl", "workflowRunUrl", "htmlUrl"];

function buildView(build: Row, buildPage: string): Row {
  const out: Row = { ...build };

  for (const key of RUN_ONLY_KEYS) delete out[key];

  for (const key of RUN_LINK_KEYS) {
    if (key in out) out[key] = buildPage;
  }

  if (isRow(out.failureCause)) out.failureCause = buildView(out.failureCause, buildPage);

  if (isRow(out.run)) {
    const run = buildView(out.run, buildPage);
    delete run.id;
    out.run = run;
  }

  return out;
}

function runOf(build: Row): Row {
  const run: Row = {};
  if (typeof build.runId === "number" && build.runId > 0) run.internal = { runId: build.runId };

  for (const key of ["deploymentId", "startedAt"]) {
    if (text(build[key])) run[key] = text(build[key]);
  }

  return run;
}

function readProblem(read: ProjectApiRefusal): string {
  if (read.status === 404) return "missing (404)";
  if (read.status === 0) return "unreachable (the platform did not answer)";
  if (read.status >= 200 && read.status < 300) return `a ${read.status} without a JSON body`;

  return `unread (${read.status}${read.code ? ` ${read.code}` : ""})`;
}

const UNFINISHED_CLAUSE = "; artifacts and integrity arrive when the build finishes";

function getWaitBoundMs(raw: unknown): number {
  if (raw === undefined || raw === null || raw === "") return 0;

  const n = Number(raw);
  if (!Number.isFinite(n)) return 0;

  return Math.min(WAIT_SECONDS_MAX, Math.max(0, Math.floor(n))) * 1000;
}

function requireBuildId(args: HandlerArgs, action: string): string | null {
  const buildId = text(args.buildId);
  if (buildId) return null;

  return envelope({
    ok: false,
    command: COMMAND,
    status: "bad-request",
    value: { action },
    error: {
      code: "E_BAD_REQUEST",
      name: "BuildsInputError",
      message: `action:"${action}" needs a buildId. Run action:"list" for the recent builds and pass one of their buildId values.`,
    },
  });
}

async function getBuild(args: HandlerArgs): Promise<string> {
  const refused = requireBuildId(args, "get");
  if (refused) return refused;

  const buildId = text(args.buildId);
  const opened = await open(args);

  if (!opened.ok) {
    return projectApiOpenFailure(COMMAND, opened, { api: args.api, name: "Builds", value: { action: "get", buildId } });
  }

  const route = `builds/${encodeURIComponent(buildId)}`;
  const boundMs = getWaitBoundMs(args.waitSeconds);
  const waitedRead = await readBuildWaiting(opened.api, buildId, boundMs);
  const { detail, started } = waitedRead;

  if (detail.ok) forgetBuildDispatch(opened.api, buildId);

  if (waitedRead.naming) {
    return notRecordedYet(COMMAND, buildId, waitedRead, boundMs, consoleProjectUrl(opened.api.ref, ConsoleProjectPage.builds, args.api));
  }

  if (!detail.ok) {
    return projectApiReadFailure(COMMAND, detail, {
      api: args.api,
      name: "Builds",
      value: { action: "get", buildId },
      notFound: "build",
    });
  }

  const wanted = text(args.browser).toLowerCase();
  const recordRows = Array.isArray(detail.json.browsers) ? detail.json.browsers : [];
  const recordNames = recordRows.map(rowNameOf).filter(Boolean);
  const inScope = (name: string) => !wanted || name.toLowerCase() === wanted;
  const recorded = recordNames.filter(inScope);

  const state = buildState(detail.json.status, detail.json.conclusion);
  const unfinished = isActiveState(state);
  const integrityRoute = (browser: string) => projectApiGet(opened.api, `${route}/integrity/${encodeURIComponent(browser)}`);
  const running = runningBrowsers(recordRows, unfinished, inScope);
  const needsList = (!text(detail.json.buildEnv) && !text(detail.json.env)) || !Array.isArray(detail.json.channels);
  const [usage, artifacts, recordedIntegrity, listed] = await Promise.all([
    projectApiGet<Row>(opened.api, `${route}/usage`),
    unfinished ? null : projectApiGet<unknown[]>(opened.api, `${route}/artifacts`),
    Promise.all(unfinished ? [] : recorded.map(integrityRoute)),
    needsList ? projectApiGet<unknown>(opened.api, "builds", { limit: 50 }) : null,
  ]);
  const unrecorded = unrecordedBrowsers(recordNames, artifacts?.ok ? artifacts.json : []).filter(inScope);
  const unrecordedIntegrity = await Promise.all(unrecorded.map(integrityRoute));
  const browsers = [...recorded, ...unrecorded];
  const integrity = [...recordedIntegrity, ...unrecordedIntegrity];

  const integrityByBrowser: Row = {};
  const integrityUnread: string[] = [];
  const unchecked: Array<{ browser: string; reason: string }> = [];

  browsers.forEach((browser, i) => {
    const read = integrity[i];
    if (!read) return;

    if (read.ok) {
      integrityByBrowser[browser] = integritySummary(read.json);

      return;
    }

    const problem = readProblem(read);
    const stillRunning = running.find((row) => row.name === browser);

    if (stillRunning) {
      unchecked.push({ browser, reason: runningReason(stillRunning.status) });

      return;
    }

    if (unrecorded.includes(browser)) {
      unchecked.push({ browser, reason: `${unrecordedRowReason(browser)}, and its integrity result is ${problem}` });

      return;
    }

    integrityUnread.push(`${browser} is ${problem}`);
    unchecked.push({ browser, reason: `its integrity result is ${problem}` });
  });

  const canonical = text(detail.json.buildId) || buildId;
  const number = buildNumberOf(detail.json);
  const named = buildName(canonical, number, "build");
  const addressScope = { ref: opened.api.ref, sha: canonical, api: args.api };
  const artifactRows = (artifacts?.ok && Array.isArray(artifacts.json) ? artifacts.json : []).map((row) => withDownloadHint(artifactWithAddress(row, addressScope), canonical));
  const failing = Object.entries(integrityByBrowser).filter(([, v]) => (v as Row).ok !== true).map(([k]) => k);
  const failures = buildFailures(detail.json);
  const buildPage = buildConsoleUrl(opened.api, canonical, args.api);
  const fault = platformFault(detail.json, canonical, [], 'extension_builds action:"logs" with this buildId');
  const derivedRows = unrecorded.map((name) => unrecordedRow(name, isRow(integrityByBrowser[name]) ? (integrityByBrowser[name] as Row) : null));
  const figures = browserFigures(
    derivedRows.length ? { ...detail.json, browsers: [...recordRows, ...derivedRows] } : detail.json,
    canonical,
    artifacts?.ok ? artifacts.json : [],
  );
  const stateClauses = [runningClause(running.filter((row) => !unchecked.some((u) => u.browser === row.name))), unrecordedClause(derivedRows)].filter(Boolean);
  const passedRecorded = recorded.filter((name) => (integrityByBrowser[name] as Row | undefined)?.ok === true && !running.some((row) => row.name === name));
  const verdict = [
    failing.length || unchecked.length || !stateClauses.length || !passedRecorded.length ? null : `every integrity check of ${passedRecorded.join(", ")} passed`,
    failing.length ? `integrity checks failed for ${failing.join(", ")} (see integrity.<browser>.failed)` : null,
    unchecked.length ? `integrity was not checked for ${unchecked.map((row) => row.browser).join(", ")} (see unchecked)` : null,
    ...stateClauses,
  ].filter(Boolean);
  const envChannel = envChannelOf(detail.json, listed?.ok ? listItemFor(listed.json, canonical) : null);
  const pinned = pinsWords(channelsOf(envChannel));
  const waited = boundMs > 0 ? { seconds: Math.round((outcomeClock.now() - started) / 1000), settled: !unfinished } : null;
  const readAt = stampNow();

  return envelope({
    ok: true,
    command: COMMAND,
    status: "read",
    value: {
      action: "get",
      readAt,
      build: { ...buildView(detail.json, buildPage), ...envChannel, ...(figures.browsers ? { browsers: figures.browsers } : {}), consoleUrl: buildPage },
      ...(waited ? { waited } : {}),
      run: { ...runOf(detail.json), ...(text(detail.json.runUrl) ? { runUrl: buildPage } : {}) },
      artifacts: artifactRows,
      integrity: integrityByBrowser,
      ...(unchecked.length ? { unchecked } : {}),
      ...(failures ? { failures: failures.value } : {}),
      ...(fault ? { fault: fault.value } : {}),
      usage: usage.ok ? usageValue(usage.json) : { recorded: "unknown" },
    },
    hint: `${
      waited && !waited.settled
        ? `The ${waited.seconds}s wait passed before ${buildName(canonical, number)} settled; call get again with waitSeconds to keep waiting. `
        : ""
    }${buildName(canonical, number)} is ${text(detail.json.status) || "of unknown status"}${unfinished ? ` as of ${readAt}` : ""}${
      unfinished
        ? UNFINISHED_CLAUSE
        : browsers.length
        ? verdict.length
          ? `; ${verdict.join("; ")}`
          : "; every integrity check passed"
        : ""
    }.${pinned ? ` It is ${pinned}.` : ""}${failures ? ` ${failures.sentence}` : ""}${fault ? ` ${fault.sentence}` : ""} Pass action:"logs" with this buildId for its log lines${
      artifactRows.some((row) => isRow(row) && row.download) ? `, or action:"${DOWNLOAD_ACTION}" with a browser to save its package to disk (artifacts[].download names the call)` : ""
    }.`,
    warnings: [
      !artifacts || artifacts.ok ? null : `The artifact list for ${named} is ${readProblem(artifacts)}.`,
      usage.ok ? null : `The usage report for ${named} is ${readProblem(usage)}.`,
      integrityUnread.length ? `Integrity for ${named} could not be read: ${integrityUnread.join("; ")}.` : null,
      unrecorded.length
        ? `The platform's record of ${named} has no row for ${unrecorded.join(", ")} while its artifact list carries ${unrecorded.length === 1 ? "a package for it" : "packages for them"}, so ${
            unrecorded.length === 1 ? "that browser row is" : "those browser rows are"
          } derived from the artifact with no build status.`
        : null,
      ...figures.notes,
    ],
  });
}

async function logs(args: HandlerArgs): Promise<string> {
  const refused = requireBuildId(args, "logs");
  if (refused) return refused;

  const buildId = text(args.buildId);
  const opened = await open(args);

  if (!opened.ok) {
    return projectApiOpenFailure(COMMAND, opened, { api: args.api, name: "Builds", value: { action: "logs", buildId } });
  }

  return readLogs({
    api: opened.api,
    apiHint: args.api,
    buildId,
    browser: args.browser,
    consoleUrl: buildConsoleUrl(opened.api, buildId, args.api),
  });
}

interface HandlerArgs extends DownloadArgs {
  limit?: number;
}

export async function handler(args: HandlerArgs): Promise<string> {
  if (args.action === "get") return getBuild(args);
  if (args.action === "logs") return logs(args);
  if (args.action === DOWNLOAD_ACTION) return download(args);
  if (args.action === "rebuild") return rebuild(args);
  if (args.action === "recheck") return recheck(args);
  if (args.action === "configure") return configure(args);
  if (args.action === "create-channel") return createChannel(args);
  if (args.action === CONFIGURE_CHANNEL) return configureChannel(args);
  if (args.action === DELETE_CHANNEL) return deleteChannelConsoleOnly(args);

  return listBuilds(COMMAND, args);
}
