// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { wwwRevokeUrl } from "../lib/artifacts-api";
import { resolveCredential } from "../lib/credential-source";
import { LOGIN_STEPS, NO_TOKEN_MESSAGE, noStoredLoginHint } from "../lib/credentials";
import { envelope } from "../lib/envelope";
import { uploadPreview } from "../lib/preview-upload";
import { readSharedPreviews, type SharedPreviewEntry } from "../lib/share-record";
import { unpackZip } from "../lib/zip-entries";

import type { SharesLocal } from "./shares-create";

export const SHARES_LOCAL: SharesLocal = {
  readSharedPreviews,
  makeStagingDir: () => fs.mkdtempSync(path.join(os.tmpdir(), "extdev-share-build-")),
  unpackPackage: unpackZip,
  readStagedManifest: (distDir) => JSON.parse(fs.readFileSync(path.join(distDir, "manifest.json"), "utf8")),
  uploadPreview,
  removeStagingDir: (distDir) => fs.rmSync(distDir, { recursive: true, force: true }),
};

function latestRowPerShare(entries: SharedPreviewEntry[]): SharedPreviewEntry[] {
  const latest = new Map<string, SharedPreviewEntry>();

  for (const entry of entries) {
    const kept = latest.get(entry.artifactId);

    if (!kept || String(entry.sharedAt) > String(kept.sharedAt)) latest.set(entry.artifactId, entry);
  }

  return [...latest.values()];
}

export function listRecordedShares(args: { projectPath: string; project?: string; api?: string }): string {
  const record = readSharedPreviews(args.projectPath);
  const recorded = latestRowPerShare(record.entries);
  const project = String(args.project ?? "").trim();
  const reason = project ? noStoredLoginHint(project) : (resolveCredential({ api: args.api }).note ?? NO_TOKEN_MESSAGE);

  return envelope({
    ok: true,
    command: "extension_shares",
    status: "listed-local-only",
    value: {
      action: "list",
      platform: { listed: false, errorName: "SharesAuthError", reason, loginHint: LOGIN_STEPS },
      shares: [],
      localOnly: recorded.map((entry) => ({ ...entry, ...(entry.revokeUrl ? { revokeUrl: wwwRevokeUrl(entry.revokeUrl) } : {}) })),
      localRecord: {
        path: record.path,
        exists: record.exists,
        entries: record.entries.length,
        shares: recorded.length,
        countsNote:
          "entries is rows in the append-only file and shares is distinct artifact ids in it. They differ when a build was re-shared unchanged, which appends a second row for the same link. shares is the number of links this project ever minted.",
        ...(record.unreadable ? { unreadable: "The file exists but could not be parsed, so no local reconciliation was possible." } : {}),
      },
    },
    warnings: [`The platform was not asked, so live and dead cannot be told apart here. ${LOGIN_STEPS} localOnly is this project's own record of every link it ever shared, revoke handles included.`],
  });
}
