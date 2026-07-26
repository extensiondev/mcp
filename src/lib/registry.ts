// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { readCredentials } from "./credentials";
import {
  defaultRegistryAccessTokens,
  withAccessToken,
  type RegistryAccessTokens,
} from "./registry-access";
import { PROD_ORIGINS, resolveOrigins, type Origins } from "@extension.dev/urls/origins";
import { consoleProjectPath } from "@extension.dev/urls/paths";
import {
  UserlandProjectPage,
  userlandUrl,
} from "@extension.dev/urls/userland";

export const REGISTRY_BASE_DEFAULT = PROD_ORIGINS.registry;

export function mcpOrigins(apiHint?: string): Origins {
  const www =
    String(apiHint || process.env.EXTENSION_DEV_API_URL || "").trim() || undefined;
  return resolveOrigins(
    {
      www,
      console: process.env.EXTENSION_DEV_CONSOLE_URL,
      inspect: process.env.EXTENSION_DEV_INSPECT_URL,
      preview: process.env.EXTENSION_DEV_PREVIEW_URL,
      userland: process.env.EXTENSION_DEV_USERLAND_URL,
      registry: process.env.EXTENSION_DEV_REGISTRY_URL,
      media: process.env.EXTENSION_MEDIA_ORIGIN,
    },
    { hint: www },
  );
}

export function consoleBase(apiHint?: string): string {
  return mcpOrigins(apiHint).console;
}

export function registryBase(): string {
  return mcpOrigins().registry;
}

export interface ProjectRef {
  workspace: string;
  project: string;
}

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

export function registryFileUrl(ref: ProjectRef, file: string): string {
  return `${registryBase()}/${encodeURIComponent(ref.workspace)}/${encodeURIComponent(
    ref.project,
  )}/_extension-dev/${file}`;
}

export function consoleProjectUrl(
  ref: ProjectRef | null,
  page: string,
  apiHint?: string,
): string {
  const base = consoleBase(apiHint);
  if (!ref) return base;
  return `${base}${consoleProjectPath(ref, page)}`;
}

export function userlandProjectUrl(
  ref: ProjectRef | null,
  page = "",
  apiHint?: string,
): string {
  if (!ref) return "";
  try {
    return userlandUrl(ref, page, { base: mcpOrigins(apiHint).userland });
  } catch {
    return "";
  }
}

export type RegistryFetchResult<T> =
  | { ok: true; json: T }
  | { ok: false; status?: number; message: string };

async function readJson<T>(
  url: string,
  res: Response,
): Promise<RegistryFetchResult<T>> {
  try {
    const text = await res.text();
    return { ok: true, json: JSON.parse(text) as T };
  } catch {
    return { ok: false, message: `${url} did not return valid JSON` };
  }
}

export async function fetchRegistryJson<T = unknown>(
  url: string,
  fetchImpl: typeof fetch = fetch,
  options?: { ref?: ProjectRef | null; api?: string; tokens?: RegistryAccessTokens },
): Promise<RegistryFetchResult<T>> {
  const tokens = options?.tokens ?? defaultRegistryAccessTokens;
  const ref = options?.ref ?? null;

  const cached = ref ? tokens.peek(ref) : "";
  const firstUrl = cached ? withAccessToken(url, cached) : url;

  let res: Response;
  try {
    res = await fetchImpl(firstUrl);
  } catch (err: any) {
    return { ok: false, message: `Could not reach ${url}: ${err?.message || err}` };
  }
  if (res.ok) return readJson<T>(url, res);

  const authFailed = res.status === 401 || res.status === 403;
  if (!authFailed || !ref) {
    return {
      ok: false,
      status: res.status,
      message: `${url} returned ${res.status}`,
    };
  }

  const grant = await tokens.get(ref, options?.api);
  if (grant.status !== "ok") {
    const detail =
      grant.status === "no-credential"
        ? "This project is private. Run extension_auth (action: login) for it, or set EXTENSION_DEV_TOKEN."
        : grant.status === "public"
          ? "The platform reports this project is public, but the registry refused the read."
          : grant.message;
    return {
      ok: false,
      status: res.status,
      message: `${url} returned ${res.status}. ${detail}`,
    };
  }

  let retried: Response;
  try {
    retried = await fetchImpl(withAccessToken(url, grant.token));
  } catch (err: any) {
    return { ok: false, message: `Could not reach ${url}: ${err?.message || err}` };
  }
  if (!retried.ok) {
    return {
      ok: false,
      status: retried.status,
      message: `${url} returned ${retried.status} even with an access token`,
    };
  }
  return readJson<T>(url, retried);
}

export interface ChannelEntry {
  channel: string;
  sha: string;
  buildId?: string;
  version?: string;
  promotedAt?: string;
  description?: string;
}

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

export function mirrorActionsUrlFromRunUrl(runUrl: unknown): string | null {
  const match = String(runUrl ?? "").match(
    /^(https:\/\/github\.com\/extensiondev\/[^/]+)\/actions\b/,
  );
  return match ? `${match[1]}/actions` : null;
}
