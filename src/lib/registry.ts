// Public registry client (registry.extension.land).
//
// The platform publishes each project's release state as plain public JSON:
//
//   https://registry.extension.land/<workspace>/<project>/_extension-dev/meta.json
//   https://registry.extension.land/<workspace>/<project>/_extension-dev/channels.json
//   https://registry.extension.land/<workspace>/<project>/_extension-dev/builds/index.json
//   https://registry.extension.land/<workspace>/<project>/_extension-dev/stores/health.json
//   https://registry.extension.land/<workspace>/<project>/_extension-dev/stores/status.json
//   https://registry.extension.land/<workspace>/<project>/builds/<sha>/build.json
//
// No auth is needed for public projects (private ones 404 without a share
// token), so the release tools use this to answer "which shas exist, where do
// promotions land, and is a store actually configured" without inventing a
// new platform endpoint. Reads are best-effort: a registry blip must never
// fail the verb it decorates.

import { readCredentials } from "./credentials";

export const REGISTRY_BASE_DEFAULT = "https://registry.extension.land";
export const CONSOLE_BASE = "https://console.extension.dev";

export function registryBase(): string {
  const fromEnv = String(process.env.EXTENSION_DEV_REGISTRY_URL || "").trim();
  return (fromEnv || REGISTRY_BASE_DEFAULT).replace(/\/+$/, "");
}

export interface ProjectRef {
  workspace: string;
  project: string;
}

/**
 * Resolve which project registry reads should target: explicit overrides
 * first, then the stored login's workspace/project slugs. Returns null when
 * neither names a project (e.g. token came from EXTENSION_DEV_TOKEN and no
 * login was ever stored).
 */
export function resolveProjectRef(overrides?: {
  workspace?: string;
  project?: string;
}): ProjectRef | null {
  const workspace = String(overrides?.workspace || "").trim();
  const project = String(overrides?.project || "").trim();
  if (workspace && project) return { workspace, project };
  const creds = readCredentials();
  const ws = workspace || String(creds?.workspaceSlug || "").trim();
  const proj = project || String(creds?.projectSlug || "").trim();
  if (!ws || !proj) return null;
  return { workspace: ws, project: proj };
}

/** URL of a file under the project's `_extension-dev/` registry directory. */
export function registryFileUrl(ref: ProjectRef, file: string): string {
  return `${registryBase()}/${encodeURIComponent(ref.workspace)}/${encodeURIComponent(
    ref.project,
  )}/_extension-dev/${file}`;
}

/** Console page URL for the project (builds, releases/new, stores, ...). */
export function consoleProjectUrl(ref: ProjectRef | null, page: string): string {
  if (!ref) return `${CONSOLE_BASE}`;
  return `${CONSOLE_BASE}/${encodeURIComponent(ref.workspace)}/${encodeURIComponent(
    ref.project,
  )}/${page}`;
}

export type RegistryFetchResult<T> =
  | { ok: true; json: T }
  | { ok: false; status?: number; message: string };

/**
 * Fetch a registry JSON file. Never throws: 404s (private or never-built
 * projects), network failures, and non-JSON bodies all come back as
 * `{ok:false}` so callers can degrade honestly instead of crashing the verb.
 */
export async function fetchRegistryJson<T = unknown>(
  url: string,
  fetchImpl: typeof fetch = fetch,
): Promise<RegistryFetchResult<T>> {
  let res: Response;
  try {
    res = await fetchImpl(url);
  } catch (err: any) {
    return { ok: false, message: `Could not reach ${url}: ${err?.message || err}` };
  }
  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      message: `${url} returned ${res.status}`,
    };
  }
  try {
    const text = await res.text();
    return { ok: true, json: JSON.parse(text) as T };
  } catch {
    return { ok: false, message: `${url} did not return valid JSON` };
  }
}

export interface ChannelEntry {
  channel: string;
  sha: string;
  buildId?: string;
  version?: string;
  /** ISO timestamp parsed from the channel row when the writer recorded one. */
  promotedAt?: string;
  description?: string;
}

/**
 * Normalize the registry's channels.json (a map of channel -> row) into a
 * list. `promotedAt` is not a first-class field in the file today; the
 * promote workflow stamps it into the description ("Promoted from X on
 * <ISO>"), so it is parsed back out when present.
 */
export function parseChannels(json: unknown): ChannelEntry[] {
  if (!json || typeof json !== "object" || Array.isArray(json)) return [];
  const out: ChannelEntry[] = [];
  for (const [channel, raw] of Object.entries(json as Record<string, unknown>)) {
    if (!raw || typeof raw !== "object") continue;
    const row = raw as Record<string, unknown>;
    const description = typeof row.description === "string" ? row.description : undefined;
    const promotedAtField =
      typeof row.promotedAt === "string" && row.promotedAt ? row.promotedAt : undefined;
    const fromDescription = description?.match(
      /\bon (\d{4}-\d{2}-\d{2}T[0-9:.]+Z?)/,
    )?.[1];
    const entry: ChannelEntry = {
      channel,
      sha: String(row.sha ?? ""),
    };
    if (row.buildId) entry.buildId = String(row.buildId);
    if (row.version) entry.version = String(row.version);
    const promotedAt = promotedAtField || fromDescription;
    if (promotedAt) entry.promotedAt = promotedAt;
    if (description) entry.description = description;
    out.push(entry);
  }
  return out;
}

export interface BuildIndexItem {
  sha: string;
  commit?: string;
  channel?: string;
  buildEnv?: string;
  status?: string;
  version?: string;
  message?: string;
  timestamp?: string;
  browsers?: string[];
}

/** Normalize `_extension-dev/builds/index.json` items (schemaVersion 3). */
export function parseBuildIndex(json: unknown): BuildIndexItem[] {
  const items = (json as { items?: unknown[] } | null)?.items;
  if (!Array.isArray(items)) return [];
  const out: BuildIndexItem[] = [];
  for (const raw of items) {
    if (!raw || typeof raw !== "object") continue;
    const row = raw as Record<string, unknown>;
    const sha = String(row.shortSha ?? row.sha ?? row.id ?? row.buildId ?? "").trim();
    if (!sha) continue;
    const entry: BuildIndexItem = { sha };
    if (row.commit) entry.commit = String(row.commit);
    if (row.channel) entry.channel = String(row.channel);
    if (row.buildEnv) entry.buildEnv = String(row.buildEnv);
    if (row.status) entry.status = String(row.status);
    if (row.version) entry.version = String(row.version);
    if (typeof row.message === "string") {
      entry.message = row.message.split("\n", 1)[0];
    }
    if (row.timestamp) entry.timestamp = String(row.timestamp);
    if (Array.isArray(row.browsers)) {
      entry.browsers = row.browsers.map((b) => String(b)).filter(Boolean);
    }
    out.push(entry);
  }
  return out;
}

/**
 * Derive the project mirror repo's Actions URL from any GitHub run URL the
 * registry exposes (stores/status.json carries one from the mirror's own
 * runs: https://github.com/extensiondev/<ownerGithubId>--<projectId>/actions/
 * runs/<id>). Only trusts the extensiondev org so a user-source-repo run URL
 * (build.json's runUrl) is never mistaken for the mirror.
 */
export function mirrorActionsUrlFromRunUrl(runUrl: unknown): string | null {
  const match = String(runUrl ?? "").match(
    /^(https:\/\/github\.com\/extensiondev\/[^/]+)\/actions\b/,
  );
  return match ? `${match[1]}/actions` : null;
}
