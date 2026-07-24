// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import {
  listArtifacts,
  parseArtifactRef,
  revokeArtifact,
  type ListedArtifact,
} from "../lib/artifacts-api";
import {
  readSharedPreviews,
  type SharedPreviewEntry,
} from "../lib/share-record";

const LOGIN_HINT =
  "Run extension_login, or set EXTENSION_DEV_TOKEN (create one in the extension.dev dashboard).";

export const schema = {
  name: "extension_shares",
  description:
    "List and revoke the public preview links this token has shared (the links extension_preview_web share:true hands out). action:\"list\" (default) asks the platform for every artifact owned by the logged-in project and returns each one's artifactId, name, version, live/dead state, createdAt, expiresAt, revokedAt, size, and its previewUrl, zipUrl and revokeUrl, so a link you lost the response for is findable again. action:\"revoke\" kills one by artifactId or by pasting any of its URLs; revocation is PERMANENT (the id is burned and re-sharing mints a different link), so it cannot be undone. Pass projectPath to reconcile the platform's answer with .extension.dev/shared-previews.json, the project's own append-only record: a share made on another machine shows up as remoteOnly, and a record with no live artifact behind it shows up under localOnly. Needs the same token as sharing (extension_login or EXTENSION_DEV_TOKEN); without one, listing still returns the local record with a login hint instead of failing. Read-only for the local file: this tool never rewrites shared-previews.json.",
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
      api: {
        type: "string",
        description:
          "Platform base URL (defaults to https://www.extension.dev or EXTENSION_DEV_API_URL).",
      },
    },
    required: [],
  },
};

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

function localOnlyStatus(
  entry: SharedPreviewEntry,
  truncated: boolean,
  now: number,
): string {
  if (truncated) {
    return "unknown: the platform list was cut short, so this share may simply be past the returned window.";
  }
  const expiresAt = entry.expiresAt ? Date.parse(entry.expiresAt) : NaN;
  if (Number.isFinite(expiresAt) && expiresAt <= now) {
    return "expired: its own expiresAt has passed, and the platform no longer lists it.";
  }
  return "not owned by this token: expired and pruned, revoked long ago, or shared while logged in to a different project.";
}

async function listShares(args: {
  projectPath?: string;
  status?: string;
  limit?: number;
  api?: string;
}): Promise<string> {
  const local = args.projectPath
    ? readSharedPreviews(args.projectPath)
    : undefined;
  const localRecord = local
    ? {
        path: local.path,
        exists: local.exists,
        entries: local.entries.length,
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
    liveOnly: args.status === "live",
    ...(args.limit != null ? { limit: args.limit } : {}),
    ...(args.api ? { api: args.api } : {}),
  });

  if (!listing.ok) {
    const isAuth = listing.error.name === "SharesAuthError";
    return JSON.stringify({
      ok: true,
      action: "list",
      server: {
        listed: false,
        errorName: listing.error.name,
        reason: listing.error.message,
        ...(isAuth ? { loginHint: LOGIN_HINT } : {}),
      },
      shares: [],
      localOnly: (local?.entries ?? []).map((entry) => ({ ...entry })),
      localRecord,
      note: isAuth
        ? `The platform was not asked, so live and dead cannot be told apart here. ${LOGIN_HINT} localOnly is this project's own record of every link it ever shared, revoke handles included.`
        : "The platform could not be reached, so localOnly below is this project's own record and not a statement about what is still live.",
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

  const localOnly = (local?.entries ?? [])
    .filter((entry) => !seen.has(entry.artifactId))
    .map((entry) => ({
      ...entry,
      status: localOnlyStatus(entry, listing.data.truncated, now),
    }));

  const liveCount = shares.filter((share) => share.live).length;

  return JSON.stringify({
    ok: true,
    action: "list",
    server: {
      listed: true,
      count: listing.data.count,
      matched: listing.data.matched,
      limit: listing.data.limit,
      truncated: listing.data.truncated,
      scanned: listing.data.scanned,
      ...(listing.data.truncated
        ? {
            truncatedNote: `This is not the whole set: ${listing.data.count} of ${listing.data.matched} matched shares came back at limit ${listing.data.limit}. Raise limit (max 200) or pass status:"live" to narrow it, and do not read a missing share as revoked.`,
          }
        : {}),
    },
    shares,
    ...(local ? { localOnly } : {}),
    localRecord,
    message: `${liveCount} of ${shares.length} listed shares still resolve${
      local
        ? `; ${localOnly.length} local record ${
            localOnly.length === 1 ? "entry has" : "entries have"
          } no artifact behind them`
        : ""
    }. Revoke one with action:"revoke" and its artifactId or any of its URLs.`,
    note: "previewUrl and zipUrl are null for a share that is no longer live, because a revoked or expired link cannot resolve for anyone. revokeUrl stays on every row. Revocation is permanent: a revoked id is burned and re-sharing the same build mints a different link.",
  });
}

async function revokeShare(args: {
  artifactId?: string;
  url?: string;
  projectPath?: string;
  api?: string;
}): Promise<string> {
  const ref = parseArtifactRef(args.artifactId || args.url || "");
  if (!ref) {
    return JSON.stringify({
      ok: false,
      action: "revoke",
      error: {
        name: "SharesInputError",
        message:
          "Nothing to revoke. Pass artifactId (a gen_... id) or url (the previewUrl, zipUrl, viewUrl, or revokeUrl of the share). Run action:\"list\" to see both.",
      },
    });
  }

  const result = await revokeArtifact({
    artifactId: ref,
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
    const isAuth = result.error.name === "SharesAuthError";
    return JSON.stringify({
      ok: false,
      action: "revoke",
      artifactId: ref,
      error: { name: result.error.name, message: result.error.message },
      ...(isAuth ? { loginHint: LOGIN_HINT } : {}),
      ...(recordNote ? { recordNote } : {}),
    });
  }

  return JSON.stringify({
    ok: true,
    action: "revoke",
    artifactId: ref,
    revoked: result.data.revoked,
    ...(result.data.revokedAt ? { revokedAt: result.data.revokedAt } : {}),
    ...(recordNote ? { recordNote } : {}),
    note: "The link is dead for everyone, permanently: the zip is deleted and the id is burned, so it can never resolve again. Sharing the same build later returns a different link, and anyone holding the old one gets nothing.",
  });
}

export async function handler(args: {
  action?: string;
  artifactId?: string;
  url?: string;
  projectPath?: string;
  status?: string;
  limit?: number;
  api?: string;
}): Promise<string> {
  if (args.action === "revoke") {
    return revokeShare({
      ...(args.artifactId ? { artifactId: args.artifactId } : {}),
      ...(args.url ? { url: args.url } : {}),
      ...(args.projectPath ? { projectPath: args.projectPath } : {}),
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
