// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { ConsoleProjectPage } from "@extension.dev/urls/paths";

import { consoleProjectUrl, resolveProjectRef } from "../lib/registry";
import { envelope } from "../lib/envelope";
import {
  OWNER_REQUIRED_CODE,
  openProjectApi,
  projectApiGet,
  projectApiOpenFailure,
  projectApiReadFailure,
  type ProjectApi,
} from "../lib/project-api";
import { contradictoryRef } from "./store-status";

const COMMAND = "extension_release_status";
const MAX_RELEASES = 10;
const EVENTS_PER_RELEASE = 5;
const EVENTS_FOR_ONE_RELEASE = 20;

type Row = Record<string, unknown>;

export interface Scope {
  workspace?: string;
  project?: string;
  api?: string;
}

function isRow(value: unknown): value is Row {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : "";
}

function noProject(scope: Scope, name: string): string {
  return envelope({
    ok: false,
    command: COMMAND,
    status: "auth-required",
    value: {},
    error: {
      code: "E_AUTH_REQUIRED",
      name,
      message:
        contradictoryRef(scope) ??
        "No project to read. Run extension_auth (action: login), which names the project, or pass workspace + project explicitly.",
    },
  });
}

export async function openFor(scope: Scope, name: string): Promise<{ ok: true; api: ProjectApi } | { ok: false; out: string }> {
  const ref = resolveProjectRef(scope);
  if (!ref) return { ok: false, out: noProject(scope, `${name}InputError`) };

  const named = Boolean(scope.workspace || scope.project);
  const opened = await openProjectApi({
    command: COMMAND,
    project: named ? `${ref.workspace}/${ref.project}` : undefined,
    api: scope.api,
    expect: { workspace: ref.workspace, project: ref.project },
  });

  if (!opened.ok) {
    return {
      ok: false,
      out: projectApiOpenFailure(COMMAND, opened, {
        api: scope.api,
        name,
        value: { workspace: ref.workspace, project: ref.project },
      }),
    };
  }

  return { ok: true, api: opened.api };
}

function eventView(raw: Row): Row {
  const out: Row = {};

  for (const key of ["timestamp", "event", "type", "status", "actor", "browser", "channel", "build", "version", "rollback"]) {
    const value = raw[key];
    if (typeof value === "boolean") out[key] = value;
    else if (text(value)) out[key] = text(value);
  }

  return out;
}

async function readEvents(api: ProjectApi, releaseId: string, limit: number) {
  const read = await projectApiGet<Row>(api, `releases/${encodeURIComponent(releaseId)}/events`, { limit });
  if (!read.ok) return { ok: false as const, message: read.message, held: read.held, body: read.body };

  const items = (Array.isArray(read.json.items) ? read.json.items : []).filter(isRow).map(eventView);

  return {
    ok: true as const,
    events: items,
    total: typeof read.json.total === "number" ? read.json.total : items.length,
  };
}

export async function readReleaseHistory(scope: Scope): Promise<string> {
  const opened = await openFor(scope, "ReleaseHistory");
  if (!opened.ok) return opened.out;

  const api = opened.api;
  const where = { workspace: api.ref.workspace, project: api.ref.project };
  const [list, promoteReady] = await Promise.all([
    projectApiGet<Row>(api, "releases"),
    projectApiGet<Row>(api, "releases/promote-ready"),
  ]);

  if (!list.ok) return projectApiReadFailure(COMMAND, list, { api: scope.api, name: "ReleaseHistory", value: where });

  const all = (Array.isArray(list.json.items) ? list.json.items : []).filter(isRow);
  const shown = all.slice(0, MAX_RELEASES);
  const events = await Promise.all(shown.map((item) => readEvents(api, text(item.id), EVENTS_PER_RELEASE)));
  const unreadEvents: string[] = [];

  const releases = shown.map((item, i) => {
    const id = text(item.id);
    const read = events[i];
    const row: Row = { id };

    for (const key of ["browser", "channel", "build", "version", "status", "rollout", "health", "createdAt"]) {
      if (text(item[key])) row[key] = text(item[key]);
    }

    if (isRow(item.promotion)) row.promotion = item.promotion;
    if (isRow(item.store)) row.store = item.store;

    row.consoleUrl = consoleProjectUrl(api.ref, ConsoleProjectPage.release(id), scope.api);

    if (read.ok) {
      row.events = read.events;
      if (read.total > read.events.length) row.moreEvents = read.total - read.events.length;
    } else {
      unreadEvents.push(`${id}: ${read.message}`);
    }

    return row;
  });

  const ownerOnly = !promoteReady.ok && promoteReady.code === OWNER_REQUIRED_CODE;
  const promoteReadyView: Row = promoteReady.ok
    ? { read: true, ...promoteReady.json }
    : ownerOnly
      ? { read: false, needsOwner: true }
      : { read: false, reason: promoteReady.message };

  return envelope({
    ok: true,
    command: COMMAND,
    status: "read",
    value: {
      ...where,
      ...(isRow(list.json.summary) ? { summary: list.json.summary } : {}),
      releases,
      ...(all.length > shown.length ? { moreReleases: all.length - shown.length } : {}),
      promoteReady: promoteReadyView,
      releasesPageUrl: consoleProjectUrl(api.ref, ConsoleProjectPage.releases, scope.api),
    },
    hint:
      releases.length > 0
        ? `${releases.length} release${releases.length === 1 ? "" : "s"} with up to ${EVENTS_PER_RELEASE} recent events each, newest first. Pass releaseId with one of these ids for that release and up to ${EVENTS_FOR_ONE_RELEASE} of its events.`
        : "No releases are recorded for this project yet. Promote a build with extension_release_promote to cut one.",
    warnings: [
      ownerOnly
        ? "Whether a build is ready to promote was not read: that read needs a token minted by a workspace owner, and this login's minter is not one."
        : null,
      unreadEvents.length ? `Events could not be read for ${unreadEvents.join("; ")}.` : null,
      all.length > shown.length ? `Only the first ${MAX_RELEASES} of ${all.length} releases are shown.` : null,
    ],
  });
}

export async function readOneRelease(scope: Scope & { releaseId: string }): Promise<string> {
  const opened = await openFor(scope, "Release");
  if (!opened.ok) return opened.out;

  const api = opened.api;
  const releaseId = scope.releaseId.trim();
  const where = { workspace: api.ref.workspace, project: api.ref.project, releaseId };
  const [detail, events] = await Promise.all([
    projectApiGet<Row>(api, `releases/${encodeURIComponent(releaseId)}`),
    readEvents(api, releaseId, EVENTS_FOR_ONE_RELEASE),
  ]);

  if (!detail.ok) return projectApiReadFailure(COMMAND, detail, { api: scope.api, name: "Release", value: where });

  return envelope({
    ok: true,
    command: COMMAND,
    status: "read",
    value: {
      ...where,
      release: detail.json,
      events: events.ok ? events.events : [],
      ...(events.ok && events.total > events.events.length ? { moreEvents: events.total - events.events.length } : {}),
      consoleUrl: consoleProjectUrl(api.ref, ConsoleProjectPage.release(releaseId), scope.api),
    },
    hint: `Release ${releaseId} is ${text(detail.json.status) || "of unknown status"} on build ${text(detail.json.build) || "unknown"}${
      events.ok ? `, with ${events.events.length} recorded event${events.events.length === 1 ? "" : "s"} shown` : ""
    }.`,
    warnings: [events.ok ? null : `Its events could not be read (${events.message}).`],
  });
}
