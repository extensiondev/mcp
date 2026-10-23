// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { ConsoleProjectPage } from "@extension.dev/urls/paths";

import { evaluateApproval, requestApprovalAfterRefusal, type ApprovalGateInput } from "../lib/approval-gate";
import { approvalVerdict } from "../lib/approval-policy";
import { consoleProjectUrl } from "../lib/console-urls";
import { envelope } from "../lib/envelope";
import {
  OWNER_REQUIRED_CODE,
  openProjectApi,
  projectApiGet,
  projectApiOpenFailure,
  projectApiReadFailure,
  projectApiSend,
  tokenRefusal,
  type ProjectApi,
  type ProjectApiRefusal,
} from "../lib/project-api";
import { isRow, text } from "../lib/ship-act";
import { trackUrl } from "../lib/track-url";

export const COMMAND = "extension_workspace";
export const CONFIGURE_PROJECT = "configure-project";
export const PROJECT_SETTINGS_ACTION = "extension_settings.project";
const SLUG_CODE = "SLUG_NOT_WRITABLE_HERE";

type Row = Record<string, unknown>;
type Section = "general" | "deployment" | "github" | "releases";

const STRING_FIELDS = ["displayName", "description", "url", "supportUrl", "branch", "rootDirectory", "workspaceRoot"] as const;
const BOOLEAN_FIELDS = ["buildPullRequests", "runWhatsNew", "pullRequestComments", "commitComments", "autoCreateGitHubRelease"] as const;
const PLATFORMS = ["linux", "macos", "windows"] as const;

export const SECTION_FIELDS: Record<Section, readonly string[]> = {
  general: ["displayName", "description", "url", "supportUrl"],
  deployment: ["branch", "rootDirectory", "workspaceRoot", "buildPullRequests", "runWhatsNew", "runExtensionExecutables"],
  github: ["pullRequestComments", "commitComments"],
  releases: ["autoCreateGitHubRelease"],
};

export const SETTINGS_FIELDS = [...Object.values(SECTION_FIELDS).flat(), "liveChannel"];

const ROUTES: Record<Section, string> = {
  general: "settings/general",
  deployment: "settings/deployment",
  github: "settings/github",
  releases: "settings/releases",
};

export interface ConfigureProjectArgs {
  settings?: unknown;
  approvalId?: string;
  project?: string;
  api?: string;
}

function badRequest(name: string, message: string, extra: Row = {}): string {
  return envelope({
    ok: false,
    command: COMMAND,
    status: "bad-request",
    value: { action: CONFIGURE_PROJECT, ...extra },
    error: { code: "E_BAD_REQUEST", name, message },
  });
}

/* @invariant THE SLUG IS NEVER SENT. The platform refuses a slug on its
 * general settings route (400 SLUG_NOT_WRITABLE_HERE, ruling 2026-10-22: a
 * rebrand never renames the project under its console URLs, logins and
 * channel links), and this server refuses it before anything is sent, so a
 * body naming one changes nothing else either.
 */
export function readSettingsChange(raw: unknown): { change: Row } | { problem: string; code?: string } {
  if (!isRow(raw) || Object.keys(raw).length === 0) {
    return { problem: `settings must name at least one of ${SETTINGS_FIELDS.join(", ")}.` };
  }

  if ("slug" in raw) {
    return { problem: "The project slug cannot be changed from here or anywhere else: it is minted once at onboarding, and changing the name never renames the project.", code: SLUG_CODE };
  }

  const unknown = Object.keys(raw).filter((key) => !SETTINGS_FIELDS.includes(key));

  if (unknown.length) {
    return { problem: `settings has ${unknown.map((key) => `"${key}"`).join(", ")}, which is not a project setting this call writes; use ${SETTINGS_FIELDS.join(", ")}.` };
  }

  const change: Row = {};

  for (const [key, value] of Object.entries(raw)) {
    if ((STRING_FIELDS as readonly string[]).includes(key) && typeof value !== "string") return { problem: `settings.${key} must be a string.` };
    if ((BOOLEAN_FIELDS as readonly string[]).includes(key) && typeof value !== "boolean") return { problem: `settings.${key} must be true or false.` };

    if (key === "liveChannel" && value !== null && (typeof value !== "string" || !value.trim())) {
      return { problem: "settings.liveChannel must name one of the project's channels, or be null for the default order." };
    }

    if (key === "runExtensionExecutables" && typeof value !== "boolean" && !(isRow(value) && PLATFORMS.every((os) => typeof value[os] === "boolean"))) {
      return { problem: "settings.runExtensionExecutables must be true, false, or { linux, macos, windows } booleans." };
    }

    change[key] = value;
  }

  return { change };
}

function shown(value: unknown): string {
  if (value === null || value === undefined) return "null";

  const rendered = JSON.stringify(typeof value === "string" && value.length > 80 ? `${value.slice(0, 77)}...` : value);

  return rendered;
}

function same(a: unknown, b: unknown): boolean {
  const left = JSON.stringify(a ?? null);
  const right = JSON.stringify(b ?? null);

  return left === right;
}

function sectionOf(change: Row, section: Section): Row {
  const body: Row = {};

  for (const key of SECTION_FIELDS[section]) if (key in change) body[key] = change[key];

  return body;
}

function current(json: Row, key: string): unknown {
  if (key === "rootDirectory" || key === "workspaceRoot" || key === "url" || key === "supportUrl") return text(json[key]) || "";

  return key in json ? json[key] : null;
}

export function refusal(sent: ProjectApiRefusal, api: ProjectApi, args: ConfigureProjectArgs, value: Row = {}): string {
  const context = { workspace: api.ref.workspace, project: `${api.ref.workspace}/${api.ref.project}` };

  if (sent.held || sent.status === 0 || tokenRefusal(sent.code, context) || sent.code === OWNER_REQUIRED_CODE) {
    return projectApiReadFailure(COMMAND, sent, { api: args.api, name: "ProjectSettings", value: { action: CONFIGURE_PROJECT, ...value }, context });
  }

  const status = sent.status === 400 ? "bad-request" : sent.status === 404 ? "not-found" : sent.status === 401 || sent.status === 403 ? "refused" : "unavailable";

  return envelope({
    ok: false,
    command: COMMAND,
    status,
    value: { action: CONFIGURE_PROJECT, ...value },
    error: {
      code: status === "bad-request" ? "E_BAD_REQUEST" : status === "refused" ? "E_AUTH_DENIED" : "E_PLATFORM",
      name: `ProjectSettings${status === "bad-request" ? "InputError" : "Refused"}`,
      ...(sent.code ? { platformCode: sent.code } : {}),
      message: sent.message,
    },
    ...(sent.status === 401 ? { hint: "The platform in front of this server does not take this setting from a token yet, so nothing was changed; the console project settings page is where it is set until it does." } : {}),
  });
}

async function liveChannelAudience(api: ProjectApi, name: string): Promise<{ audience: string } | { missing: string } | { refused: ProjectApiRefusal }> {
  const list = await projectApiGet<unknown>(api, "channels");
  if (!list.ok) return { refused: list };

  const rows = (Array.isArray(list.json) ? list.json : []).filter(isRow);
  const found = rows.find((row) => text(row.name).toLowerCase() === name.toLowerCase() || text(row.id).toLowerCase() === name.toLowerCase());

  if (!found) return { missing: rows.map((row) => text(row.name) || text(row.id)).filter(Boolean).join(", ") };

  return { audience: text(found.audience).toLowerCase() || "private" };
}

/* @invariant A LIVE CHANNEL THAT IS PUBLIC KEEPS THE APPROVE PAGE, AND IT IS
 * ASKED BEFORE ANYTHING IS WRITTEN. The live channel decides what the
 * project's live link serves, so pointing it at a channel whose recorded
 * audience is public resolves to the channel-audience row of the policy
 * table (ruling 2026-10-23), minted under this act's own name the way a
 * listed store mode mints under extension_settings.store: the approval is
 * evaluated first, with the plain
 * sections of the same call still unwritten, so a blocked call changes
 * nothing and the retry with approvalId applies the whole change at once.
 * A private live channel, and every other field here, is a plain write
 * under the owner's own token.
 */
export async function configureProject(args: ConfigureProjectArgs): Promise<string> {
  const read = readSettingsChange(args.settings);
  if ("problem" in read) return badRequest("ProjectSettingsInputError", `${read.problem} Nothing was sent.`, read.code ? { platformCode: read.code } : {});

  const opened = await openProjectApi({ command: COMMAND, project: args.project, api: args.api });
  if (!opened.ok) return projectApiOpenFailure(COMMAND, opened, { api: args.api, name: "ProjectSettings", value: { action: CONFIGURE_PROJECT } });

  const api = opened.api;
  const project = `${api.ref.workspace}/${api.ref.project}`;
  const change = read.change;
  const touched = (Object.keys(SECTION_FIELDS) as Section[]).filter((section) => Object.keys(sectionOf(change, section)).length > 0);
  const wantsLive = "liveChannel" in change;
  const reads = [...new Set([...touched, ...(wantsLive ? (["general"] as Section[]) : [])])];
  const stored: Partial<Record<Section, Row>> = {};

  for (const section of reads) {
    const got = await projectApiGet<Row>(api, ROUTES[section]);
    if (!got.ok) return refusal(got, api, args, { section });

    stored[section] = got.json;
  }

  const changes: string[] = [];
  const bodies: Partial<Record<Section, Row>> = {};

  for (const section of touched) {
    const body: Row = {};

    for (const [key, value] of Object.entries(sectionOf(change, section))) {
      const was = current(stored[section] ?? {}, key);
      if (same(was, value)) continue;

      body[key] = value;
      changes.push(`${key}: ${shown(was)} -> ${shown(value)}`);
    }

    if (Object.keys(body).length) bodies[section] = body;
  }

  const liveWas = text(stored.general?.liveChannel) || null;
  const liveNext = wantsLive ? (change.liveChannel === null ? null : text(change.liveChannel)) : undefined;
  const liveChanges = liveNext !== undefined && liveNext !== liveWas;
  const gateFor = (name: string): ApprovalGateInput => ({
    command: COMMAND,
    action: PROJECT_SETTINGS_ACTION,
    scope: { channel: name, audience: "public" },
    write: { audience: "public" },
    description: `Serve the public channel ${name} at ${project}'s live link: liveChannel ${shown(liveWas)} -> ${shown(name)}.`,
    token: api.token,
    api: args.api,
    refusedStatus: "configure-project-refused",
    body: { liveChannel: name },
    reason: `${name} is a public channel, so making it the live channel changes what ${project}'s live link serves to anyone who opens it; a workspace owner approves this exact change on the approve page first.`,
    stateRead: 'extension_workspace (action: "settings")',
    approvalId: text(args.approvalId) || undefined,
    enabled: true,
  });
  let gate: ApprovalGateInput | null = null;

  if (liveChanges && liveNext) {
    const looked = await liveChannelAudience(api, liveNext);
    if ("refused" in looked) return refusal(looked.refused, api, args, { liveChannel: liveNext });

    if ("missing" in looked) {
      return badRequest("ProjectSettingsInputError", `${project} has no channel named ${liveNext}${looked.missing ? `; its channels are ${looked.missing}` : ""}. Nothing was changed.`, { liveChannel: liveNext });
    }

    if (approvalVerdict(PROJECT_SETTINGS_ACTION, { audience: looked.audience }) === "approval") {
      gate = gateFor(liveNext);
      const asked = await evaluateApproval(gate);
      if (asked.blocked) return asked.envelope;
    }
  }

  if (liveChanges) changes.push(`liveChannel: ${shown(liveWas)} -> ${shown(liveNext)}`);

  const page = trackUrl("project-settings", { workspace: api.ref.workspace, project: api.ref.project }, args.api);

  if (!changes.length) {
    return envelope({
      ok: true,
      command: COMMAND,
      status: "unchanged",
      value: { action: CONFIGURE_PROJECT, project, settings: change, changes: [], trackUrl: page },
      hint: `${project}'s settings already read this way, so nothing was written.`,
    });
  }

  const applied: string[] = [];

  for (const section of touched) {
    const body = bodies[section];
    if (!body) continue;

    const sent = await projectApiSend<Row>(api, "PUT", ROUTES[section], body);
    if (!sent.ok) return refusal(sent, api, args, { section, applied, changes });

    applied.push(section);
  }

  if (liveChanges) {
    const approvalId = gate ? text(args.approvalId) : "";
    const sent = await projectApiSend<Row>(api, "PUT", ROUTES.general, { liveChannel: liveNext, ...(approvalId ? { approvalId } : {}) });

    if (!sent.ok && sent.code === "APPROVAL_REQUIRED" && !approvalId && liveNext) return requestApprovalAfterRefusal(gate ?? gateFor(liveNext));

    if (!sent.ok) return refusal(sent, api, args, { liveChannel: liveNext, applied, changes });

    applied.push("liveChannel");
  }

  const gateLine = gate ? " The live channel change went through the approve page; the other fields were plain settings under your own token." : " These were plain settings under your own token; no approval page was involved.";

  return envelope({
    ok: true,
    command: COMMAND,
    status: "project-configured",
    value: { action: CONFIGURE_PROJECT, project, settings: change, changes, applied, trackUrl: page },
    hint: `${project}'s settings now read: ${changes.join("; ")}.${gateLine} Read them back with extension_workspace (action: "settings"); the console page is ${page}.`,
  });
}

const BROWSERS = ["chrome", "edge", "firefox", "safari"] as const;

export async function readProjectSettings(args: { project?: string; api?: string }): Promise<string> {
  const opened = await openProjectApi({ command: COMMAND, project: text(args.project) || undefined, api: args.api });
  if (!opened.ok) return projectApiOpenFailure(COMMAND, opened, { api: args.api, name: "Workspace", value: { action: "settings" } });

  const api = opened.api;
  const project = `${api.ref.workspace}/${api.ref.project}`;
  const context = { workspace: api.ref.workspace, project };
  const [general, build, deployment, github, releases] = await Promise.all([
    projectApiGet<Row>(api, ROUTES.general),
    projectApiGet<Row>(api, "settings/build"),
    projectApiGet<Row>(api, ROUTES.deployment),
    projectApiGet<Row>(api, ROUTES.github),
    projectApiGet<Row>(api, ROUTES.releases),
  ]);

  if (!general.ok) return projectApiReadFailure(COMMAND, general, { api: args.api, name: "Workspace", value: { action: "settings", workspace: api.ref.workspace }, context });
  if (!build.ok) return projectApiReadFailure(COMMAND, build, { api: args.api, name: "Workspace", value: { action: "settings", workspace: api.ref.workspace }, context });

  const perBrowser = isRow(build.json.buildSettings) ? build.json.buildSettings : {};
  const enabled = isRow(build.json.enabledBrowsers) ? build.json.enabledBrowsers : {};
  const browsers: Row = {};

  for (const browser of BROWSERS) if (isRow(perBrowser[browser])) browsers[browser] = perBrowser[browser];

  const on = BROWSERS.filter((browser) => enabled[browser] === true);
  const unread = (what: string, read: { ok: false; message: string }) => `${what} could not be read (${read.message}); the console project settings page has it.`;

  return envelope({
    ok: true,
    command: COMMAND,
    status: "read",
    value: {
      action: "settings",
      project,
      general: general.json,
      build: browsers,
      enabledBrowsers: on,
      deployment: deployment.ok ? deployment.json : null,
      github: github.ok ? github.json : null,
      releases: releases.ok ? releases.json : null,
      consoleUrl: consoleProjectUrl(api.ref, ConsoleProjectPage.projectSettings, args.api),
    },
    hint: `${project} builds for ${on.length ? on.join(", ") : "no browser"}. extension_builds (action: "configure") changes the build commands; extension_workspace (action: "configure-project") changes the general, deployment, GitHub and release fields, each a plain call under the owner's own token.`,
    warnings: [
      deployment.ok ? null : unread("The deployment settings", deployment),
      github.ok ? null : unread("The GitHub settings", github),
      releases.ok ? null : unread("The release settings", releases),
    ],
  });
}
