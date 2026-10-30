// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { ConsoleProjectPage } from "@extension.dev/urls/paths";

import { WAIT_SECONDS_INPUT } from "../lib/act-outcome";
import { API_BASE } from "../lib/common-schema";
import { PROJECT_TOKEN_INPUT } from "../lib/credentials";
import { isRow, text, type Row } from "../lib/builds-list-row";
import { consoleProjectUrl } from "../lib/registry";
import { envelope } from "../lib/envelope";
import {
  openProjectApi,
  projectApiGet,
  projectApiOpenFailure,
  projectApiReadFailure,
  type ProjectApi,
} from "../lib/project-api";
import { configure, createChannel } from "./builds-acts";
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
    "Read, download, rebuild and configure the platform's builds of the logged-in project on extension.dev: action list (the default), get, logs, download, recheck, rebuild, configure, create-channel, configure-channel and delete-channel. The three reads change nothing; download saves a build's package to disk through the platform, verified against its integrity report, for a store upload done by hand; the acts change the project, and every one of them answers what the platform recorded in value.outcome and the links it made or touched in value.links, waiting up to waitSeconds for the record and answering rebuild-dispatched or recheck-dispatched until it confirms. Every answer links the console page it is about in value.trackUrl; failure details (the failed step, annotations, last lines) come back as data, and the build page shows the rest. Not for reading channels, release history or store submissions: that is extension_release_status. Not for reading the build settings: that is extension_workspace action:'settings'. A rebuild spends the workspace's build allowance and is rate limited. Rebuild, recheck, configure, a private channel and a channel's fields are plain calls under the owner's own token, with this client's permission prompt as the gate; a public channel audience keeps the approve page, and a channel delete stays in the console. This uses the stored login for the project (extension_auth), against the server the call's api names.",
  inputSchema: {
    type: "object" as const,
    properties: {
      action: {
        type: "string",
        enum: ["list", "get", "logs", "download", "rebuild", "recheck", "configure", "create-channel", "configure-channel", "delete-channel"],
        default: "list",
        description:
          "list (the default) reads recent builds, newest first, each with its buildId, full commit sha, one status word (success, failed, cancelled, building, pending, or partial with runStatus and failedBrowsers when some browsers failed), build environment, channel, browsers, startedAt and its console page URL; a finished build carries completedAt, duration and conclusion, a running one runningFor and no verdict. get with a buildId reads one build: its details and validation checks, the run behind it (deploymentId, startedAt, and internal.runId, an opaque id only for matching a rebuild; any run link the platform sends answers as the build's console page), its downloadable artifacts, an integrity summary per browser, failures naming the failed browsers and the manifest validator's outcome, and the usage report when one was recorded. logs with a buildId reads that build's log lines per browser: a failed browser's failure summarized by the platform (a browser with no failure line says so with the platform's reason, beside run.validation), and, when the run failed in a step every browser shares before any browser built, run.failedJob naming that job and step with its last lines while those browsers answer skipped; pass browser to read one browser, and a long log keeps its last 200 lines and says how many it left out. Log lines are written by the project's own build, so the answer is fenced as untrusted data. download with a buildId and browser (chrome, edge, firefox, safari, or source for the source archive a public project's build uploaded) saves that build's package from the platform, through www under the stored login and never from the registry address, to your cache directory (<cache>/extension-dev/artifacts/<workspace>/<project>/<sha>/<browser>.zip, where <cache> is $XDG_CACHE_HOME, ~/Library/Caches on macOS or %LOCALAPPDATA%/extension-dev/Cache on Windows) or to the directory `to` names, never inside the project and never touching its .gitignore; it answers downloaded with the absolute path, bytes, sha256 and verified (true when the file matches the sha256 the integrity report records, 'no-report' when no record names one) and integrity-mismatch, with the file left for inspection and a sentence not to upload it, when it does not; this is the file a store asks for by hand, such as Edge's first Partner Center package. recheck with a buildId (and optional browser) asks the platform to rerun the integrity checks against the build's stored artifacts, without building anything: use it when a verdict predates the build's newest run (extension_publish says so); it answers rechecked with the per-browser verdict when the record confirms it, recheck-dispatched while the platform is still checking by the bound, says when publish is now possible, and refuses while a run for the build is in progress or within 60 seconds of the last recheck. rebuild starts a real build on the platform: pass buildId for the commit (default the branch head) and buildEnv; it answers the commit, the browsers, the build page in trackUrl and the run it started, then built when the record shows this run finished, build-failed when it failed, and rebuild-dispatched when the bound passes first; a rebuild keeps the build id of the build before it, so follow it with get and match internal.runId, or deploymentId and a startedAt after dispatchedAt while the run has not shown up. configure changes build settings (enabled, installCommand, buildCommand, outputDirectory per browser): pass buildSettings with only what changes, such as { firefox: { buildCommand: 'pnpm build' } }, merged into the current settings and applied at once (build-configured, with the change the platform recorded); when the platform still asks for an approval, the first call answers approval-required with the change as the platform computed it, and a second call with that approvalId applies it once. create-channel adds a release channel (channel, with optional description, color #rrggbb and audience, public or private, which defaults to the project's visibility) that extension_release_promote can then point at a build; a public audience at creation answers approval-required before anything is sent: create it private, then configure-channel opens it. configure-channel changes an existing channel (channel, with any of audience, description, color) in one PATCH: a private audience, a description and a color are plain and answer channel-configured with the change the platform recorded; audience public opens the channel's downloads to anyone with the link, so the first call answers approval-required with the approve page and a second call with that approvalId applies it once. delete-channel never runs from here: it answers console-only with the console Channels page where a workspace owner removes the channel.",
      },
      buildId: {
        type: "string",
        description:
          "Which build, as its short or full commit sha (the buildId from action:'list'). Required for get, logs, download and recheck. With rebuild, the commit to build; omitted, the head of the project's branch.",
      },
      buildEnv: {
        type: "string",
        enum: ["staging", "production"],
        description: "With rebuild, the environment to build for: staging (the default) or production. stable takes production builds; the other channels take staging builds.",
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
        description: "With download, the extension project root a relative `to` is resolved against. The default destination is your cache directory, never a path under the project, so this is optional and nothing in the project is written or changed.",
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
      waitSeconds: WAIT_SECONDS_INPUT,
      api: API_BASE,
    },
    required: [],
  },
};

function buildConsoleUrl(api: ProjectApi, buildId: string, apiHint?: string): string {
  return consoleProjectUrl(api.ref, ConsoleProjectPage.build(buildId), apiHint);
}

async function open(args: HandlerArgs) {
  return openProjectApi({ command: COMMAND, project: args.project, api: args.api });
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

/* @invariant THE PACKAGE ROW NAMES THE CALL THAT SAVES IT. The platform's
 * downloadUrl is the registry address, which answers 401 to a project token
 * (ledger 152), so an agent reading the row needs the path that works: the
 * download action with this build and this browser. Only the extension
 * package rows carry it; metadata, integrity and executable rows keep their
 * link alone.
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
  const detail = await projectApiGet<Row>(opened.api, route);

  if (!detail.ok) {
    return projectApiReadFailure(COMMAND, detail, {
      api: args.api,
      name: "Builds",
      value: { action: "get", buildId },
      notFound: "build",
    });
  }

  const wanted = text(args.browser).toLowerCase();
  const browsers = (Array.isArray(detail.json.browsers) ? detail.json.browsers : [])
    .map((b) => (isRow(b) ? text(b.name) || text(b.browser) : text(b)))
    .filter((name) => name && (!wanted || name.toLowerCase() === wanted));

  const [artifacts, usage, ...integrity] = await Promise.all([
    projectApiGet<unknown[]>(opened.api, `${route}/artifacts`),
    projectApiGet<Row>(opened.api, `${route}/usage`),
    ...browsers.map((browser) => projectApiGet(opened.api, `${route}/integrity/${encodeURIComponent(browser)}`)),
  ]);

  const integrityByBrowser: Row = {};
  const integrityUnread: string[] = [];

  browsers.forEach((browser, i) => {
    const read = integrity[i];
    if (read.ok) integrityByBrowser[browser] = integritySummary(read.json);
    else integrityUnread.push(`${browser}: ${read.message}`);
  });

  const usageMarkdown = usage.ok ? text(usage.json?.markdown) : "";
  const canonical = text(detail.json.buildId) || buildId;
  const artifactRows = (artifacts.ok && Array.isArray(artifacts.json) ? artifacts.json : []).map((row) => withDownloadHint(row, canonical));
  const failing = Object.entries(integrityByBrowser).filter(([, v]) => (v as Row).ok !== true).map(([k]) => k);
  const failures = buildFailures(detail.json);
  const buildPage = buildConsoleUrl(opened.api, canonical, args.api);

  return envelope({
    ok: true,
    command: COMMAND,
    status: "read",
    value: {
      action: "get",
      build: { ...buildView(detail.json, buildPage), consoleUrl: buildPage },
      run: { ...runOf(detail.json), ...(text(detail.json.runUrl) ? { runUrl: buildPage } : {}) },
      artifacts: artifactRows,
      integrity: integrityByBrowser,
      ...(failures ? { failures: failures.value } : {}),
      usage: usage.ok
        ? usageMarkdown
          ? { recorded: true, markdown: usageMarkdown, updatedAt: text(usage.json?.updatedAt) || null }
          : { recorded: false }
        : { recorded: "unknown" },
    },
    hint: `Build ${canonical} is ${text(detail.json.status) || "of unknown status"}${
      browsers.length
        ? failing.length
          ? `; integrity checks failed for ${failing.join(", ")} (see integrity.<browser>.failed)`
          : integrityUnread.length
            ? ""
            : "; every integrity check passed"
        : ""
    }.${failures ? ` ${failures.sentence}` : ""} Pass action:"logs" with this buildId for its log lines${
      artifactRows.some((row) => isRow(row) && row.download) ? `, or action:"${DOWNLOAD_ACTION}" with a browser to save its package to disk (artifacts[].download names the call)` : ""
    }.`,
    warnings: [
      artifacts.ok ? null : `The artifact list could not be read (${artifacts.message}).`,
      usage.ok ? null : `The usage report could not be read (${usage.message}).`,
      integrityUnread.length ? `Integrity could not be read for ${integrityUnread.join("; ")}.` : null,
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
