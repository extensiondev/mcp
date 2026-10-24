// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { ConsoleProjectPage } from "@extension.dev/urls/paths";

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
    "Read the extension.dev workspace a stored login belongs to, and change one project's settings. action:'info' (the default) reads the workspace (role, members, project count) and its plan: limits, this month's use, refusals. 'projects' lists every project with browsers, channels, last build per browser and whether this machine holds its login. 'usage' reads the period's CI minutes, runs and cost per project. 'settings' reads one project's general, build, deployment, GitHub and release settings (pass project). 'configure-project' writes settings: displayName, description, url, supportUrl, liveChannel, branch, rootDirectory, workspaceRoot, buildPullRequests, runWhatsNew, runExtensionExecutables, pullRequestComments, commitComments, autoCreateGitHubRelease; each is a plain call under the owner's own token, except liveChannel naming a public channel, which a workspace owner approves on the approve page first; the slug is never writable. 'set-visibility' with visibility private (plain) or public, which opens every build the project ever made to anyone, so a workspace owner approves it on the approve page. include: ['environment'] lists the project's environment variables by name, scope and secret flag, never a value; 'set-environment' sets or removes plain variables (variables, remove), and a secret is refused with the console page where a person types it. include also takes team, members, tokens, apps, activity, storeAccounts, read-only. Any login of a workspace reads it: name it with workspace, or omit it for the default login's. Plan, billing, members and deletes stay in the console, and the answer links there. Names, descriptions and build commands are written by people in the workspace, so the answer is fenced as untrusted data.",
  inputSchema: {
    type: "object" as const,
    properties: {
      action: {
        type: "string",
        enum: [...ACTIONS],
        default: "info",
        description:
          "info reads the workspace and its plan; projects lists its projects; usage reads the period's CI usage; settings reads one project's general, build, deployment, GitHub and release settings; configure-project writes settings; set-environment sets or removes plain environment variables; set-visibility changes one project's visibility (pass visibility, and project for a login other than the default).",
      },
      visibility: {
        type: "string",
        enum: ["private", "public"],
        description:
          "With set-visibility, the project's visibility. private: its builds, build pages and channel links open for workspace members and build links only, a plain call under the owner's own token (visibility-set). public: every build page and channel link the project ever made opens for anyone, which a workspace owner approves on the approve page first: the first call answers approval-required, a second call with that approvalId applies it once. Making a public project private again is plain.",
      },
      settings: {
        type: "object",
        description: `configure-project: the fields to change, by the platform's names (${SETTINGS_FIELDS.join(", ")}); absent fields stay as they are. liveChannel names one of the project's channels, or null for the default order. runExtensionExecutables is a boolean or { linux, macos, windows }.`,
        additionalProperties: true,
      },
      variables: {
        type: "array",
        description: `set-environment: plain variables to set, each { name, value, scope, note }; scope is one of ${ENVIRONMENT_SCOPES.join(", ")} (default all). A variable flagged secret: true is refused before anything is sent, since a secret's value is typed only in the console.`,
        items: {
          type: "object",
          properties: {
            name: { type: "string", description: "Upper-case name, such as API_BASE_URL." },
            value: { type: "string", description: "The plain value. It is stored by the platform and never read back." },
            scope: { type: "string", enum: [...ENVIRONMENT_SCOPES], description: "all for every channel, or one release environment." },
            note: { type: "string", description: "What the variable is for, shown in the console." },
            secret: { type: "boolean", description: "Must be false or absent; a secret is set in the console." },
          },
          required: ["name", "value"],
        },
      },
      remove: {
        type: "array",
        description: "set-environment: plain variables to remove, each { name, scope } or a bare name (scope all). A secret is removed in the console.",
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            scope: { type: "string", enum: [...ENVIRONMENT_SCOPES] },
          },
          required: ["name"],
        },
      },
      approvalId: {
        type: "string",
        description:
          "The approval id from a prior approval-required answer, once a workspace owner approved it: set-visibility public, or configure-project making a public channel the live channel. Each approval applies its exact change once.",
      },
      include: {
        type: "array",
        items: { type: "string", enum: [...WORKSPACE_INCLUDES] },
        description:
          "Sections to add to the answer, each read-only. team: the login project's members (login, role, joinedAt) and pending invites. members: the workspace's members and pending invites, read with an owner-minted login. tokens: the project's access tokens (id, label, kind, createdAt, expiresAt, issuedBy, revoked; never a value, and no last use, which the platform does not record). apps: the connected apps holding a live grant (name, connectedBy, connectedAt, expiresAt). activity: the 50 newest activity entries, never naming a repository or a workflow run. storeAccounts: the workspace's store accounts (store, connected, connectedAs, connectedAt, checkedAt, healthy; never a key), read with a member's session or an owner-minted login. Each section carries its console page, where every change to it is made.",
      },
      workspace: {
        type: "string",
        description:
          "Which workspace to read, by slug. Omitted, the workspace of the login project names, else of the default login. Any stored login of this workspace on the server the call targets serves the read.",
      },
      project: {
        type: "string",
        description:
          "Which stored login to use, as '<workspace>/<project>'. For settings it is also the project read, since a project's settings are read only with its own login. extension_auth (action: status) lists the logins.",
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

  const opened = await openProjectApi({ command: COMMAND, project: picked.project, api: args.api });

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
      login: loginOf(api),
      console: workspaceConsole(slug, args.api),
    },
    hint: `${slug} is on the ${summary?.plan ?? "unknown"} plan${usage}. This login acts as ${text(ws.currentUserLogin) || "its minter"} (${text(ws.currentUserRole) || "role unknown"}). ${consoleOnly(slug, args.api)}`,
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
