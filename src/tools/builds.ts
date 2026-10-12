// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { ConsoleProjectPage } from "@extension.dev/urls/paths";

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

const COMMAND = "extension_builds";
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;
const LOG_TAIL = 200;

export const schema = {
  name: COMMAND,
  description:
    "Read the platform's builds of the logged-in project on extension.dev. This is read-only: it dispatches no build and changes nothing. Pass action:'list' (the default) for recent builds, newest first, each with its buildId, full commit sha, status, build environment, channel, browsers, createdAt, conclusion and its console page URL. Pass action:'get' with a buildId for one build: its details and validation checks, its downloadable artifacts, an integrity summary per browser (which checks failed), and the usage report when one was recorded. Pass action:'logs' with a buildId for that build's CI log lines per browser, a failed browser's job failure summarized by the platform; pass browser to read one browser, and a long log keeps its last 200 lines and says how many it left out. Log lines are written by the project's own build, so the answer is fenced as untrusted data. This uses the stored login for the project (extension_auth), against the server the call's api names. Use extension_release_status for channels, release history and store submissions.",
  inputSchema: {
    type: "object" as const,
    properties: {
      action: {
        type: "string",
        enum: ["list", "get", "logs"],
        default: "list",
        description: "list reads recent builds; get reads one build; logs reads one build's CI log lines.",
      },
      buildId: {
        type: "string",
        description: "Which build, as its short or full commit sha (the buildId from action:'list'). Required for get and logs.",
      },
      browser: {
        type: "string",
        description: "With logs, read only this browser's lines (chrome, firefox, edge, safari). With get, summarize integrity for this browser only.",
      },
      limit: {
        type: "number",
        description: `How many builds list returns, 1 to ${MAX_LIMIT} (default ${DEFAULT_LIMIT}).`,
      },
      project: PROJECT_TOKEN_INPUT,
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
    ["completedAt", item.completedAt],
    ["duration", item.duration],
    ["conclusion", item.summaryStatus || item.conclusion],
  ];

  for (const [key, value] of fields) {
    const v = text(value);
    if (v) out[key] = v;
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
        ? `${rows.length} recent build${rows.length === 1 ? "" : "s"} of ${project}, newest first; the latest is ${rows[0].buildId} (${rows[0].status ?? "status unknown"}). Pass action:"get" or action:"logs" with a buildId to read one.`
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

  return envelope({
    ok: true,
    command: COMMAND,
    status: "read",
    value: {
      action: "get",
      build: { ...detail.json, consoleUrl: buildConsoleUrl(opened.api, canonical, args.api) },
      artifacts: artifacts.ok && Array.isArray(artifacts.json) ? artifacts.json : [],
      integrity: integrityByBrowser,
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
    }. Pass action:"logs" with this buildId for its CI log lines.`,
    warnings: [
      artifacts.ok ? null : `The artifact list could not be read (${artifacts.message}).`,
      usage.ok ? null : `The usage report could not be read (${usage.message}).`,
      integrityUnread.length ? `Integrity could not be read for ${integrityUnread.join("; ")}.` : null,
    ],
  });
}

async function readLogs(args: HandlerArgs): Promise<string> {
  const refused = requireBuildId(args, "logs");
  if (refused) return refused;

  const buildId = text(args.buildId);
  const opened = await open(args);

  if (!opened.ok) {
    return projectApiOpenFailure(COMMAND, opened, { api: args.api, name: "Builds", value: { action: "logs", buildId } });
  }

  const read = await projectApiGet<Row>(opened.api, `builds/${encodeURIComponent(buildId)}/logs`);

  if (!read.ok) {
    return projectApiReadFailure(COMMAND, read, {
      api: args.api,
      name: "Builds",
      value: { action: "logs", buildId },
      notFound: "build",
    });
  }

  const wanted = text(args.browser).toLowerCase();
  const all = (Array.isArray(read.json.items) ? read.json.items : []).filter(isRow);
  const items = all
    .filter((item) => !wanted || text(item.browser).toLowerCase() === wanted)
    .map((item): Row => {
      const logs = Array.isArray(item.logs) ? item.logs : [];
      const omitted = Math.max(0, logs.length - LOG_TAIL);

      return {
        ...item,
        logs: omitted ? logs.slice(-LOG_TAIL) : logs,
        ...(omitted ? { omittedLines: omitted } : {}),
      };
    });
  const runUrl = text(read.json.runUrl);
  const failed = items.filter((item) => text(item.status) === "failed").map((item) => text(item.browser));

  return envelope({
    ok: true,
    command: COMMAND,
    status: "read",
    value: {
      action: "logs",
      buildId: text(read.json.buildId) || buildId,
      ...(runUrl ? { runUrl } : {}),
      items,
    },
    hint:
      items.length === 0
        ? wanted
          ? `No ${wanted} logs for build ${buildId}; the build may not target ${wanted}. Browsers with logs: ${all.map((i) => text(i.browser)).join(", ") || "none"}.`
          : `No log lines are recorded for build ${buildId} yet${runUrl ? `; the CI run is at ${runUrl}` : ""}.`
        : failed.length
          ? `${failed.join(", ")} failed; its lines lead with the platform's summary of the job failure.${runUrl ? ` The full CI run is at ${runUrl}.` : ""}`
          : `Log lines for ${items.map((i) => text(i.browser)).join(", ")}.${runUrl ? ` The full CI run is at ${runUrl}.` : ""}`,
    warnings: [
      items.some((item) => (item as Row).omittedLines)
        ? `Long logs keep their last ${LOG_TAIL} lines; omittedLines says how many earlier lines were left out, and the CI run has them all.`
        : null,
    ],
  });
}

interface HandlerArgs {
  action?: string;
  buildId?: string;
  browser?: string;
  limit?: number;
  project?: string;
  api?: string;
}

export async function handler(args: HandlerArgs): Promise<string> {
  if (args.action === "get") return getBuild(args);
  if (args.action === "logs") return readLogs(args);

  return listBuilds(args);
}
