// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { ConsoleProjectPage, consoleWorkspacePath } from "@extension.dev/urls/paths";

import { consoleBase, consoleProjectUrl } from "../lib/console-urls";
import { envelope, isEnvelope, type Envelope } from "../lib/envelope";
import { platformApiGet, projectApiGet, type ProjectApi, type ProjectApiRead } from "../lib/project-api";
import { isRow, text } from "../lib/ship-act";
import { readEnvironment } from "./workspace-environment";

export const WORKSPACE_INCLUDES = ["team", "members", "tokens", "apps", "activity", "environment", "storeAccounts"] as const;

export type WorkspaceInclude = (typeof WORKSPACE_INCLUDES)[number];

const ACTIVITY_LIMIT = 50;
const PROJECT_SECTIONS: ReadonlySet<WorkspaceInclude> = new Set(["team", "tokens", "apps", "activity", "environment"]);

type Row = Record<string, unknown>;

type Section = { value: Row; say: string } | { warning: string };

export function includesOf(raw: unknown): { sections: WorkspaceInclude[]; bad: string[] } {
  const named = Array.isArray(raw) ? raw.map(text).filter(Boolean) : [];
  const sections = named.filter((name): name is WorkspaceInclude => (WORKSPACE_INCLUDES as readonly string[]).includes(name));

  return { sections: [...new Set(sections)], bad: named.filter((name) => !(WORKSPACE_INCLUDES as readonly string[]).includes(name)) };
}

export function badInclude(bad: string[], action: string): string {
  return envelope({
    ok: false,
    command: "extension_workspace",
    status: "bad-request",
    value: { action, include: bad },
    error: {
      code: "E_BAD_REQUEST",
      name: "WorkspaceInputError",
      message: `include must name only ${WORKSPACE_INCLUDES.join(", ")}; got ${bad.map((name) => `"${name}"`).join(", ")}. Nothing was read.`,
    },
  });
}

function orNull(value: unknown): string | null {
  return text(value) || null;
}

function rows(value: unknown): Row[] {
  return (Array.isArray(value) ? value : []).filter(isRow);
}

function unread(read: Extract<ProjectApiRead<unknown>, { ok: false }>, what: string, consoleUrl: string): string {
  const gone = read.status === 404;

  return gone
    ? `${what} could not be read: the platform in front of this server does not answer it to a token yet (${read.message}); the console lists it at ${consoleUrl}.`
    : `${what} could not be read (${read.message}); the console lists it at ${consoleUrl}.`;
}

function memberRow(raw: Row): Row {
  return {
    login: text(raw.login) || text(raw.id) || text(raw.githubLogin),
    role: text(raw.role) || "member",
    joinedAt: orNull(raw.joinedAt) ?? orNull(raw.addedAt),
  };
}

function inviteRow(raw: Row): Row {
  return {
    id: text(raw.id),
    email: orNull(raw.email),
    role: text(raw.role) || "member",
    invitedBy: orNull(raw.invitedBy),
    createdAt: orNull(raw.createdAt),
    expiresAt: orNull(raw.expiresAt),
  };
}

async function readTeam(api: ProjectApi, apiHint?: string): Promise<Section> {
  const consoleUrl = consoleProjectUrl(api.ref, ConsoleProjectPage.projectSettingsSection("team"), apiHint);
  const [members, invites] = await Promise.all([projectApiGet<unknown>(api, "team"), projectApiGet<unknown>(api, "team/invites")]);

  if (!members.ok) return { warning: unread(members, "The project team", consoleUrl) };

  const team = rows(members.json).map(memberRow);
  const pending = invites.ok ? rows(invites.json).map(inviteRow) : null;

  return {
    value: {
      members: team,
      invites: pending,
      ...(invites.ok ? {} : { invitesNote: unread(invites, "The project invites", consoleUrl) }),
      consoleUrl,
    },
    say: `The project team has ${team.length} member${team.length === 1 ? "" : "s"}${pending ? ` and ${pending.length} pending invite${pending.length === 1 ? "" : "s"}` : ""}; roles and invites change in the console.`,
  };
}

async function readMembers(api: ProjectApi, workspace: string, apiHint?: string): Promise<Section> {
  const consoleUrl = `${consoleBase(apiHint)}${consoleWorkspacePath(workspace)}/settings/members`;
  const path = `/api/workspaces/${encodeURIComponent(workspace)}/members`;
  const [members, invites] = await Promise.all([platformApiGet<Row>(api, path), platformApiGet<unknown>(api, `${path}/invites`)]);

  if (!members.ok) return { warning: unread(members, "The workspace members", consoleUrl) };

  const roster = rows(members.json.members).map(memberRow);
  const pending = invites.ok ? rows(invites.json).map(inviteRow) : null;

  return {
    value: {
      workspace,
      members: roster,
      invites: pending,
      ...(invites.ok ? {} : { invitesNote: unread(invites, "The workspace invites", consoleUrl) }),
      consoleUrl,
    },
    say: `${workspace} has ${roster.length} member${roster.length === 1 ? "" : "s"}${pending ? ` and ${pending.length} pending invite${pending.length === 1 ? "" : "s"}` : ""}; roles, invites and ownership change in the console.`,
  };
}

const ACCOUNT_STORES = ["chrome", "firefox", "edge", "safari"] as const;

const ACCOUNT_STORE_NAMES: Record<string, string> = {
  chrome: "Chrome Web Store",
  firefox: "Firefox Add-ons",
  edge: "Microsoft Edge Add-ons",
  safari: "App Store",
};

/* @invariant A WORKSPACE STORE ACCOUNT ROW NAMES THE ACCOUNT, NEVER A KEY.
 * Cezar ruled on 2026-10-24 that each store's account is saved once per
 * workspace; the platform's record holds the account name, when it was
 * connected and checked and the store's last answer, and this view copies
 * exactly those fields, so a field the platform adds later stays behind.
 * Connecting or disconnecting an account is the console's Store accounts page.
 */
function storeAccountRow(store: string, raw: unknown): Row {
  const row = isRow(raw) ? raw : null;

  return {
    store,
    connected: Boolean(row && text(row.kind)),
    connectedAs: row ? orNull(row.connectedAs) : null,
    connectedAt: row ? orNull(row.connectedAt) : null,
    checkedAt: row ? orNull(row.checkedAt) : null,
    healthy: row && typeof row.healthy === "boolean" ? row.healthy : null,
    ...(row && text(row.reason) ? { reason: text(row.reason) } : {}),
  };
}

async function readStoreAccounts(api: ProjectApi, workspace: string, apiHint?: string): Promise<Section> {
  const consoleUrl = `${consoleBase(apiHint)}${consoleWorkspacePath(workspace)}/settings/store-accounts`;
  const read = await platformApiGet<Row>(api, `/api/workspaces/${encodeURIComponent(workspace)}/store-accounts`);

  if (!read.ok) return { warning: unread(read, "The workspace store accounts", consoleUrl) };

  const accounts = isRow(read.json.storeAccounts) ? read.json.storeAccounts : {};
  const list = ACCOUNT_STORES.map((store) => storeAccountRow(store, accounts[store]));
  const connected = list.filter((row) => row.connected);
  const named = connected.map((row) => `${ACCOUNT_STORE_NAMES[String(row.store)]}${row.connectedAs ? ` (${String(row.connectedAs)})` : ""}`);

  return {
    value: { workspace, accounts: list, consoleUrl },
    say: connected.length
      ? `${workspace} has a store account for ${named.join(", ")}; every project without its own key uses it, and accounts are connected or disconnected on the workspace's Store accounts page.`
      : `${workspace} has no store account yet; each is connected once on the workspace's Store accounts page, and every project then uses it.`,
  };
}

/* @invariant A TOKEN ROW NEVER CARRIES A VALUE. The platform's access token
 * list stores no secret, and this view names every field it answers so a
 * field the platform adds later stays behind; the link a share row opens is
 * answered by extension_shares (kind build-link), not here.
 */
function tokenRow(raw: Row): Row {
  const revokedAt = orNull(raw.revokedAt);

  return {
    id: text(raw.id),
    label: orNull(raw.label),
    kind: text(raw.kind) || "api",
    createdAt: orNull(raw.issuedAt),
    expiresAt: orNull(raw.expiresAt),
    notAfter: orNull(raw.notAfter),
    issuedBy: orNull(raw.issuedBy),
    build: orNull(raw.buildSha),
    lastUsedAt: orNull(raw.lastUsedAt),
    revoked: Boolean(revokedAt),
    revokedAt,
    revokedBy: orNull(raw.revokedBy),
  };
}

async function readTokens(api: ProjectApi, apiHint?: string): Promise<Section> {
  const consoleUrl = consoleProjectUrl(api.ref, ConsoleProjectPage.projectSettingsSection("access-tokens"), apiHint);
  const read = await projectApiGet<Row>(api, "access-tokens");

  if (!read.ok) return { warning: unread(read, "The access tokens", consoleUrl) };

  const tokens = rows(read.json.items).map(tokenRow);
  const live = tokens.filter((row) => row.revoked !== true).length;

  return {
    value: { tokens, consoleUrl, lastUseNote: "lastUsedAt is null on every row: the platform does not record when a token was last used." },
    say: `${live} of ${tokens.length} access token${tokens.length === 1 ? "" : "s"} (build links included, as kind share) are unrevoked; a token's value is never answered, and minting or revoking one is done in the console.`,
  };
}

function appRow(raw: Row): Row {
  return {
    id: text(raw.id),
    name: text(raw.clientName) || text(raw.name),
    redirectHost: orNull(raw.redirectHost),
    ...(Array.isArray(raw.scopes) ? { scopes: raw.scopes.map(text).filter(Boolean) } : {}),
    connectedBy: orNull(raw.connectedBy),
    projects: Array.isArray(raw.projects) ? raw.projects.map(text).filter(Boolean) : [],
    connectedAt: orNull(raw.connectedAt),
    lastRefreshedAt: orNull(raw.lastRefreshedAt),
    expiresAt: orNull(raw.expiresAt),
  };
}

async function readApps(api: ProjectApi, apiHint?: string): Promise<Section> {
  const consoleUrl = consoleProjectUrl(api.ref, ConsoleProjectPage.projectSettingsSection("connected-apps"), apiHint);
  const read = await projectApiGet<Row>(api, "connected-apps");

  if (!read.ok) return { warning: unread(read, "The connected apps", consoleUrl) };

  const apps = rows(read.json.items).map(appRow);

  return {
    value: { apps, consoleUrl },
    say: `${apps.length} connected app${apps.length === 1 ? "" : "s"} hold${apps.length === 1 ? "s" : ""} a live grant on the project; disconnecting one is done in the console.`,
  };
}

/* @invariant AN ACTIVITY ENTRY IS COPIED BY NAME, AND NO FIELD THAT NAMES A
 * MIRROR OR A RUN LEAVES. The platform's activity feed merges the registry's
 * record with the project's GitHub workflow runs, whose rows carry the mirror
 * repository, a run URL and the workflow name; an answer never names a mirror
 * or an Actions run (ruling 2026-10-19), so only the fields named here are
 * answered, and the entry's source is dropped with them.
 */
function activityRow(raw: Row): Row {
  const details = isRow(raw.details) ? raw.details : {};
  const actor = isRow(details.actor) ? details.actor : null;
  const browsers = rows(details.browsers).map((browser) => ({ name: text(browser.name), status: text(browser.status) }));
  const picked: Row = {};

  for (const key of ["commit", "message", "version", "channel", "browser", "store", "build", "action"] as const) {
    const value = text(details[key]);
    if (value) picked[key] = value;
  }

  const branch = text(details.branch) || text(details.head_branch);
  if (branch) picked.branch = branch;
  if (browsers.length) picked.browsers = browsers;

  if (actor && (text(actor.githubLogin) || text(actor.displayName))) {
    picked.actor = { login: orNull(actor.githubLogin), displayName: orNull(actor.displayName) };
  }

  return {
    id: text(raw.id),
    category: text(raw.category),
    event: text(raw.eventKind),
    status: text(raw.status),
    at: orNull(raw.createdAt),
    details: picked,
  };
}

async function readActivity(api: ProjectApi, apiHint?: string): Promise<Section> {
  const consoleUrl = consoleProjectUrl(api.ref, ConsoleProjectPage.activity, apiHint);
  const read = await projectApiGet<Row>(api, "activity", { limit: ACTIVITY_LIMIT });

  if (!read.ok) return { warning: unread(read, "The activity log", consoleUrl) };

  const entries = rows(read.json.items).map(activityRow);
  const total = typeof read.json.total === "number" ? read.json.total : entries.length;

  return {
    value: { entries, total, consoleUrl },
    say: `The activity log's ${entries.length} newest entr${entries.length === 1 ? "y" : "ies"} (of ${total}) are listed, newest first.`,
  };
}

function readSection(section: WorkspaceInclude, api: ProjectApi, workspace: string, apiHint?: string): Promise<Section> {
  if (section === "team") return readTeam(api, apiHint);
  if (section === "members") return readMembers(api, workspace, apiHint);
  if (section === "tokens") return readTokens(api, apiHint);
  if (section === "apps") return readApps(api, apiHint);
  if (section === "environment") return readEnvironment(api, apiHint);
  if (section === "storeAccounts") return readStoreAccounts(api, workspace, apiHint);

  return readActivity(api, apiHint);
}

export async function attachIncludes(
  base: string,
  opened: { api: ProjectApi; workspace: string } | { refused: string },
  sections: WorkspaceInclude[],
  apiHint?: string,
): Promise<string> {
  let parsed: unknown;

  try {
    parsed = JSON.parse(base);
  } catch {
    return base;
  }

  if (!isEnvelope(parsed) || parsed.ok !== true) return base;

  const frame = parsed as Envelope & { hint?: string };
  const value = isRow(frame.value) ? frame.value : {};
  const warnings = Array.isArray(frame.warnings) ? frame.warnings : [];

  if ("refused" in opened) {
    let message = "no login served the read";

    try {
      const refusal = JSON.parse(opened.refused) as Envelope;
      message = text((refusal.error as Row | undefined)?.message) || message;
    } catch {
      message = "no login served the read";
    }

    return envelope({
      ok: frame.ok,
      command: frame.command,
      status: frame.status,
      value,
      hint: frame.hint,
      warnings: [...warnings, `include ${sections.join(", ")} could not be read: ${message}`],
    });
  }

  const { api, workspace } = opened;
  const read = await Promise.all(sections.map((section) => readSection(section, api, workspace, apiHint)));
  const added: Row = {};
  const says: string[] = [];
  const failed: string[] = [];

  sections.forEach((section, i) => {
    const result = read[i];

    if ("warning" in result) {
      failed.push(result.warning);

      return;
    }

    added[section] = result.value;
    says.push(result.say);
  });

  const project = sections.some((section) => PROJECT_SECTIONS.has(section)) ? { project: `${api.ref.workspace}/${api.ref.project}` } : {};

  return envelope({
    ok: frame.ok,
    command: frame.command,
    status: frame.status,
    value: { ...value, ...project, ...added },
    hint: [text(frame.hint), ...says].filter(Boolean).join(" "),
    warnings: [...warnings, ...failed],
  });
}
