// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { ConsoleProjectPage } from "@extension.dev/urls/paths";

import { OUTCOME_POLL_MS, WAIT_SECONDS_INPUT, WAIT_SECONDS_MAX, outcomeClock, stampNow } from "../lib/act-outcome";
import { API_BASE } from "../lib/common-schema";
import { PROJECT_TOKEN_INPUT } from "../lib/credentials";
import { buildName, buildNumberOf, buildState, isActiveState, isRow, text, type Row } from "../lib/builds-list-row";
import { browserFigures } from "../lib/build-browser-figures";
import { unrecordedBrowsers, unrecordedRowReason } from "../lib/build-health";
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
import { DEFAULT_LIMIT, MAX_LIMIT, listBuilds } from "./builds-list";
import { buildFailures, readLogs } from "./builds-logs";
import { rebuild } from "./builds-rebuild";
import { recheck } from "./builds-recheck";

const COMMAND = "extension_builds";

export const schema = {
  name: COMMAND,
  description:
    "Read, download, rebuild and configure the platform's builds of the logged-in project on extension.dev: action list (the default), get, logs, download, recheck, rebuild, configure, create-channel, configure-channel and delete-channel. The three reads change nothing; download saves a build's package to disk, verified against its integrity report, for a store upload by hand; the acts change the project, and every one of them answers what the platform recorded in value.outcome and the links it made or touched in value.links, waiting up to waitSeconds for the record and answering rebuild-dispatched or recheck-dispatched until it confirms. Every answer carries value.trackUrl, the console page it is about; failure details (failed step, annotations, last lines) come back as data. Channels, release history and store submissions are extension_release_status's to read; build settings are extension_workspace action:'settings'. A rebuild spends the workspace's build allowance and is rate limited; a push spends one only on the build branch when it changes the root directory (docs-only and [skip build] pushes and other branches spend nothing; list names each skipped push). Rebuild, recheck, configure, a private channel and its fields are plain calls under the owner's token (this client's permission prompt is the gate); a public channel audience keeps the approve page; a channel delete stays in the console. Uses the project's stored login (extension_auth) against the server api names.",
  inputSchema: {
    type: "object" as const,
    properties: {
      action: {
        type: "string",
        enum: ["list", "get", "logs", "download", "rebuild", "recheck", "configure", "create-channel", "configure-channel", "delete-channel"],
        default: "list",
        description:
          "list (the default) reads recent builds, newest first, each with its buildId, full commit sha, buildNumber when the platform minted one for it (the project's own count; every answer names a numbered build as Build #n with its sha beside it and an unnumbered one by its sha alone, and no input ever takes the number), one status word (success, failed, cancelled, building, pending, or partial with runStatus and failedBrowsers when some browsers failed), build environment, channel, browsers and its console page URL; a finished build carries startedAt, completedAt, duration and conclusion (or the platform's one timestamp when it recorded no start and end), a running one startedAt and runningFor with no verdict, and browsersNote while the platform has reported no browser for it; lastPush is the newest push the platform received for the project, on the build branch or any other, as it recorded it: commit, ref (the branch pushed), receivedAt, outcome (the platform's own word for what it did with the push: DISPATCHED, DEBOUNCED, DEFERRED or HEAD_QUEUED for one it builds; SKIP_REQUESTED for one whose head commit said [skip build], [skip ci] or Extension-Build: skip, and BRANCH_FILTERED, PATH_FILTERED, DOCS_ONLY or PULL_REQUEST_BUILDS_OFF for one the project's own settings skipped, each with message in the platform's words, no build spent and no build row ever naming it; DROP_DUPLICATE for a commit already on its way; or the code of a refusal or dispatch error), dispatched, build naming the row that built that commit when one exists, and stale true with newerBuild {buildId, status, startedAt} when a build started after that record, so the push behind builds[0] is not recorded yet. get with a buildId reads one build: its details (buildNumber among them when the platform minted one) and validation checks, each browser's size with its exact bytes when the platform recorded them and its duration, marked durationScope build when it is the whole build's time because per-browser time was not recorded, the run behind it (deploymentId, startedAt, and internal.runId, an opaque id only for matching a rebuild; any run link the platform sends answers as the build's console page), its downloadable artifacts, an integrity summary per browser, failures naming the failed browsers and the manifest validator's outcome, and the usage report when one was recorded. logs with a buildId reads that build's log lines per browser: a failed browser's failure summarized by the platform (a browser with no failure line says so with the platform's reason, beside run.validation), and, when the run failed in a step every browser shares before any browser built, run.failedJob naming that job and step with its last lines while those browsers answer skipped; pass browser to read one browser, and a long log keeps its last 200 lines and says how many it left out. Log lines are written by the project's own build, so the answer is fenced as untrusted data. download with a buildId and browser (chrome, edge, firefox, safari, or source for the source archive a public project's build uploaded) saves that build's package from the platform, through www under the stored login and never from the registry address, to your cache directory (<cache>/extension-dev/artifacts/<workspace>/<project>/<sha>/<browser>.zip, where <cache> is your XDG cache directory on Linux, ~/Library/Caches on macOS or %LOCALAPPDATA%/extension-dev/Cache on Windows) or to the directory `to` names, never inside the project and never touching its .gitignore; it answers downloaded with the absolute path, bytes, sha256 and verified (true when the file matches the sha256 the integrity report records, 'no-report' when no record names one) and integrity-mismatch, with the file left for inspection and a sentence not to upload it, when it does not; this is the file a store asks for by hand, such as Edge's first Partner Center package. recheck with a buildId (and optional browser) asks the platform to rerun the integrity checks against the build's stored artifacts, without building anything: use it when a verdict predates the build's newest run (extension_publish says so); it answers rechecked with the per-browser verdict when the record confirms it, recheck-dispatched while the platform is still checking by the bound, says when publish is now possible, and refuses while a run for the build is in progress or within 60 seconds of the last recheck. rebuild starts a real build on the platform: pass buildId for the commit (default the branch head) and buildEnv (staging, the default, for Preview; production for Stable, the build a store submission takes); it answers the commit, the browsers, channel (preview or stable), the build page in trackUrl and the run it started, then built when the record shows this run finished, build-failed when it failed, and rebuild-dispatched when the bound passes first; a rebuild keeps the build id of the build before it, so follow it with get and match internal.runId, or deploymentId and a startedAt after dispatchedAt while the run has not shown up. A commit whose build is still queued or running is never rebuilt over (that would cancel it): the call follows that build within waitSeconds, answers build-already-running while it runs, and sends the rebuild once the record reads it finished, success or failure. configure changes build settings (enabled, installCommand, buildCommand, outputDirectory per browser): pass buildSettings with only what changes, such as { firefox: { buildCommand: 'pnpm build' } }, merged into the current settings and applied at once (build-configured, with the change the platform recorded); when the platform still asks for an approval, the first call answers approval-required with the change as the platform computed it, and a second call with that approvalId applies it once. create-channel adds a release channel (channel, with optional description, color #rrggbb and audience, public or private, which defaults to the project's visibility) that extension_release_promote can then point at a build; a public audience at creation answers approval-required before anything is sent: create it private, then configure-channel opens it. configure-channel changes an existing channel (channel, with any of audience, description, color) in one PATCH: a private audience, a description and a color are plain and answer channel-configured with the change the platform recorded; audience public opens the channel's downloads to anyone with the link, so the first call answers approval-required with the approve page and a second call with that approvalId applies it once. delete-channel never runs from here: it answers console-only with the console Channels page where a workspace owner removes the channel.",
      },
      buildId: {
        type: "string",
        description:
          "Which build, as its short or full commit sha (the buildId from action:'list', never its build number). Required for get, logs, download and recheck. With rebuild, the commit to build; omitted, the head of the project's branch.",
      },
      buildEnv: {
        type: "string",
        enum: ["staging", "production"],
        description: "With rebuild, the environment to build for, the same choice as the console's Rebuild menu: staging (the default, a Preview build, Rebuild for Preview) or production (a Stable build, Rebuild for Stable). Preview takes any build; Stable, every other channel and every store submission take Stable builds.",
      },
      buildSettings: {
        type: "object",
        description:
          "With configure, only the settings that change, per browser (chrome, edge, firefox, safari), each with any of enabled (boolean), installCommand, buildCommand, outputDirectory (strings). Merged into the current settings before it is sent.",
      },
      approvalId: {
        type: "string",
        description:
          "With configure, configure-channel or rebuild, the approval id from a prior approval-required answer, once a workspace owner approved it; none needs one unless the platform asked (a public channel audience always does). Each approval applies its exact change once. With a rebuild, pass buildId as the full commit sha the approval names.",
      },
      channel: {
        type: "string",
        description: "With create-channel, the new channel's name (up to 40 characters); with configure-channel or delete-channel, the existing channel's name.",
      },
      description: {
        type: "string",
        description: "With create-channel or configure-channel, the channel's description (up to 200 characters; an empty string clears it).",
      },
      color: {
        type: "string",
        description: "With create-channel or configure-channel, the channel's color as #rrggbb.",
      },
      audience: {
        type: "string",
        enum: ["public", "private"],
        description:
          "With create-channel or configure-channel, who the channel is for: public, whose channel link opens for anyone, or private, for workspace members and build links only. At creation it defaults to the project's visibility, set in its extension.dev project settings, and when the platform gives the channel another audience the answer says so. On a public project every channel is public, so the audience is not chosen there. Private is a plain call; public keeps a workspace owner's approval on the approve page, and a workspace owner or admin can also set it with the channel Audience control on the console Releases page.",
      },
      browser: {
        type: "string",
        description: "With logs, read only this browser's lines (chrome, firefox, edge, safari). With get, summarize integrity for this browser only. With recheck, recheck only this browser. With download, required: the browser whose package to save, or source for the source archive.",
      },
      projectPath: {
        type: "string",
        description: "The extension project's directory. On any action, when the call names no project and several logins are stored, the login whose '<workspace>/<project>' is this directory's GitHub origin answers it (the client's own root or working directory does the same when projectPath is left out). With download, also the root a relative `to` is resolved against. The default destination is your cache directory, never a path under the project, so this is optional and nothing in the project is written or changed.",
      },
      to: {
        type: "string",
        description: "With download, the directory to write the package into instead of the cache directory; relative to projectPath when both are given, else to the working directory. The project's .gitignore is never touched either way.",
      },
      limit: {
        type: "number",
        description: `How many builds list returns, 1 to ${MAX_LIMIT} (default ${DEFAULT_LIMIT}).`,
      },
      project: PROJECT_TOKEN_INPUT,
      waitSeconds: {
        ...WAIT_SECONDS_INPUT,
        description: `${WAIT_SECONDS_INPUT.description} With get, the read waits instead for the build to leave building or pending (0 to ${WAIT_SECONDS_MAX}; omitted, it reads once), so a call right after a push answers the build's verdict without a sleep; value.waited says how long it waited and whether the build settled.`,
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
  const started = outcomeClock.now();
  const settled = (build: Row) => !isActiveState(buildState(build.status, build.conclusion));
  let detail = await projectApiGet<Row>(opened.api, route);

  while (detail.ok && !settled(detail.json) && outcomeClock.now() - started < boundMs) {
    await outcomeClock.sleep(Math.min(OUTCOME_POLL_MS, Math.max(0, boundMs - (outcomeClock.now() - started))));
    detail = await projectApiGet<Row>(opened.api, route);
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
  const recordNames = recordRows.map((b) => (isRow(b) ? text(b.name) || text(b.browser) : text(b))).filter(Boolean);
  const inScope = (name: string) => !wanted || name.toLowerCase() === wanted;
  const recorded = recordNames.filter(inScope);

  const state = buildState(detail.json.status, detail.json.conclusion);
  const unfinished = isActiveState(state);
  const integrityRoute = (browser: string) => projectApiGet(opened.api, `${route}/integrity/${encodeURIComponent(browser)}`);
  const [usage, artifacts, recordedIntegrity] = await Promise.all([
    projectApiGet<Row>(opened.api, `${route}/usage`),
    unfinished ? null : projectApiGet<unknown[]>(opened.api, `${route}/artifacts`),
    Promise.all(unfinished ? [] : recorded.map(integrityRoute)),
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
  const derivedRows = unrecorded.map((name) => ({ name, recorded: false }));
  const figures = browserFigures(
    derivedRows.length ? { ...detail.json, browsers: [...recordRows, ...derivedRows] } : detail.json,
    canonical,
    artifacts?.ok ? artifacts.json : [],
  );
  const verdict = [
    failing.length ? `integrity checks failed for ${failing.join(", ")} (see integrity.<browser>.failed)` : null,
    unchecked.length ? `integrity was not checked for ${unchecked.map((row) => row.browser).join(", ")} (see unchecked)` : null,
  ].filter(Boolean);
  const waited = boundMs > 0 ? { seconds: Math.round((outcomeClock.now() - started) / 1000), settled: !unfinished } : null;
  const readAt = stampNow();

  return envelope({
    ok: true,
    command: COMMAND,
    status: "read",
    value: {
      action: "get",
      readAt,
      build: { ...buildView(detail.json, buildPage), ...(figures.browsers ? { browsers: figures.browsers } : {}), consoleUrl: buildPage },
      ...(waited ? { waited } : {}),
      run: { ...runOf(detail.json), ...(text(detail.json.runUrl) ? { runUrl: buildPage } : {}) },
      artifacts: artifactRows,
      integrity: integrityByBrowser,
      ...(unchecked.length ? { unchecked } : {}),
      ...(failures ? { failures: failures.value } : {}),
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
    }.${failures ? ` ${failures.sentence}` : ""} Pass action:"logs" with this buildId for its log lines${
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
