// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { platformFetch } from "./platform-fetch";
import { readPlatformCode, readPlatformMessage, sawPlatformHold } from "./platform-hold";
import { projectApiGet, type ProjectApi, type ProjectApiRead } from "./project-api";
import { identityHeaders } from "./session-identity";
import { isRow, text } from "./ship-act";

const LINK_ID = /^[A-Za-z0-9_-]{8,128}$/;
const BUILD_SCOPE = /^build:([0-9a-f]{7,40})$/i;

type Row = Record<string, unknown>;

export interface BuildLinkView {
  id: string;
  kind: "build-link";
  label: string | null;
  build: string | null;
  scope: string | null;
  audience: string;
  issuedBy: string | null;
  createdAt: string | null;
  expiresAt: string | null;
  notAfter: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
  revokedBy: string | null;
  live: boolean;
  shareUrl: string | null;
}

export const BUILD_LINK_AUDIENCE = "anyone holding the link, until it expires or is revoked";

export const LAST_USE_NOTE = "lastUsedAt is null on every row: the platform does not record when a link was last opened.";

function orNull(value: unknown): string | null {
  return text(value) || null;
}

function after(stamp: string | null, now: number): boolean {
  if (!stamp) return true;

  const at = Date.parse(stamp);

  return !Number.isFinite(at) || at > now;
}

/* @invariant A BUILD LINK ROW IS COPIED BY NAME AND NEVER CARRIES A TOKEN
 * VALUE. The platform's access token list never stores a secret, and this view
 * names each field it answers so a field the platform adds later (a hash, a
 * claim, a raw token) stays behind; only a record of kind share is a build
 * link, and an api token on the same list is answered by extension_workspace
 * include tokens, never here.
 */
export function buildLinkView(raw: unknown, now = Date.now()): BuildLinkView | null {
  if (!isRow(raw) || text(raw.kind) !== "share") return null;

  const id = text(raw.id);
  if (!id) return null;

  const scope = orNull(raw.scope);
  const build = text(raw.buildSha) || (scope ? (BUILD_SCOPE.exec(scope)?.[1] ?? "") : "");
  const revokedAt = orNull(raw.revokedAt);
  const expiresAt = orNull(raw.expiresAt);
  const notAfter = orNull(raw.notAfter);

  return {
    id,
    kind: "build-link",
    label: orNull(raw.label),
    build: build || null,
    scope,
    audience: BUILD_LINK_AUDIENCE,
    issuedBy: orNull(raw.issuedBy),
    createdAt: orNull(raw.issuedAt),
    expiresAt,
    notAfter,
    lastUsedAt: orNull(raw.lastUsedAt),
    revokedAt,
    revokedBy: orNull(raw.revokedBy),
    live: !revokedAt && after(expiresAt, now) && after(notAfter, now),
    shareUrl: orNull(raw.shareUrl),
  };
}

export function parseBuildLinkRef(input: unknown): string | null {
  const value = text(input);
  if (!value) return null;
  if (LINK_ID.test(value)) return value;

  try {
    const url = new URL(value);
    const share = text(url.searchParams.get("share"));

    return LINK_ID.test(share) ? share : null;
  } catch {
    return null;
  }
}

export async function listBuildLinks(api: ProjectApi, now = Date.now()): Promise<ProjectApiRead<BuildLinkView[]>> {
  const read = await projectApiGet<Row>(api, "access-tokens");
  if (!read.ok) return read;

  const items = Array.isArray(read.json.items) ? read.json.items : [];

  return { ok: true, json: items.map((row) => buildLinkView(row, now)).filter((row): row is BuildLinkView => row !== null) };
}

export async function revokeBuildLink(
  api: ProjectApi,
  tokenId: string,
  approvalId?: string,
): Promise<ProjectApiRead<{ revoked: boolean; alreadyRevoked: boolean }>> {
  const url = `${api.base}/api/projects/${encodeURIComponent(api.projectId)}/access-tokens/${encodeURIComponent(tokenId)}`;
  const sent = await platformFetch(
    url,
    {
      method: "DELETE",
      headers: {
        authorization: `Bearer ${api.token}`,
        accept: "application/json",
        ...(approvalId ? { "x-extensiondev-approval": approvalId } : {}),
        ...identityHeaders(api.command),
      },
    },
    { kind: "dispatch" },
  );

  if (!sent.ok) return { ok: false, status: 0, code: "", message: sent.unreached.message, held: false, body: null };

  const res = sent.res;
  let body: unknown = null;

  try {
    body = JSON.parse(await res.text());
  } catch {
    body = null;
  }

  if (res.ok && isRow(body)) {
    return { ok: true, json: { revoked: body.ok === true, alreadyRevoked: body.alreadyRevoked === true } };
  }

  const message = readPlatformMessage(body);

  return {
    ok: false,
    status: res.status,
    code: readPlatformCode(body),
    message: `${url} answered ${res.status}${message ? `: ${message}` : ""}`,
    held: sawPlatformHold(res, body),
    body,
  };
}
