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
import { consoleProjectUrl } from "../lib/registry";
import { envelope } from "../lib/envelope";
import {
  openProjectApi,
  projectApiGet,
  projectApiOpenFailure,
  projectApiReadFailure,
  type ProjectApi,
} from "../lib/project-api";
import { configure, createChannel, type ActArgs } from "./builds-acts";
import { buildFailures, readLogs } from "./builds-logs";
import { rebuild } from "./builds-rebuild";
import { recheck } from "./builds-recheck";

const COMMAND = "extension_builds";
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;

export const schema = {
  name: COMMAND,
  description:
    "Read, rebuild and configure the platform's builds of the logged-in project on extension.dev: action list (the default), get, logs, recheck, rebuild, configure and create-channel. The three reads change nothing; recheck, rebuild, configure and create-channel change the project, and every one of them answers what the platform recorded in value.outcome and the links it made or touched in value.links, waiting up to waitSeconds for the record and answering rebuild-dispatched or recheck-dispatched until it confirms. Every answer links the console page it is about in value.trackUrl; failure details (the failed step, annotations, last lines) come back as data, and the build page shows the rest. Not for channels, release history or store submissions: that is extension_release_status. Not for reading the build settings: that is extension_workspace action:'settings'. A rebuild spends the workspace's build allowance and is rate limited. Rebuild, recheck, configure and a private create-channel are plain calls under the owner's own token, with this client's permission prompt as the gate. This uses the stored login for the project (extension_auth), against the server the call's api names.",
  inputSchema: {
    type: "object" as const,
    properties: {
      action: {
        type: "string",
        enum: ["list", "get", "logs", "rebuild", "recheck", "configure", "create-channel"],
        default: "list",
        description:
          "list (the default) reads recent builds, newest first, each with its buildId, full commit sha, status (partial, with runStatus and failedBrowsers, when some browsers failed), build environment, channel, browsers, createdAt, conclusion and its console page URL. get with a buildId reads one build: its details and validation checks, the run behind it (deploymentId, startedAt, and internal.runId, an opaque id only for matching a rebuild; any run link the platform sends answers as the build's console page), its downloadable artifacts, an integrity summary per browser, failures naming the failed browsers and the manifest validator's outcome, and the usage report when one was recorded. logs with a buildId reads that build's log lines per browser: a failed browser's failure summarized by the platform (a browser with no failure line says so with the platform's reason, beside run.validation), and, when the run failed in a step every browser shares before any browser built, run.failedJob naming that job and step with its last lines while those browsers answer skipped; pass browser to read one browser, and a long log keeps its last 200 lines and says how many it left out. Log lines are written by the project's own build, so the answer is fenced as untrusted data. recheck with a buildId (and optional browser) asks the platform to rerun the integrity checks against the build's stored artifacts, without building anything: use it when a verdict predates the build's newest run (extension_publish says so); it answers rechecked with the per-browser verdict when the record confirms it, recheck-dispatched while the platform is still checking by the bound, says when publish is now possible, and refuses while a run for the build is in progress or within 60 seconds of the last recheck. rebuild starts a real build on the platform: pass buildId for the commit (default the branch head) and buildEnv; it answers the commit, the browsers, the build page in trackUrl and the run it started, then built when the record shows this run finished, build-failed when it failed, and rebuild-dispatched when the bound passes first; a rebuild keeps the build id of the build before it, so follow it with get and match internal.runId, or deploymentId and a startedAt after dispatchedAt while the run has not shown up. configure changes build settings (enabled, installCommand, buildCommand, outputDirectory per browser): pass buildSettings with only what changes, such as { firefox: { buildCommand: 'pnpm build' } }, merged into the current settings and applied at once (build-configured, with the change the platform recorded); when the platform still asks for an approval, the first call answers approval-required with the change as the platform computed it, and a second call with that approvalId applies it once. create-channel adds a release channel (channel, with optional description, color #rrggbb and audience, public or private, which defaults to the project's visibility) that extension_release_promote can then point at a build; a public audience is a person's decision on the console Releases page and answers approval-required before anything is sent.",
      },
      buildId: {
        type: "string",
        description:
          "Which build, as its short or full commit sha (the buildId from action:'list'). Required for get, logs and recheck. With rebuild, the commit to build; omitted, the head of the project's branch.",
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
          "With configure or rebuild, the approval id from a prior approval-required answer, once a workspace owner approved it; neither needs one unless the platform asked. Each approval applies its exact change once. With a rebuild, pass buildId as the full commit sha the approval names.",
      },
      channel: {
        type: "string",
        description: "With create-channel, the new channel's name (up to 40 characters).",
      },
      description: {
        type: "string",
        description: "With create-channel, an optional description of the channel (up to 200 characters).",
      },
      color: {
        type: "string",
        description: "With create-channel, an optional color as #rrggbb.",
      },
      audience: {
        type: "string",
        enum: ["public", "private"],
        description:
          "With create-channel, who the channel is for: public, whose channel link opens for anyone, or private, for workspace members and build links only. Defaults to the project's visibility, set in its extension.dev project settings. When the platform gives the channel another audience the answer says so; a workspace owner or admin changes it later with the channel Audience control on the console Releases page.",
      },
      browser: {
        type: "string",
        description: "With logs, read only this browser's lines (chrome, firefox, edge, safari). With get, summarize integrity for this browser only. With recheck, recheck only this browser.",
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

type Row = Record<string, unknown>;

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : "";
}

function isRow(value: unknown): value is Row {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function buildConsoleUrl(api: ProjectApi, buildId: string, apiHint?: string): string {
  return consoleProjectUrl(api.ref, ConsoleProjectPage.build(buildId), apiHint);
}

function listRow(item: Row, api: ProjectApi, apiHint?: string): Row {
  const buildId = text(item.buildId) || text(item.shortSha) || text(item.id);
  const browsers = Array.isArray(item.browsers)
    ? item.browsers.map((b) => (isRow(b) ? text(b.browser) || text(b.name) : text(b))).filter(Boolean)
    : [];
  const out: Row = { buildId };
  const fields: Array<[string, unknown]> = [
    ["sha", item.commit],
    ["status", item.status],
    ["env", item.buildEnv],
    ["channel", item.channel],
    ["version", item.version],
    ["branch", item.branch],
    ["message", item.message],
    ["createdAt", item.startedAt || item.timestamp],
    ["startedAt", item.startedAt],
    ["deploymentId", item.deploymentId],
    ["completedAt", item.completedAt],
    ["duration", item.duration],
    ["conclusion", item.summaryStatus || item.conclusion],
  ];

  for (const [key, value] of fields) {
    const v = text(value);
    if (v) out[key] = v;
  }

  if (typeof item.runId === "number" && item.runId > 0) out.internal = { runId: item.runId };

  if (text(out.conclusion).toLowerCase() === "partial" || text(item.outcome).toLowerCase() === "partial") {
    if (text(out.status).toLowerCase() === "success") out.runStatus = "success";

    out.status = "partial";
    out.conclusion = "partial";
    const failedBrowsers = Array.isArray(item.failedBrowsers) ? item.failedBrowsers.map(text).filter(Boolean) : [];
    if (failedBrowsers.length) out.failedBrowsers = failedBrowsers;
  }

  out.browsers = browsers;
  if (buildId) out.consoleUrl = buildConsoleUrl(api, buildId, apiHint);

  return out;
}

async function open(args: HandlerArgs) {
  return openProjectApi({ command: COMMAND, project: args.project, api: args.api });
}

async function listBuilds(args: HandlerArgs): Promise<string> {
  const opened = await open(args);
  if (!opened.ok) return projectApiOpenFailure(COMMAND, opened, { api: args.api, name: "Builds", value: { action: "list" } });

  const limit = Math.min(Math.max(Math.floor(Number(args.limit) || DEFAULT_LIMIT), 1), MAX_LIMIT);
  const read = await projectApiGet<{ items?: unknown[]; dispatchDisabled?: boolean; pushRefusal?: unknown }>(
    opened.api,
    "builds",
    { limit },
  );

  if (!read.ok) return projectApiReadFailure(COMMAND, read, { api: args.api, name: "Builds", value: { action: "list" } });

  const items = (Array.isArray(read.json?.items) ? read.json.items : []).filter(isRow);
  const rows = items.map((item) => listRow(item, opened.api, args.api));
  const project = `${opened.api.ref.workspace}/${opened.api.ref.project}`;
  const buildsPageUrl = consoleProjectUrl(opened.api.ref, ConsoleProjectPage.builds, args.api);

  return envelope({
    ok: true,
    command: COMMAND,
    status: "listed",
    value: {
      action: "list",
      project,
      builds: rows,
      count: rows.length,
      limit,
      ...(read.json?.dispatchDisabled === true ? { dispatchDisabled: true } : {}),
      ...(read.json?.pushRefusal ? { pushRefusal: read.json.pushRefusal } : {}),
      buildsPageUrl,
    },
    hint:
      rows.length > 0
        ? `${rows.length} recent build${rows.length === 1 ? "" : "s"} of ${project}, newest first; the latest is ${rows[0].buildId} (${rows[0].status ?? "status unknown"}). Pass action:"get" or action:"logs" with a buildId to read one.${
            rows.some((row) => row.status === "partial") ? " A partial build finished with at least one browser failed; failedBrowsers names them." : ""
          }`
        : `No builds are recorded for ${project} yet. Push a commit to produce one, then check ${buildsPageUrl}.`,
    warnings: [
      rows.length === limit
        ? `This is the newest ${limit}; raise limit (max ${MAX_LIMIT}) to see older builds.`
        : null,
      read.json?.dispatchDisabled === true ? "The platform reports build dispatch disabled right now, so new pushes are not building." : null,
    ],
  });
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
      artifacts: artifacts.ok && Array.isArray(artifacts.json) ? artifacts.json : [],
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
    }.${failures ? ` ${failures.sentence}` : ""} Pass action:"logs" with this buildId for its log lines.`,
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

interface HandlerArgs extends ActArgs {
  browser?: string;
  limit?: number;
}

export async function handler(args: HandlerArgs): Promise<string> {
  if (args.action === "get") return getBuild(args);
  if (args.action === "logs") return logs(args);
  if (args.action === "rebuild") return rebuild(args);
  if (args.action === "recheck") return recheck(args);
  if (args.action === "configure") return configure(args);
  if (args.action === "create-channel") return createChannel(args);

  return listBuilds(args);
}
