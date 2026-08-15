// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { API_BASE } from "../lib/common-schema";
import {
  ZIP_URL_REDIRECT_NOTE,
  listArtifacts,
  parseArtifactRef,
  revokeArtifact,
  wwwRevokeUrl,
  type ArtifactOwner,
  type ArtifactPublisher,
  type ListedArtifact,
} from "../lib/artifacts-api";
import {
  readSharedPreviews,
  type SharedPreviewEntry,
} from "../lib/share-record";
import { envelope } from "../lib/envelope";
import { resolveToken } from "../lib/publish";
import { evaluateApproval } from "../lib/approval-gate";
import {
  PLATFORM_HOLD_CODE,
  PLATFORM_HOLD_STILL_WORKS,
  platformHoldEnvelope,
  templatesOrigin,
} from "../lib/platform-hold";

const LOGIN_HINT =
  "Run extension_auth (action: login), or set EXTENSION_DEV_TOKEN (create one in the extension.dev dashboard).";

export const schema = {
  name: "extension_shares",
  description:
    "List and revoke the public preview links this token has shared, which is what extension_preview_web share:true hands out. Pass action:'list' (the default) for every artifact the logged-in project owns, with its artifactId, name, version, live or dead state, createdAt, expiresAt, revokedAt, size, previewUrl, zipUrl and revokeUrl, so a link whose response you lost is findable again. Each row carries owner and sharedBy as the platform returned them. Read attribution.ownership for who may revoke a share: 'project' means the workspace holds it and any member can pull it back, 'personal' means one person holds it alone, 'unknown' means no owner was disclosed. Read attribution.credit as credit only, never access; it names the publisher, and reads 'CLI token <id>' or 'not recorded' when no person can be named. Pass action:'revoke' with an artifactId, or with any URL of the share, to kill one permanently. Pass projectPath to reconcile against the project's own append-only .extension.dev/shared-previews.json, which is read and never rewritten: a share made on another machine shows as remoteOnly, a record with no live artifact as localOnly. That record is append-only, so localOnly is counted by distinct artifactId and a build re-shared unchanged is one share, not two; server.count and server.matched are share counts, while server.scanned counts records the platform read and is never a share count. This needs the same token as sharing (extension_auth or EXTENSION_DEV_TOKEN); without one, listing still returns the local record with a login hint.",
  inputSchema: {
    type: "object" as const,
    properties: {
      action: {
        type: "string",
        enum: ["list", "revoke"],
        default: "list",
        description:
          "list reads every share this token owns; revoke permanently kills one and cannot be undone.",
      },
      artifactId: {
        type: "string",
        description:
          "Which share to revoke (the gen_... id from a share response or from action:\"list\"). Required for revoke unless url is given.",
      },
      url: {
        type: "string",
        description:
          "Any URL of the share to revoke (previewUrl, zipUrl, viewUrl, or revokeUrl). The artifact id is read out of it, so the link you sent someone is enough to pull it back.",
      },
      approvalId: {
        type: "string",
        description:
          "The approval handle returned by a prior approval-required response for a revoke. Revoking permanently burns a share and cannot be undone, so when the platform's approval gate is on this needs a human approval: call revoke once without this to get an approval id and URL, have a human approve at extension.dev, then call revoke again with the same id. Listing never needs it.",
      },
      projectPath: {
        type: "string",
        description:
          "Path to the extension project root. Reconciles the platform's answer against this project's .extension.dev/shared-previews.json record. Read-only.",
      },
      status: {
        type: "string",
        enum: ["all", "live"],
        default: "all",
        description:
          "all (default) includes expired and revoked shares, which is what makes a dead link explainable; live returns only links that still resolve.",
      },
      limit: {
        type: "number",
        description:
          "How many shares to return, 1 to 200 (platform default 100). A cut list comes back with truncated:true.",
      },
      api: API_BASE,
    },
    required: [],
  },
};

type Ownership = "project" | "personal" | "unknown";

interface ShareAttribution {
  ownership: Ownership;
  ownerPath?: string;
  credit: string;
  creditSource: "login" | "tokenId" | "none";
  revocableBy: string;
}

const REVOCABLE_BY: Record<Ownership, string> = {
  project:
    "Any member of the owning workspace, and any token scoped to the owning project, can revoke this share.",
  personal:
    "This is one person's personal share. Only that person can see it and revoke it, so a project token cannot pull it back.",
  unknown:
    "The platform did not disclose an owner for this share, so who may revoke it cannot be stated here.",
};

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/* @invariant
 * Ownership is read off `owner` and never off `sharedBy`. The owner decides who
 * may revoke a share, and the publisher is a separate fact kept for credit
 * only: a project share stays revocable by the whole workspace no matter who
 * pressed the button, and a personal share stays that one person's no matter
 * which project they were working in at the time.
 */
function ownershipOf(owner: ArtifactOwner | null | undefined): Ownership {
  const kind = text(owner?.kind);
  if (kind === "project") return "project";
  if (kind === "user") return "personal";
  return "unknown";
}

/* @invariant
 * A login is the only thing that may be printed as a person. A CLI token whose
 * issuer the platform could not resolve arrives with `login: null`, and a share
 * made before attribution existed arrives with no `sharedBy` at all. Both are
 * reported as what they are. The workspace slug, the project slug and the owner
 * are never substituted, because naming a team where a human is expected reads
 * as an accusation against whoever the reader assumes that team to be.
 */
function creditOf(sharedBy: ArtifactPublisher | null | undefined): {
  credit: string;
  creditSource: "login" | "tokenId" | "none";
} {
  const login = text(sharedBy?.login);
  if (login) return { credit: login, creditSource: "login" };

  const tokenId = text(sharedBy?.tokenId);
  if (tokenId) {
    return { credit: `CLI token ${tokenId}`, creditSource: "tokenId" };
  }

  return {
    credit: sharedBy
      ? "not recorded: the platform could not resolve who published this share"
      : "not recorded: this share predates publisher attribution",
    creditSource: "none",
  };
}

function attributionOf(artifact: ListedArtifact): ShareAttribution {
  const ownership = ownershipOf(artifact.owner);
  const owner = artifact.owner;
  const ownerPath =
    ownership === "project" && owner && owner.kind === "project"
      ? [text(owner.workspace), text(owner.project)].filter(Boolean).join("/")
      : "";

  return {
    ownership,
    ...(ownerPath ? { ownerPath } : {}),
    ...creditOf(artifact.sharedBy),
    revocableBy: REVOCABLE_BY[ownership],
  };
}

/* @invariant
 * The unit of everything this tool counts is one artifactId, which is one live
 * address and one revoke handle, and never one row of the record file.
 *
 * `.extension.dev/shared-previews.json` is append-only by design, so re-sharing
 * an unchanged build writes a second row for the SAME id, and revoking then
 * re-sharing writes a row for a DIFFERENT id because a revoked id is burned.
 * Rows therefore over-count the first case and correctly count the second, and
 * a reader auditing what is still out there is asking about addresses. Mapping
 * rows straight to output made a project with four rows over three shares
 * report three dead links where two existed (B4 walk, 2026-08-04). The newest
 * row per id wins, because a later re-share carries the later expiresAt.
 */
function localIndex(entries: SharedPreviewEntry[]): Map<string, SharedPreviewEntry> {
  const index = new Map<string, SharedPreviewEntry>();
  for (const entry of entries) {
    const existing = index.get(entry.artifactId);
    if (!existing || String(entry.sharedAt) > String(existing.sharedAt)) {
      index.set(entry.artifactId, entry);
    }
  }
  return index;
}

function localShares(entries: SharedPreviewEntry[]): SharedPreviewEntry[] {
  return [...localIndex(entries).values()];
}

type Completeness = "whole" | "cut" | "unsaid";

function localOnlyStatus(
  entry: SharedPreviewEntry,
  completeness: Completeness,
  liveFiltered: boolean,
  now: number,
): string {
  if (completeness === "cut") {
    return "unknown: the platform list was cut short, so this share may simply be past the returned window.";
  }
  if (completeness === "unsaid") {
    return "unknown: the platform did not say whether that list was whole, so this share may simply be past the returned window.";
  }
  const expiresAt = entry.expiresAt ? Date.parse(entry.expiresAt) : NaN;
  if (Number.isFinite(expiresAt) && expiresAt <= now) {
    return "expired: its own expiresAt has passed, and the platform no longer lists it.";
  }
  if (liveFiltered) {
    return 'not in this live-only listing: the platform was asked for live shares only, so this one may be expired or revoked rather than not owned. Rerun with status:"all" to tell.';
  }
  return "not owned by this token: expired and pruned, revoked long ago, or shared while logged in to a different project.";
}

async function listShares(args: {
  projectPath?: string;
  status?: string;
  limit?: number;
  api?: string;
}): Promise<string> {
  const liveFiltered = args.status === "live";
  const local = args.projectPath
    ? readSharedPreviews(args.projectPath)
    : undefined;
  const localRecord = local
    ? {
        path: local.path,
        exists: local.exists,
        entries: local.entries.length,
        shares: localIndex(local.entries).size,
        countsNote:
          "entries is rows in the append-only file and shares is distinct artifact ids in it. They differ when a build was re-shared unchanged, which appends a second row for the same link. shares is the number of links this project ever minted.",
        ...(local.unreadable
          ? {
              unreadable:
                "The file exists but could not be parsed, so no local reconciliation was possible.",
            }
          : {}),
      }
    : {
        path: null,
        note: "Pass projectPath to reconcile this list against the project's own share record.",
      };

  const listing = await listArtifacts({
    liveOnly: liveFiltered,
    ...(args.limit != null ? { limit: args.limit } : {}),
    ...(args.api ? { api: args.api } : {}),
  });

  if (!listing.ok) {
    const isAuth = listing.error.name === "SharesAuthError";
    return envelope({
      ok: true,
      command: "extension_shares",
      status: "listed-local-only",
      value: {
        action: "list",
        server: {
          listed: false,
          errorName: listing.error.name,
          reason: listing.error.message,
          ...(listing.held
            ? {
                held: true,
                platformCode: PLATFORM_HOLD_CODE,
                stillWorks: PLATFORM_HOLD_STILL_WORKS,
                openSurface: templatesOrigin(args.api),
              }
            : {}),
          ...(isAuth ? { loginHint: LOGIN_HINT } : {}),
        },
        shares: [],
        localOnly: localShares(local?.entries ?? []).map((entry) => ({
          ...entry,
          ...(entry.revokeUrl
            ? { revokeUrl: wwwRevokeUrl(entry.revokeUrl) }
            : {}),
        })),
        localRecord,
      },
      warnings: [
        isAuth
          ? `The platform was not asked, so live and dead cannot be told apart here. ${LOGIN_HINT} localOnly is this project's own record of every link it ever shared, revoke handles included.`
          : "The platform could not be reached, so localOnly below is this project's own record and not a statement about what is still live.",
      ],
    });
  }

  const now = Date.now();
  const byId = localIndex(local?.entries ?? []);
  const seen = new Set<string>();

  const shares = listing.data.artifacts.map((artifact: ListedArtifact) => {
    seen.add(artifact.artifactId);
    const entry = byId.get(artifact.artifactId);
    return {
      ...artifact,
      owner: artifact.owner ?? null,
      sharedBy: artifact.sharedBy ?? null,
      attribution: attributionOf(artifact),
      recordedLocally: Boolean(entry),
      ...(entry
        ? {
            sharedAt: entry.sharedAt,
            ...(entry.browser ? { browser: entry.browser } : {}),
            ...(entry.distDir ? { distDir: entry.distDir } : {}),
          }
        : local
          ? {
              remoteOnly:
                "Not in this project's record: shared from another machine or another checkout of the project.",
            }
          : {}),
    };
  });

  const completeness: Completeness = !listing.data.truncatedReported
    ? "unsaid"
    : listing.data.truncated
      ? "cut"
      : "whole";

  const localOnly = [...byId.values()]
    .filter((entry) => !seen.has(entry.artifactId))
    .map((entry) => ({
      ...entry,
      ...(entry.revokeUrl ? { revokeUrl: wwwRevokeUrl(entry.revokeUrl) } : {}),
      status: localOnlyStatus(entry, completeness, liveFiltered, now),
    }));

  const handsOutAZip =
    shares.some((share) => Boolean(share.zipUrl)) ||
    localOnly.some((entry) => Boolean(entry.zipUrl));

  const liveCount = shares.filter((share) => share.live).length;
  const ownership = {
    project: shares.filter((s) => s.attribution.ownership === "project").length,
    personal: shares.filter((s) => s.attribution.ownership === "personal")
      .length,
    unknown: shares.filter((s) => s.attribution.ownership === "unknown").length,
  };

  const truncatedNote =
    completeness === "cut"
      ? `This is not the whole set: ${listing.data.count} of ${listing.data.matched} matched shares came back at limit ${listing.data.limit}. truncated also goes true when the server spent its budget working out which shares you are entitled to see, so matched is a floor and not a total. Raise limit (max 200) or pass status:"live" to narrow it, and do not read a missing share as revoked.`
      : completeness === "unsaid"
        ? `This listing cannot be called whole: the platform returned no truncated field, so whether ${listing.data.count} shares are all of them is unstated. A share missing from it is unaccounted for rather than dead, and no missing share is reported as revoked or unowned here.`
        : null;

  return envelope({
    ok: true,
    command: "extension_shares",
    status: "listed",
    value: {
      action: "list",
      server: {
        listed: true,
        count: listing.data.count,
        matched: listing.data.matched,
        limit: listing.data.limit,
        truncated: listing.data.truncated,
        truncatedReported: listing.data.truncatedReported,
        scanned: listing.data.scanned,
        scannedNote:
          "count and matched are shares: count is the shares on this page, matched is how many shares the filter found, and matched is a floor when truncated is true. scanned is not a share count and must not be read as one: it is how many stored records the platform opened to answer, including records that turned out to belong to someone else or to be filtered out. It tracks the platform's work, so it can sit above or beside these numbers by coincidence. ownership breaks the shares on this page down by who may revoke them and sums to the number of rows in shares.",
        ownership,
        ...(truncatedNote ? { truncatedNote } : {}),
      },
      shares,
      ...(local ? { localOnly } : {}),
      localRecord,
    },
    hint: `${liveCount} of ${shares.length} listed shares still resolve${
      local
        ? `; ${localOnly.length} recorded ${
            localOnly.length === 1 ? "share is" : "shares are"
          } ${
            liveFiltered
              ? 'not in this live-only listing (possibly dead rather than not owned; rerun with status:"all" to tell)'
              : "without an artifact behind them"
          }`
        : ""
    }. Revoke one with action:"revoke" and its artifactId or any of its URLs.`,
    warnings: [
      "previewUrl and zipUrl are null for a share that is no longer live, because a revoked or expired link cannot resolve for anyone. revokeUrl stays on every row. Revocation is permanent: a revoked id is burned, and re-sharing that build mints a different link. Re-sharing a build that was NOT revoked returns its existing link instead.",
      "attribution.ownership says who the share belongs to and therefore who may revoke it: project means the owning workspace holds it and any member can pull it back, personal means one person holds it alone. attribution.credit names the publisher and is attribution only, granting and restricting nothing. A credit of \"CLI token ...\" means the platform could not resolve which human minted that token, and a credit of \"not recorded\" means it never knew; neither is a name, and neither should be reported as one.",
      handsOutAZip ? ZIP_URL_REDIRECT_NOTE : null,
      truncatedNote,
    ],
  });
}

async function revokeShare(args: {
  artifactId?: string;
  url?: string;
  projectPath?: string;
  approvalId?: string;
  api?: string;
}): Promise<string> {
  const supplied = String(args.artifactId || args.url || "").trim();
  const ref = parseArtifactRef(supplied);
  if (!ref) {
    return envelope({
      ok: false,
      command: "extension_shares",
      status: "bad-request",
      value: { action: "revoke", ...(supplied ? { ref: supplied } : {}) },
      error: {
        code: "E_BAD_REQUEST",
        name: "SharesInputError",
        message: supplied
          ? `The reference is malformed and nothing was sent to the platform: no share id could be read out of ${JSON.stringify(
              supplied.length > 200 ? `${supplied.slice(0, 200)}...` : supplied,
            )}. A share id is gen_ followed by exactly 64 lowercase hex characters (32 on shares minted before 2026-07-30), and a url revokes only when it contains one whole. Check the ref for a copy-paste cut, or run action:"list" and copy the exact artifactId.`
          : 'Nothing to revoke. Pass artifactId (a gen_... id) or url (the previewUrl, zipUrl, viewUrl, or revokeUrl of the share). Run action:"list" to see both.',
      },
    });
  }

  const token = resolveToken();
  if (token) {
    const gate = await evaluateApproval({
      command: "extension_shares",
      action: "extension_shares.revoke",
      scope: { artifactId: ref },
      description: `Permanently revoke share ${ref}, killing the link for everyone with no way to restore it.`,
      approvalId: args.approvalId,
      token,
      api: args.api,
    });
    if (gate.blocked) return gate.envelope;
  }

  const result = await revokeArtifact({
    artifactId: ref,
    ...(args.approvalId ? { approvalId: args.approvalId } : {}),
    ...(args.api ? { api: args.api } : {}),
  });

  const local = args.projectPath
    ? readSharedPreviews(args.projectPath)
    : undefined;
  const entry = local ? localIndex(local.entries).get(ref) : undefined;
  const recordNote = local
    ? entry
      ? `${local.path} still lists this share as its own append-only history and was not rewritten, so the entry stays with its original sharedAt. The platform is the truth for whether a link resolves.`
      : `${local.path} has no entry for this share, so it was made from another machine or another checkout.`
    : undefined;

  if (!result.ok) {
    if (result.held) {
      return platformHoldEnvelope({
        command: "extension_shares",
        name: result.error.name,
        body: result.body,
        api: args.api,
        value: { action: "revoke", artifactId: ref },
      });
    }
    const isAuth = result.error.name === "SharesAuthError";
    return envelope({
      ok: false,
      command: "extension_shares",
      status: "revoke-failed",
      value: { action: "revoke", artifactId: ref },
      error: {
        code: isAuth ? "E_AUTH_REQUIRED" : "E_PLATFORM",
        name: result.error.name,
        message: result.error.message,
      },
      ...(isAuth ? { hint: LOGIN_HINT } : {}),
      warnings: [recordNote],
    });
  }

  if (result.data.revoked !== true) {
    return envelope({
      ok: true,
      command: "extension_shares",
      status: "revoke-unconfirmed",
      value: {
        action: "revoke",
        artifactId: ref,
        revoked: false,
        ...(result.data.revokedAt ? { revokedAt: result.data.revokedAt } : {}),
      },
      warnings: [
        `The platform accepted the request but did not confirm the revocation (revoked came back false), so do not treat this link as dead yet. Run action:"list" to see whether ${ref} still resolves, and retry the revoke if it does.`,
        recordNote,
      ],
    });
  }

  return envelope({
    ok: true,
    command: "extension_shares",
    status: "revoked",
    value: {
      action: "revoke",
      artifactId: ref,
      revoked: result.data.revoked,
      ...(result.data.revokedAt ? { revokedAt: result.data.revokedAt } : {}),
    },
    warnings: [
      "The link is dead for everyone, permanently: the zip is deleted and the id is burned, so it can never resolve again. Sharing the same build later returns a different link, and anyone holding the old one gets nothing.",
      recordNote,
    ],
  });
}

export async function handler(args: {
  action?: string;
  artifactId?: string;
  url?: string;
  projectPath?: string;
  approvalId?: string;
  status?: string;
  limit?: number;
  api?: string;
}): Promise<string> {
  if (args.action === "revoke") {
    return revokeShare({
      ...(args.artifactId ? { artifactId: args.artifactId } : {}),
      ...(args.url ? { url: args.url } : {}),
      ...(args.projectPath ? { projectPath: args.projectPath } : {}),
      ...(args.approvalId ? { approvalId: args.approvalId } : {}),
      ...(args.api ? { api: args.api } : {}),
    });
  }
  return listShares({
    ...(args.projectPath ? { projectPath: args.projectPath } : {}),
    ...(args.status ? { status: args.status } : {}),
    ...(args.limit != null ? { limit: args.limit } : {}),
    ...(args.api ? { api: args.api } : {}),
  });
}
