// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import fs from "node:fs";
import path from "node:path";

import { isRow, text } from "./ship-act";
import { engineProjectRoot } from "./session-paths";

type Row = Record<string, unknown>;

export const SAFARI_DESCRIPTION_MAX = 112;
export const SAFARI_DESCRIPTION_CHECK = "safari.manifest_description";
export const FIREFOX_LISTING_CHECK = "firefox.listing_document";
export const FIREFOX_SYNC_LISTING_CALL = 'extension_submit {action: "sync-listing", store: "firefox", projectPath: "<project root>"}';

const MESSAGE_KEY = /^__MSG_(\w+)__$/;

interface ManifestRead {
  manifest: Row;
  dir: string;
  from: string;
}

function readJson(file: string): Row | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));

    return isRow(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function manifestRead(projectPath: string): ManifestRead | null {
  const root = engineProjectRoot(projectPath);
  const candidates: Array<[string, string]> = [
    [path.join(root, "dist", "safari", "manifest.json"), "the built dist/safari/manifest.json"],
    [path.join(root, "src", "manifest.json"), "the source src/manifest.json"],
    [path.join(root, "manifest.json"), "the source manifest.json"],
  ];

  for (const [file, from] of candidates) {
    const manifest = readJson(file);
    if (manifest) return { manifest, dir: path.dirname(file), from };
  }

  return null;
}

function localized(value: string, read: ManifestRead): string | null {
  const key = MESSAGE_KEY.exec(value)?.[1];
  if (!key) return value;

  const locale = text(read.manifest.default_locale);
  if (!locale) return null;

  const messages = readJson(path.join(read.dir, "_locales", locale, "messages.json"));
  const entry = messages ? Object.entries(messages).find(([name]) => name.toLowerCase() === key.toLowerCase())?.[1] : null;

  return isRow(entry) && typeof entry.message === "string" ? entry.message : null;
}

export function safariDescriptionOf(projectPath: string): { description: string; from: string } | null {
  const read = manifestRead(projectPath);
  if (!read) return null;

  const raw = read.manifest["safari:description"] ?? read.manifest.description;
  if (typeof raw !== "string") return null;

  const description = localized(raw.trim(), read);

  return description === null ? null : { description, from: read.from };
}

export function safariDescriptionCheck(projectPath: string): Row | null {
  const read = projectPath ? safariDescriptionOf(projectPath) : null;
  if (!read || read.description.length <= SAFARI_DESCRIPTION_MAX) return null;

  const length = read.description.length;

  return {
    id: SAFARI_DESCRIPTION_CHECK,
    label: `Manifest description fits App Store Connect's ${SAFARI_DESCRIPTION_MAX} characters`,
    status: "fail",
    severity: "blocking",
    stage: "integration",
    expected: `${SAFARI_DESCRIPTION_MAX} or fewer characters`,
    actual: `${length} characters in ${read.from}`,
    message: `The manifest description is ${length} characters; App Store Connect refuses a Safari build whose description is over ${SAFARI_DESCRIPTION_MAX} (error 90849), and Chrome's limit of 132 lets it through. Shorten the description to ${SAFARI_DESCRIPTION_MAX} characters or fewer, build again, and submit the new build.`,
  };
}

export function firefoxListingMissing(read: { ok: boolean; json?: unknown } | null): boolean {
  if (!read || !read.ok || !isRow(read.json)) return false;

  const doc = read.json;
  const listing = isRow(doc.listing) ? doc.listing : null;

  return text(doc.store) === "firefox" && doc.updatedAt === null && listing !== null && Object.keys(listing).length === 0;
}

export function firefoxListingCheck(read: { ok: boolean; json?: unknown } | null): Row | null {
  if (!firefoxListingMissing(read)) return null;

  return {
    id: FIREFOX_LISTING_CHECK,
    label: "The Firefox listing is on file",
    status: "fail",
    severity: "blocking",
    stage: "integration",
    expected: "a Firefox listing written by sync-listing",
    actual: "no Firefox listing has been written yet",
    message: `No Firefox listing is on file, and the Firefox submit run reads it before it uploads, so the run would fail. Run ${FIREFOX_SYNC_LISTING_CALL} first, then submit.`,
  };
}

export function withLocalChecks(json: Row, rows: Array<Row | null>): Row {
  const added = rows.filter((row): row is Row => row !== null);
  if (!added.length) return json;

  const checks = (Array.isArray(json.checks) ? json.checks : []).filter((check) => !added.some((row) => isRow(check) && text(check.id) === row.id));
  const summary = isRow(json.summary) ? json.summary : {};
  const integration = isRow(summary.integration) ? summary.integration : null;
  const count = (value: unknown) => (typeof value === "number" ? value : 0);
  const failing = added.filter((row) => text(row.status) !== "warn").length;
  const warned = added.length - failing;
  const warnings = warned ? { warn: count(summary.warn) + warned } : {};

  if (!failing) return { ...json, checks: [...checks, ...added], summary: { ...summary, ...warnings } };

  return {
    ...json,
    checks: [...checks, ...added],
    summary: {
      ...summary,
      ...warnings,
      fail: count(summary.fail) + failing,
      blockingFailures: count(summary.blockingFailures) + failing,
      ...(integration
        ? { integration: { ...integration, fail: count(integration.fail) + failing, blockingFailures: count(integration.blockingFailures) + failing, canQueue: false } }
        : {}),
      canSubmit: false,
    },
  };
}
