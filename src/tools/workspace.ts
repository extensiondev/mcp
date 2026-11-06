// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { ConsoleProjectPage } from "@extension.dev/urls/paths";

import { buildAllowanceValue, buildAllowanceWarning, readBuildAllowance } from "../lib/build-allowance";
import { API_BASE } from "../lib/common-schema";
import { consoleProjectUrl } from "../lib/console-urls";
import { envelope } from "../lib/envelope";
import {
  openProjectApi,
  platformApiGet,
  projectApiOpenFailure,
  projectApiReadFailure,
  type ProjectApi,
} from "../lib/project-api";
import { CONFIGURE_PROJECT, SETTINGS_FIELDS, configureProject, readProjectSettings } from "./workspace-configure";
import { ENVIRONMENT_SCOPES, SET_ENVIRONMENT, setEnvironment } from "./workspace-environment";
import { consoleOnly, pickLogin, storedLoginsOn, workspaceConsole } from "./workspace-login";
import { WORKSPACE_INCLUDES, attachIncludes, badInclude, includesOf } from "./workspace-reads";
import { setVisibility } from "./workspace-visibility";

const COMMAND = "extension_workspace";
const ACTIONS = ["info", "projects", "usage", "settings", "set-visibility", CONFIGURE_PROJECT, SET_ENVIRONMENT] as const;

type Action = (typeof ACTIONS)[number];
type Row = Record<string, unknown>;

export const schema = {
  name: COMMAND,
  description:
    "Read the workspace; change a project's settings. configure-project renames a project (displayName; slug and URLs stay). set-visibility public or a public liveChannel needs approval. Builds spend only on build branch pushes that change the root directory; docs-only pushes spend nothing.",
  inputSchema: {
    type: "object" as const,
    properties: {
      action: {
        type: "string",
        enum: [...ACTIONS],
        default: "info",
        description:
          "set-* and configure-project write.",
      },
      visibility: {
        type: "string",
        enum: ["private", "public"],
        description: "private: plain call under the owner's own token; public: approve page.",
      },
      settings: {
        type: "object",
        description: `configure-project: changed fields only (${SETTINGS_FIELDS.join(", ")}); displayName renames the project.`,
      },
      variables: {
        type: "array",
        description: "set-environment: to set.",
        items: {
          type: "object",
          properties: {
            name: { type: "string", description: "Name." },
            value: { type: "string", description: "Plain value." },
            scope: { type: "string", enum: [...ENVIRONMENT_SCOPES], description: "Scope." },
            note: { type: "string", description: "Note." },
            secret: { type: "boolean", description: "Must be false." },
          },
          required: ["name", "value"],
        },
      },
      remove: {
        type: "array",
        description: "set-environment: to remove.",
        items: {
          type: "object",
          properties: {
            name: { type: "string", description: "Name." },
            scope: { type: "string", enum: [...ENVIRONMENT_SCOPES], description: "Scope." },
          },
          required: ["name"],
        },
      },
      approvalId: {
        type: "string",
        description: "For set-visibility public.",
      },
      include: {
        type: "array",
        items: { type: "string", enum: [...WORKSPACE_INCLUDES] },
        description: "Read-only sections to add.",
      },
      workspace: {
        type: "string",
        description: "Slug.",
      },
      project: {
        type: "string",
        description: "Stored login; for settings, the project.",
      },
      api: API_BASE,
    },
    required: [],
  },
};

interface HandlerArgs {
  action?: string;
  include?: unknown;
  settings?: unknown;
  variables?: unknown;
  remove?: unknown;
  approvalId?: string;
  workspace?: string;
  project?: string;
  visibility?: string;
  api?: string;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : "";
}

function isRow(value: unknown): value is Row {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.map(text).filter(Boolean) : [];
}

async function open(args: HandlerArgs, action: Action) {
  const picked = pickLogin(args);
  if ("refused" in picked) return { refused: picked.refused };

  const opened = await openProjectApi({ command: COMMAND, project: picked.project, api: args.api, renew: true });

  if (!opened.ok) {
    return {
      refused: projectApiOpenFailure(COMMAND, opened, {
        api: args.api,
        name: "Workspace",
        value: { action },
      }),
    };
  }

  const workspace = text(args.workspace).toLowerCase() || opened.api.ref.workspace.toLowerCase();

  if (!workspace) {
    return {
      refused: envelope({
        ok: false,
        command: COMMAND,
        status: "bad-request",
        value: { action },
        error: {
          code: "E_BAD_REQUEST",
          name: "WorkspaceUnknown",
          message: "The login this call would use does not say which workspace it belongs to. Pass workspace by slug.",
        },
      }),
    };
  }

  return { api: opened.api, workspace };
}

function loginOf(api: ProjectApi): string {
  return `${api.ref.workspace}/${api.ref.project}`;
}

function refusal(args: HandlerArgs, action: Action, read: Parameters<typeof projectApiReadFailure>[1], workspace: string, project?: string): string {
  return projectApiReadFailure(COMMAND, read, {
    api: args.api,
    name: "Workspace",
    value: { action, workspace },
    context: { workspace, project },
  });
}

function nonZero(value: unknown): Row {
  const out: Row = {};

  if (!isRow(value)) return out;

  for (const [key, count] of Object.entries(value)) {
    if (typeof count === "number" && count > 0) out[key] = count;
  }

  return out;
}

function planSummary(plan: Row): Row {
  const refusals = isRow(plan.refusals) ? plan.refusals : null;

  return {
    plan: text(plan.plan) || null,
    month: text(plan.month) || null,
    billingOpen: plan.billingOpen === true,
    countersReadable: plan.countersReadable === true,
    limits: isRow(plan.limits) ? plan.limits : {},
    used: isRow(plan.used) ? plan.used : null,
    refusals: refusals
      ? {
          total: typeof refusals.total === "number" ? refusals.total : 0,
          byReason: nonZero(refusals.byReason),
          lastReason: text(refusals.lastReason) || null,
        }
      : null,
  };
}

async function readInfo(args: HandlerArgs): Promise<string> {
  const opened = await open(args, "info");
  if ("refused" in opened) return opened.refused as string;

  const { api, workspace } = opened;
  const path = `/api/workspaces/${encodeURIComponent(workspace)}`;
  const [info, plan] = await Promise.all([
    platformApiGet<Row>(api, path),
    platformApiGet<Row>(api, `${path}/plan`),
  ]);

  if (!info.ok) return refusal(args, "info", info, workspace);

  const ws = info.json;
  const summary = plan.ok ? planSummary(plan.json) : null;
  const limits = (summary?.limits ?? {}) as Row;
  const used = (summary?.used ?? {}) as Row;
  const slug = text(ws.slug) || workspace;
  const usage =
    summary && summary.used
      ? `: ${used.buildsThisMonth ?? "?"} of ${limits.buildsPerMonth ?? "?"} builds this month, ${used.projects ?? "?"} of ${limits.projects ?? "?"} projects`
      : "";
  const allowance = readBuildAllowance(summary);
  const warning = allowance ? buildAllowanceWarning(allowance) : null;

  return envelope({
    ok: true,
    command: COMMAND,
    status: "read",
    value: {
      action: "info",
      workspace: {
        slug,
        displayName: text(ws.displayName) || slug,
        description: text(ws.description),
        developerUrl: text(ws.developerUrl),
        personal: ws.isImmutablePersonalWorkspace === true,
        role: text(ws.currentUserRole) || null,
        actingAs: text(ws.currentUserLogin) || null,
        projectCount: ws.projectCount ?? null,
        memberCount: ws.memberCount ?? null,
      },
      plan: summary,
      allowance: allowance ? buildAllowanceValue(allowance) : null,
      login: loginOf(api),
      console: workspaceConsole(slug, args.api),
    },
    hint: `${warning ? `${warning} ` : ""}${slug} is on the ${summary?.plan ?? "unknown"} plan${usage}. This login acts as ${text(ws.currentUserLogin) || "its minter"} (${text(ws.currentUserRole) || "role unknown"}). ${consoleOnly(slug, args.api)}`,
    warnings: [
      plan.ok ? null : `The plan could not be read (${plan.message}).`,
      summary && summary.countersReadable === false ? "The plan's counters could not be read right now, so used is not current." : null,
    ],
  });
}

function lastBuild(value: unknown): Row | null {
  if (!isRow(value)) return null;

  const browsers: Row = {};

  for (const job of Array.isArray(value.jobs) ? value.jobs.filter(isRow) : []) {
    const browser = text(job.browser);
    if (browser) browsers[browser] = text(job.conclusion) || text(job.status) || "unknown";
  }

  return { status: text(value.status) || "unknown", browsers };
}

async function readProjects(args: HandlerArgs): Promise<string> {
  const opened = await open(args, "projects");
  if ("refused" in opened) return opened.refused as string;

  const { api, workspace } = opened;
  const read = await platformApiGet<Row>(api, "/api/projects", { workspace });

  if (!read.ok) return refusal(args, "projects", read, workspace);

  const loggedIn = new Set(
    storedLoginsOn(args.api)
      .filter((entry) => entry.workspace === workspace)
      .map((entry) => entry.project),
  );
  const rows = (Array.isArray(read.json.projects) ? read.json.projects : []).filter(isRow).map((item): Row => {
    const slug = text(item.slug);
    const ref = slug ? { workspace, project: slug } : null;

    return {
      project: slug ? `${workspace}/${slug}` : null,
      projectId: text(item.id),
      displayName: text(item.displayName) || slug,
      description: text(item.description),
      visibility: text(item.visibility) || null,
      browsers: strings(item.browsers),
      channels: strings(item.channels),
      lastBuild: lastBuild(item.lastBuild),
      updatedAt: text(item.updatedAt) || null,
      loggedIn: slug ? loggedIn.has(slug.toLowerCase()) : false,
      ...(ref ? { consoleUrl: consoleProjectUrl(ref, ConsoleProjectPage.overview, args.api) } : {}),
    };
  });
  const failing = rows.filter((row) => (row.lastBuild as Row | null)?.status === "failed").map((row) => row.project);
  const total = typeof read.json.total === "number" ? read.json.total : rows.length;

  return envelope({
    ok: true,
    command: COMMAND,
    status: "listed",
    value: { action: "projects", workspace, total, projects: rows, login: loginOf(api) },
    hint:
      rows.length === 0
        ? `${workspace} has no projects yet. Create one with extension_project_create.`
        : `${workspace} has ${total} project${total === 1 ? "" : "s"}${failing.length ? `; the last build failed for ${failing.join(", ")}` : ""}. loggedIn says which have a login on this machine; extension_builds and extension_release_status read one with its login, and extension_auth (action: "login", workspace: "${workspace}", projects: "*") signs in to all of them.`,
  });
}

async function readUsage(args: HandlerArgs): Promise<string> {
  const opened = await open(args, "usage");
  if ("refused" in opened) return opened.refused as string;

  const { api, workspace } = opened;
  const read = await platformApiGet<Row>(api, `/api/workspaces/${encodeURIComponent(workspace)}/usage`);

  if (!read.ok) return refusal(args, "usage", read, workspace);

  const totals = isRow(read.json.totals) ? read.json.totals : {};
  const projects = (Array.isArray(read.json.projects) ? read.json.projects : []).filter(isRow).map((item): Row => {
    const slug = text(item.slug);

    return {
      project: slug ? `${workspace}/${slug}` : null,
      projectId: text(item.projectId),
      displayName: text(item.displayName) || slug,
      billableMinutes: item.billableMinutes ?? 0,
      runCount: item.runCount ?? 0,
      grossAmountUsd: item.grossAmountUsd ?? 0,
      netAmountUsd: item.netAmountUsd ?? 0,
      shareOfWorkspace: item.shareOfWorkspace ?? 0,
      skus: Array.isArray(item.skus) ? item.skus : [],
    };
  });
  const period = text(read.json.period) || null;

  return envelope({
    ok: true,
    command: COMMAND,
    status: "read",
    value: {
      action: "usage",
      workspace,
      period,
      generatedAt: text(read.json.generatedAt) || null,
      totals,
      projects,
      login: loginOf(api),
      console: workspaceConsole(workspace, args.api),
    },
    hint: `${workspace} used ${totals.billableMinutes ?? 0} billable CI minutes over ${totals.runCount ?? 0} runs in ${period ?? "this period"} (gross $${totals.grossAmountUsd ?? 0}, net $${totals.netAmountUsd ?? 0}). ${consoleOnly(workspace, args.api)}`,
  });
}

function unknownAction(action: string, args: HandlerArgs): string {
  return envelope({
    ok: false,
    command: COMMAND,
    status: "bad-request",
    value: { action },
    error: {
      code: "E_BAD_REQUEST",
      name: "WorkspaceInputError",
      message: `action must be one of ${ACTIONS.join(", ")}; got "${action}". ${consoleOnly(text(args.workspace), args.api)}`,
    },
  });
}

async function readAction(action: Action, args: HandlerArgs): Promise<string> {
  if (action === "set-visibility") return setVisibility(args);
  if (action === "projects") return readProjects(args);
  if (action === "usage") return readUsage(args);
  if (action === "settings") return readProjectSettings(args);
  if (action === CONFIGURE_PROJECT) return configureProject(args);
  if (action === SET_ENVIRONMENT) return setEnvironment(args);

  return readInfo(args);
}

export async function handler(args: HandlerArgs): Promise<string> {
  const action = text(args.action) || "info";
  const include = includesOf(args.include);

  if (!(ACTIONS as readonly string[]).includes(action)) return unknownAction(action, args);
  if (include.bad.length) return badInclude(include.bad, action);

  const base = await readAction(action as Action, args);
  if (!include.sections.length) return base;

  return attachIncludes(base, await open(args, action as Action), include.sections, args.api);
}
