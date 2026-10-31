// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import {
  ConsoleProjectPage,
  consoleProjectPath,
  consoleWorkspacePath,
  withQuery,
} from "@extension.dev/urls/paths";

import { consoleBase } from "./console-urls";
import { resolveCredential } from "./credential-source";
import { envelope, isEnvelope, type Envelope } from "./envelope";

type Row = Record<string, unknown>;

export type TrackPage =
  | "console"
  | "workspace"
  | "project"
  | "builds"
  | "build"
  | "releases"
  | "release"
  | "submissions"
  | "store"
  | "submission"
  | "build-settings"
  | "project-settings"
  | "environment"
  | "store-settings"
  | "channels"
  | "visibility"
  | "share-links"
  | "access-tokens"
  | "team"
  | "connected-apps"
  | "activity"
  | "members";

export interface TrackTarget {
  workspace?: string;
  project?: string;
  buildId?: string;
  browser?: string;
  channel?: string;
  releaseId?: string;
  store?: string;
  submissionId?: string;
}

const PROJECT_PAGES: Record<Exclude<TrackPage, "console" | "workspace" | "members">, (t: TrackTarget) => string> = {
  project: () => ConsoleProjectPage.overview,
  builds: () => ConsoleProjectPage.builds,
  build: (t) => (t.buildId ? ConsoleProjectPage.build(t.buildId, t.browser) : ConsoleProjectPage.builds),
  releases: (t) => withQuery(ConsoleProjectPage.releases, { channel: t.channel }),
  release: (t) =>
    t.releaseId ? ConsoleProjectPage.release(t.releaseId) : withQuery(ConsoleProjectPage.releases, { channel: t.channel }),
  submissions: () => ConsoleProjectPage.submissions,
  store: (t) => (t.store ? ConsoleProjectPage.store(t.store) : ConsoleProjectPage.submissions),
  submission: (t) =>
    t.store && t.submissionId
      ? ConsoleProjectPage.submission(t.store, t.submissionId)
      : t.store
        ? ConsoleProjectPage.storeSubmissions(t.store)
        : ConsoleProjectPage.submissions,
  "build-settings": () => ConsoleProjectPage.projectSettingsSection("build"),
  "project-settings": () => ConsoleProjectPage.projectSettingsSection("general"),
  environment: () => ConsoleProjectPage.projectSettingsSection("environment"),
  "store-settings": () => ConsoleProjectPage.projectSettingsSection("stores"),
  channels: () => ConsoleProjectPage.projectSettingsSection("channels"),
  visibility: () => ConsoleProjectPage.projectSettingsSection("visibility"),
  "share-links": () => ConsoleProjectPage.projectSettingsSection("share-links"),
  "access-tokens": () => ConsoleProjectPage.projectSettingsSection("access-tokens"),
  team: () => ConsoleProjectPage.projectSettingsSection("team"),
  "connected-apps": () => ConsoleProjectPage.projectSettingsSection("connected-apps"),
  activity: () => ConsoleProjectPage.activity,
};

const WORKSPACE_INCLUDE_PAGES: Record<string, TrackPage> = {
  team: "team",
  tokens: "access-tokens",
  apps: "connected-apps",
  activity: "activity",
  members: "members",
  environment: "environment",
};

export function trackUrl(page: TrackPage, target: TrackTarget, api?: string): string {
  const base = consoleBase(api);
  const workspace = text(target.workspace);
  const project = text(target.project);

  if (page === "console" || !workspace) return base;
  if (page === "members") return `${base}${consoleWorkspacePath(workspace)}/settings/members`;
  if (page === "workspace" || !project) return `${base}${consoleWorkspacePath(workspace)}`;

  return `${base}${consoleProjectPath({ workspace, project }, PROJECT_PAGES[page](target))}`;
}

export interface TrackStep {
  page: TrackPage;
  target?: TrackTarget;
}

export interface TrackPlan {
  track: TrackStep;
  also?: TrackStep[];
}

export interface TrackCall {
  args: Row;
  status: string;
  value: Row;
}

const STORE_CONNECT_STATUSES = new Set(["store-not-connected", "store-connection-failed", "store-connection-unverified", "store-item-not-linked", "first-submission-in-partner-center"]);
const APPROVAL_STATUSES = new Set(["approval-required", "approval-pending", "authorization-pending"]);
const UNREACHED_CODES = new Set(["E_NETWORK", "E_SERVER_STALE"]);

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : "";
}

function isRow(value: unknown): value is Row {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function firstBrowser(args: Row): string {
  const browsers = Array.isArray(args.browsers) ? args.browsers.map(text).filter(Boolean) : [];

  return browsers.length === 1 ? browsers[0] : text(args.store);
}

const FULL_SHA = /^[a-f0-9]{40}$/i;

function buildOf(call: TrackCall): string {
  const build = isRow(call.value.build) ? call.value.build : {};
  const id = text(build.buildId) || text(call.value.buildSha) || text(call.value.buildId) || text(call.value.commit) || text(call.args.buildSha) || text(call.args.buildId);

  return FULL_SHA.test(id) ? id.slice(0, 7).toLowerCase() : id;
}

function shareSteps(buildId: string): TrackPlan {
  return { track: { page: "share-links" }, also: buildId ? [{ page: "build", target: { buildId } }] : [] };
}

function submitPlan(call: TrackCall): TrackPlan {
  const action = text(call.args.action) || "submit";

  if (action === "cancel") {
    return { track: { page: "submission", target: { store: text(call.args.store) || "chrome", submissionId: text(call.args.submissionId) } } };
  }

  if (action === "rollout") return { track: { page: "store", target: { store: "chrome" } } };

  if (action === "release") {
    const submissionId = text(call.value.submissionId) || text(call.args.submissionId);

    return { track: { page: submissionId ? "submission" : "store", target: { store: "safari", submissionId } } };
  }

  if (action === "configure-store") return { track: { page: "store-settings" } };

  if (action === "publish" || action === "review") {
    const submissionId = text(call.value.submissionId) || text(call.args.submissionId);
    const store = text(call.value.store) || firstBrowser(call.args) || "chrome";

    return { track: { page: submissionId ? "submission" : "store", target: { store, submissionId } } };
  }

  if (action === "preflight" && STORE_CONNECT_STATUSES.has(call.status)) return { track: { page: "store-settings" } };

  if (action === "preflight" || action === "sync-listing" || action === "status") {
    const answered = action === "status" && Array.isArray(call.value.stores) ? call.value.stores.filter(isRow).map((row) => text(row.store)) : [];
    const store = firstBrowser(call.args) || (answered.length === 1 ? answered[0] : "");

    return { track: { page: store ? "store" : "submissions", target: { store } } };
  }

  const retried = new Map(
    (Array.isArray(call.value.retried) ? call.value.retried : [])
      .filter(isRow)
      .map((row) => [text(row.store), text(row.submissionId)] as const),
  );
  const recorded = (call.args.dryRun === false && Array.isArray(call.value.submissions) ? call.value.submissions : [])
    .filter(isRow)
    .map((row) => ({
      store: text(row.store),
      submissionId: retried.get(text(row.store)) || text(row.id) || text(row.submissionId),
    }))
    .filter((row) => row.store);

  if (recorded.length) {
    const [first, ...rest] = recorded;

    return { track: { page: "submission", target: first }, also: rest.map((target) => ({ page: "submission", target })) };
  }

  const store = firstBrowser(call.args);

  return { track: { page: store ? "store" : "submissions", target: { store } } };
}

function releaseStatusPlan(call: TrackCall): TrackPlan {
  const releaseId = text(call.args.releaseId);
  if (releaseId) return { track: { page: "release", target: { releaseId } } };

  const include = Array.isArray(call.args.include) ? call.args.include.map(text) : [];
  const listingOnly = include.length > 0 && include.every((section) => section === "listing");

  if (listingOnly) {
    const store = text(call.args.store);

    return { track: store ? { page: "store", target: { store } } : { page: "submissions" } };
  }

  const storeOnly = include.length > 0 && include.every((section) => section === "stores" || section === "rollout");

  if (storeOnly) return { track: include.includes("stores") ? { page: "submissions" } : { page: "store", target: { store: "chrome" } } };

  return { track: { page: "releases" } };
}

export const TRACK_ACTS: Record<string, (call: TrackCall) => TrackPlan | null> = {
  extension_project_create: (call) => ({ track: { page: Array.isArray(call.args.projects) ? "workspace" : "project" } }),
  extension_workspace_create: () => ({ track: { page: "workspace" } }),
  extension_builds: (call) => {
    const action = text(call.args.action) || "list";
    const buildId = buildOf(call);

    if (action === "get") return { track: { page: "build", target: { buildId } } };
    if (action === "logs") return { track: { page: "build", target: { buildId, browser: text(call.args.browser).toLowerCase() } } };
    if (action === "rebuild" || action === "recheck" || action === "download") return { track: { page: "build", target: { buildId } } };
    if (action === "configure") return { track: { page: "build-settings" } };
    if (action === "create-channel") return { track: { page: "channels" } };

    return { track: { page: "builds" } };
  },
  extension_release_promote: (call) => {
    const action = text(call.args.action) || "promote";
    const channel = text(call.args.channel) || text(call.value.targetChannel) || text(call.value.channel);

    if (action === "cut") return { track: { page: "releases", target: { channel } } };

    return { track: { page: "release", target: { releaseId: text(call.value.releaseId), channel } } };
  },
  extension_release_status: releaseStatusPlan,
  extension_approvals: () => ({ track: { page: "project" } }),
  extension_submit: submitPlan,
  extension_publish: (call) => shareSteps(buildOf(call)),
  extension_shares: (call) => {
    const action = text(call.args.action) || "list";

    return action === "create" ? shareSteps(buildOf(call)) : { track: { page: "share-links" } };
  },
  extension_preview_web: (call) => (call.args.share === true ? { track: { page: "share-links" } } : null),
  extension_workspace: (call) => {
    const action = text(call.args.action) || "info";
    const include = Array.isArray(call.args.include) ? call.args.include.map(text) : [];
    const included = include.map((section) => WORKSPACE_INCLUDE_PAGES[section]).find(Boolean);

    if (included) return { track: { page: included } };
    if (action === "configure-project") return { track: { page: "project-settings" } };
    if (action === "set-environment") return { track: { page: "environment" } };

    return action === "settings" ? { track: { page: "build-settings" } } : { track: { page: "workspace" } };
  },
  extension_auth: (call) => {
    const action = text(call.args.action) || "status";

    if (action === "logout") return { track: { page: "access-tokens" } };
    if (call.status === "logged-out") return { track: { page: "console" } };
    if (Array.isArray(call.value.logins) && !text(call.value.projectSlug)) return { track: { page: "workspace" } };

    return { track: { page: "project" } };
  },
};

function splitPair(value: string): { workspace: string; project: string } | null {
  const [workspace, project, ...rest] = value.split("/");

  return workspace && project && !rest.length ? { workspace, project } : null;
}

function refOf(call: TrackCall): TrackTarget {
  const v = call.value;
  const a = call.args;
  const pairs = [text(v.project), text(a.project)].map(splitPair).filter(Boolean) as Array<{ workspace: string; project: string }>;

  if (text(v.workspaceSlug) && text(v.projectSlug)) return { workspace: text(v.workspaceSlug), project: text(v.projectSlug) };
  if (pairs.length) return pairs[0];
  if (text(v.workspace) && text(v.project)) return { workspace: text(v.workspace), project: text(v.project) };
  if (text(a.workspace) && text(a.project) && !text(a.project).includes("/")) return { workspace: text(a.workspace), project: text(a.project) };

  const workspace = text(v.workspaceSlug) || text(a.workspace) || (isRow(v.workspace) ? text(v.workspace.slug) : text(v.workspace));
  const credential = resolveCredential({ project: text(a.project) || undefined, api: text(a.api) || undefined });

  if (credential.ref && (!workspace || credential.ref.workspace === workspace.toLowerCase())) return { ...credential.ref };

  return workspace ? { workspace } : {};
}

function approvalPageOf(value: Row): string {
  return text(value.approvalUrl) || text(value.verificationUriComplete) || text(value.verificationUri);
}

function urlOf(step: TrackStep, ref: TrackTarget, api?: string): string {
  return trackUrl(step.page, { ...ref, ...(step.target ?? {}) }, api);
}

export interface TrackFields {
  trackUrl: string;
  checkUrl?: string;
  trackLinks?: string[];
}

export function trackFields(command: string, call: TrackCall, projectOnly = false): TrackFields | null {
  const plan = TRACK_ACTS[command]?.(call);
  if (!plan) return null;

  const api = text(call.args.api) || undefined;
  const ref = refOf(call);
  if (projectOnly && !ref.project) return null;

  const primary = urlOf(plan.track, ref, api);
  const also = (plan.also ?? []).map((step) => urlOf(step, ref, api));
  const approvalPage = APPROVAL_STATUSES.has(call.status) ? approvalPageOf(call.value) : "";

  if (approvalPage) return { trackUrl: approvalPage, checkUrl: primary };

  return also.length ? { trackUrl: primary, trackLinks: [primary, ...also] } : { trackUrl: primary };
}

function trackSentences(fields: TrackFields, hint: string, unreached = false): string[] {
  const out: string[] = [];

  if (unreached) return hint.includes(fields.trackUrl) ? out : [`The console page is ${fields.trackUrl}.`];
  if (!hint.includes(fields.trackUrl)) out.push(fields.checkUrl ? `Approve it at ${fields.trackUrl}.` : `Track it at ${fields.trackUrl}.`);
  if (fields.checkUrl && !hint.includes(fields.checkUrl)) out.push(`Once it is approved and done, check ${fields.checkUrl}.`);

  const buildPage = fields.trackLinks?.[1];
  if (buildPage && !hint.includes(buildPage)) out.push(`The build page is ${buildPage}.`);

  return out;
}

export function attachTrack(command: string, args: Row, result: string): string {
  let parsed: unknown;

  try {
    parsed = JSON.parse(result);
  } catch {
    return result;
  }

  if (!isEnvelope(parsed)) return result;

  const frame = parsed as Envelope & { hint?: string };
  const value = isRow(frame.value) ? frame.value : {};
  const unreached = frame.ok === false && UNREACHED_CODES.has(String(frame.error?.code ?? ""));
  const refusal = frame.ok !== true && !APPROVAL_STATUSES.has(String(frame.status)) && !unreached;
  if (refusal && text(value.trackUrl)) return result;

  const fields = trackFields(command, { args, status: String(frame.status), value }, refusal);
  if (!fields) return result;

  const hint = typeof frame.hint === "string" ? frame.hint.trim() : "";
  const links = Array.isArray(value.links) && !fields.checkUrl && !value.links.some((row) => isRow(row) && row.url === fields.trackUrl)
    ? { links: [{ kind: "track", url: fields.trackUrl, audience: "workspace members", expiresAt: null, made: false }, ...value.links] }
    : {};

  return envelope({
    ok: frame.ok,
    command: frame.command,
    status: frame.status,
    value: { ...value, ...fields, ...links },
    error: frame.error ?? undefined,
    warnings: frame.warnings,
    ...(frame.truncated !== undefined ? { truncated: frame.truncated } : {}),
    hint: [hint, ...trackSentences(fields, hint, unreached || refusal)].filter(Boolean).join(" "),
  });
}
