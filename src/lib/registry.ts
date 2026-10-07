// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { PROD_ORIGINS } from "@extension.dev/urls/origins";
import { consoleProjectPath } from "@extension.dev/urls/paths";
import {
  userlandUrl,
} from "@extension.dev/urls/userland";

import {
  defaultRegistryAccessTokens,
  withAccessToken,
  type RegistryAccessTokens,
} from "./registry-access";
import { readCredentials } from "./credentials";
import { mcpOrigins } from "./origins";
import {
  platformHoldMessage,
  readPlatformCode,
  readPlatformMessage,
  sawPlatformHold,
} from "./platform-hold";

export const REGISTRY_BASE_DEFAULT = PROD_ORIGINS.registry;

export { mcpOrigins };

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

function splitProjectName(name: string): ProjectRef | null {
  const parts = name.split("/");
  const workspace = String(parts[0] ?? "").trim();
  const project = String(parts[1] ?? "").trim();
  if (parts.length !== 2 || !workspace || !project) return null;

  return { workspace, project };
}

/* @invariant A `project` WRITTEN AS '<workspace>/<project>' IS ONE NAME, NOT A
 * SLUG WITH A SLASH IN IT. Every token-scoped tool takes `project` in that
 * form, and a pinned server writes it in that form into any tool that has a
 * `project` input, so this resolver receives it whether or not the tool that
 * called it documented a bare slug. Read as a slug, the pair was joined to the
 * active login's workspace and percent-encoded into a registry address that
 * names no project. It is split here instead. A workspace given beside it must
 * agree, and one that does not is a contradiction this refuses to settle.
 *
 * A bare slug with no workspace takes its workspace from the stored login that
 * slug names, when exactly one does, and only otherwise from the active login,
 * which is what it always did.
 */
export function resolveProjectRef(overrides?: {
  workspace?: string;
  project?: string;
}): ProjectRef | null {
  let workspace = String(overrides?.workspace || "").trim();
  let project = String(overrides?.project || "").trim();

  if (project.includes("/")) {
    const named = splitProjectName(project);
    if (!named) return null;

    if (workspace && workspace.toLowerCase() !== named.workspace.toLowerCase()) {
      return null;
    }

    workspace = named.workspace;
    project = named.project;
  }

  if (workspace && project) return { workspace, project };

  const creds =
    (project ? readCredentials({ project }) : null) ?? readCredentials();
  const ws = workspace || String(creds?.workspaceSlug || "").trim();
  const proj = project || String(creds?.projectSlug || "").trim();
  if (!ws || !proj) return null;

  return { workspace: ws, project: proj };
}

/* @invariant THE PROJECT A CALL NAMED IS THE PROJECT ITS ANSWER DESCRIBES.
 * A token-scoped tool picks its token with `project`, so every address it
 * builds afterwards, the registry index it reads, the console page and the
 * public URL it returns, has to come from that same login. Resolving them
 * with no argument took the ACTIVE login instead: with ten logins stored, a
 * publish for one project returned another project's registry address and
 * could fill a missing build sha or version from another project's build
 * index. This takes the same selector the token took. A
 * name with no stored login is used as written when it is a full
 * '<workspace>/<project>', and is no project at all otherwise: an answer that
 * names nothing is right where one that names the wrong project is not.
 */
export function loginProjectRef(selector?: string): ProjectRef | null {
  const named = String(selector ?? "").trim();
  if (!named) return resolveProjectRef();

  const creds = readCredentials({ project: named });
  const workspace = String(creds?.workspaceSlug || "").trim();
  const project = String(creds?.projectSlug || "").trim();
  if (workspace && project) return { workspace, project };

  return splitProjectName(named);
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

export interface RegistryFetchRefusal {
  ok: false;
  status?: number;
  message: string;
  code?: string;
  held?: boolean;
  body?: unknown;
}

export type RegistryFetchResult<T> = { ok: true; json: T } | RegistryFetchRefusal;

/* @invariant A FILE OF THE WRONG SHAPE IS UNREADABLE, NOT EMPTY. A 200 whose
   body is not the channels map or the build index used to parse to [] and
   read as "nothing recorded". */
export function channelsShapeProblem(json: unknown): string | null {
  if (!json || typeof json !== "object" || Array.isArray(json)) return "the body is not a channels map";

  const bad = Object.entries(json as Record<string, unknown>).find(([, row]) => !row || typeof row !== "object");

  return bad ? `channel ${bad[0]} is not an object` : null;
}

export function buildIndexShapeProblem(json: unknown): string | null {
  const items = (json as { items?: unknown } | null)?.items;

  return Array.isArray(items) ? null : "the body has no items list";
}

export function requireShape<T>(
  read: RegistryFetchResult<T>,
  problem: (json: unknown) => string | null,
): RegistryFetchResult<T> {
  if (!read.ok) return read;

  const why = problem(read.json);

  return why ? { ok: false, message: `answered 200 but ${why}` } : read;
}

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

/* @invariant
 * A REFUSAL BODY SURVIVES THE HOP OR THE READER GETS A NUMBER.
 *
 * This function used to answer `${url} returned ${status}` and never open the
 * body at all, so every sentence the platform wrote to explain itself, the
 * hold's PLATFORM_NOT_OPEN refusal included, was thrown away one line before it
 * reached a person. Measured against the published 10.4.3 tarball: an agent
 * asking why a read failed was handed "https://... returned 403" and nothing
 * else. Reading the body costs one await on a path that has already failed.
 *
 * It is read ONCE and carried, because a Response body is a stream and a second
 * read throws. Everything downstream reads `body` from the result rather than
 * touching the response again.
 */
async function readRefusal(
  res: Response,
): Promise<{ body: unknown; message: string; code: string }> {
  let text: string;

  try {
    text = await res.text();
  } catch {
    return { body: null, message: "", code: "" };
  }

  let body: unknown;

  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }

  const message = readPlatformMessage(body) || text.trim().slice(0, 500);

  return { body, message, code: readPlatformCode(body) };
}

function refusalResult(
  url: string,
  res: Response,
  refusal: { body: unknown; message: string; code: string },
  suffix = "",
): RegistryFetchRefusal {
  const held = sawPlatformHold(res, refusal.body);
  const base = `${url} returned ${res.status}${suffix}`;

  return {
    ok: false,
    status: res.status,
    ...(refusal.code ? { code: refusal.code } : {}),
    ...(held ? { held: true } : {}),
    body: refusal.body,
    message: held
      ? platformHoldMessage(refusal.body)
      : refusal.message
        ? `${base}: ${refusal.message}`
        : base,
  };
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

  const refusal = await readRefusal(res);
  const held = sawPlatformHold(res, refusal.body);

  const authFailed = res.status === 401 || res.status === 403;

  /* @invariant A held lane is not an auth problem, so it never buys a grant.
   * The hold answers 403, which is the same status a private project answers,
   * and minting an access token to retry a lane the platform has shut spends a
   * round trip to be refused identically. Reading the code first also keeps the
   * refusal the reader sees the platform's own, rather than the "this project
   * is private" guess the grant path would attach to it. */
  if (held || !authFailed || !ref) {
    return refusalResult(url, res, refusal);
  }

  const grant = await tokens.get(ref, options?.api);

  if (grant.status !== "ok") {
    const detail =
      grant.status === "no-credential"
        ? "This project is private. Run extension_auth (action: login) for it, or set EXTENSION_DEV_TOKEN."
        : grant.status === "public"
          ? "The platform reports this project is public, but the registry refused the read."
          : grant.message;
    const carried = refusalResult(url, res, refusal);

    return { ...carried, message: `${carried.message} ${detail}` };
  }

  let retried: Response;

  try {
    retried = await fetchImpl(withAccessToken(url, grant.token));
  } catch (err: any) {
    return { ok: false, message: `Could not reach ${url}: ${err?.message || err}` };
  }

  if (!retried.ok) {
    const retriedRefusal = await readRefusal(retried);

    return refusalResult(
      url,
      retried,
      retriedRefusal,
      " even with an access token",
    );
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
  summaryStatus?: string;
  version?: string;
  message?: string;
  timestamp?: string;
  browsers?: string[];
}

/* @invariant THE INDEX SAYS "ready" FOR A FINISHED BUILD. The deploy lane
 * writes `ready` into builds/index.json and the console reads `ready` and
 * `success` as one state, while this package only accepted `success`, so
 * extension_publish answered buildSha/version/builtAt as null for a project
 * with three READY builds. The vocabulary lives here
 * once and every "successful build" read goes through it. */
export function isSuccessfulBuild(item: Pick<BuildIndexItem, "status" | "summaryStatus">): boolean {
  const status = String(item?.status ?? "")
    .trim()
    .toLowerCase();

  return (status === "success" || status === "ready") && !isPartialBuild(item);
}

/* @invariant THE WRITER SETS status: "success" BESIDE summaryStatus:
   "partial" WHEN AT LEAST ONE BROWSER BUILT, so a build with a failed
   browser read as the newest successful, promotable build. */
export function isPartialBuild(item: Pick<BuildIndexItem, "summaryStatus">): boolean {
  return String(item?.summaryStatus ?? "").trim().toLowerCase() === "partial";
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
    if (row.summaryStatus) entry.summaryStatus = String(row.summaryStatus);
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
