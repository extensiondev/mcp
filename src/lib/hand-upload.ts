// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators


import { packageFileName, packageFileOf, printedPackageAddress, type PackageScope } from "./package-address";
import { text } from "./ship-act";

import type { RequirementRow } from "./store-requirements";

export interface HandUpload {
  browser: string;
  sha: string;
  address: string;
}

export const HAND_UPLOAD_ROWS: Record<string, { store: string; create: string; paste: string }> = {
  "chrome.item": {
    store: "chrome",
    create: "Create the item once on the Chrome Web Store dashboard.",
    paste: "Then paste the item's dashboard address on the project's store settings page.",
  },
  "edge.product": {
    store: "edge",
    create: "Create the product once in Partner Center.",
    paste: "Then paste its Product ID (the GUID Partner Center shows) on the project's store settings page.",
  },
};

export function handUploadOf(scope: PackageScope, answered?: unknown): HandUpload {
  const parsed = packageFileOf(answered);
  const browser = text(scope.browser) || parsed?.browser || "chrome";
  const sha = text(scope.sha) || parsed?.sha || "";
  const address = sha ? printedPackageAddress(answered, { ...scope, sha, browser }) : "";

  return { browser, sha, address };
}

export function handUploadSentence(upload: HandUpload): string {
  const file = packageFileName(upload.browser);
  const save = upload.sha
    ? `extension_builds (action: "download", buildId: "${upload.sha}", browser: "${upload.browser}")`
    : `extension_builds (action: "download", buildId, browser: "${upload.browser}")`;
  const where = upload.sha && upload.address ? `of build ${upload.sha} at ${upload.address}` : upload.sha ? `of build ${upload.sha} from its extension.dev build page` : "of a completed build from its extension.dev build page";

  return `Download ${file} ${where}, or let me save it with ${save}; upload it once as the item's first package.`;
}

export function platformVersionNote(nextVersion?: string): string {
  const next = text(nextVersion);

  return `Every later platform upload carries the store version <manifest version>.<n>, numbered by the platform${next ? `; the next one is ${next}` : ""}.`;
}

export function handUploadHow(id: string, upload: HandUpload, nextVersion?: string): string {
  const row = HAND_UPLOAD_ROWS[id];
  if (!row) return "";

  return `${row.create} ${handUploadSentence(upload)} ${platformVersionNote(nextVersion)} ${row.paste}`;
}

export function withHandUploadRows(rows: RequirementRow[], scope: PackageScope, nextVersion?: string): RequirementRow[] {
  return rows.map((row) => {
    const known = HAND_UPLOAD_ROWS[row.id];
    if (!known || row.status === "have") return row;

    return { ...row, how: handUploadHow(row.id, handUploadOf({ ...scope, browser: known.store }), nextVersion) };
  });
}
