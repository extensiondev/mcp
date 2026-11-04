// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { createHash } from "node:crypto";

import {
  fetchRegistryBytes,
  fetchRegistryJson,
  isSuccessfulBuild,
  parseBuildIndex,
  registryBase,
  registryFileUrl,
  type BuildIndexItem,
  type ProjectRef,
  type RegistryFetchRefusal,
} from "./registry";

export const TRY_MAX_PACKAGE_BYTES = 256 * 1024 * 1024;

const SHA_PREFIX = /^[0-9a-f]{4,40}$/i;
const SHA256 = /^[0-9a-f]{64}$/;

export type TryRefusalKind = "not-public" | "held" | "not-found" | "unavailable";

export interface TryRefusal {
  kind: TryRefusalKind;
  httpStatus?: number;
  heldMessage?: string;
}

export type BuildPick =
  | { ok: true; build: BuildIndexItem }
  | { ok: false; reason: "no-builds" | "no-match" | "ambiguous" | "no-browser"; candidates: BuildIndexItem[] };

function shortSha(sha: string): string {
  return sha.trim().slice(0, 7).toLowerCase();
}

function timeOf(item: BuildIndexItem): number {
  const parsed = Date.parse(String(item.timestamp ?? ""));

  return Number.isFinite(parsed) ? parsed : 0;
}

function newestFirst(items: BuildIndexItem[]): BuildIndexItem[] {
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => timeOf(b.item) - timeOf(a.item) || a.index - b.index)
    .map(({ item }) => item);
}

function carries(item: BuildIndexItem, browser: string): boolean {
  return !item.browsers || item.browsers.length === 0 || item.browsers.includes(browser);
}

function versionOf(raw: string): string {
  return raw.trim().replace(/^v/i, "");
}

export function isShaPrefix(wanted: string): boolean {
  return SHA_PREFIX.test(wanted.trim()) && !wanted.includes(".");
}

export function pickTryBuild(items: BuildIndexItem[], browser: string, wanted?: string): BuildPick {
  const ordered = newestFirst(items);
  const asked = String(wanted ?? "").trim();

  if (ordered.length === 0) return { ok: false, reason: "no-builds", candidates: [] };

  if (asked && isShaPrefix(asked)) {
    const prefix = asked.toLowerCase();
    const matches = ordered.filter((item) =>
      [item.sha, item.commit].some((sha) => {
        const full = String(sha ?? "").toLowerCase();

        return full.length > 0 && (full.startsWith(prefix) || prefix.startsWith(full));
      }),
    );

    if (matches.length === 0) return { ok: false, reason: "no-match", candidates: ordered.slice(0, 5) };
    if (matches.length > 1) return { ok: false, reason: "ambiguous", candidates: matches };

    return carries(matches[0]!, browser) ? { ok: true, build: matches[0]! } : { ok: false, reason: "no-browser", candidates: matches };
  }

  const successful = ordered.filter((item) => isSuccessfulBuild(item));
  const named = asked ? successful.filter((item) => versionOf(String(item.version ?? "")) === versionOf(asked)) : successful;

  if (named.length === 0) return { ok: false, reason: asked ? "no-match" : "no-builds", candidates: successful.slice(0, 5) };

  const withBrowser = named.find((item) => carries(item, browser));

  return withBrowser ? { ok: true, build: withBrowser } : { ok: false, reason: "no-browser", candidates: named.slice(0, 5) };
}

function refusalOf(read: RegistryFetchRefusal): TryRefusal {
  if (read.held) return { kind: "held", ...(read.status ? { httpStatus: read.status } : {}), heldMessage: read.message };
  if (read.status === 401 || read.status === 403) return { kind: "not-public", httpStatus: read.status };
  if (read.status === 404) return { kind: "not-found", httpStatus: 404 };

  return { kind: "unavailable", ...(read.status ? { httpStatus: read.status } : {}) };
}

export async function readTryBuilds(
  ref: ProjectRef,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: true; items: BuildIndexItem[] } | { ok: false; refusal: TryRefusal }> {
  const read = await fetchRegistryJson(registryFileUrl(ref, "builds/index.json"), fetchImpl, { ref });

  if (!read.ok) return { ok: false, refusal: refusalOf(read) };

  return { ok: true, items: parseBuildIndex(read.json) };
}

function buildFileUrl(ref: ProjectRef, sha: string, file: string): string {
  return `${registryBase()}/${encodeURIComponent(ref.workspace)}/${encodeURIComponent(ref.project)}/builds/${encodeURIComponent(shortSha(sha))}/${file}`;
}

export type IntegrityVerdict =
  | { verdict: "verified"; sha256: string; expectedBytes: number | null }
  | { verdict: "mismatch"; sha256: string; expectedSha256: string; expectedBytes: number | null }
  | { verdict: "no-report"; sha256: string };

export interface IntegrityRecord {
  sha256: string;
  bytes: number | null;
  failedChecks: string[];
}

type Row = Record<string, unknown>;

function isRow(value: unknown): value is Row {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function integrityRecordOf(report: unknown, file: string): IntegrityRecord | null {
  if (!isRow(report)) return null;

  const artifacts = Array.isArray(report.artifacts) ? report.artifacts.filter(isRow) : [];
  const entry = artifacts.find((artifact) => String(artifact.name ?? "") === file);
  const expected = entry && isRow(entry.expected) ? entry.expected : null;
  const sha = String(expected?.sha256 ?? report.sha256 ?? "").trim().toLowerCase();
  if (!SHA256.test(sha)) return null;

  const rawBytes = expected?.bytes ?? report.size;
  const bytes = typeof rawBytes === "number" && Number.isFinite(rawBytes) ? rawBytes : null;
  const checks = Array.isArray(report.checks) ? report.checks.filter(isRow) : [];
  const failedChecks = checks
    .filter((check) => check.ok === false)
    .map((check) => String(check.title ?? check.id ?? "").trim())
    .filter(Boolean);

  return { sha256: sha, bytes, failedChecks: report.ok === false && failedChecks.length === 0 ? ["the platform's package check"] : failedChecks };
}

export function judgeTryPackage(bytes: Buffer, record: IntegrityRecord | null): IntegrityVerdict {
  const sha256 = createHash("sha256").update(bytes).digest("hex");

  if (!record) return { verdict: "no-report", sha256 };

  const sameBytes = record.bytes === null || record.bytes === bytes.length;

  return record.sha256 === sha256 && sameBytes
    ? { verdict: "verified", sha256, expectedBytes: record.bytes }
    : { verdict: "mismatch", sha256, expectedSha256: record.sha256, expectedBytes: record.bytes };
}

export async function downloadTryPackage(
  ref: ProjectRef,
  sha: string,
  browser: string,
  fetchImpl: typeof fetch = fetch,
): Promise<
  | { ok: true; bytes: Buffer; record: IntegrityRecord | null; integrity: IntegrityVerdict }
  | { ok: false; refusal: TryRefusal; tooLarge?: boolean }
> {
  const file = `${browser}.zip`;
  const [download, report] = await Promise.all([
    fetchRegistryBytes(buildFileUrl(ref, sha, file), { ref, maxBytes: TRY_MAX_PACKAGE_BYTES, fetchImpl }),
    fetchRegistryJson(buildFileUrl(ref, sha, `artifact-integrity/${encodeURIComponent(browser)}.json`), fetchImpl, { ref }),
  ]);

  if (!download.ok) {
    return { ok: false, refusal: refusalOf(download), ...(/over the \d+ this tool downloads/.test(download.message) ? { tooLarge: true } : {}) };
  }

  const record = report.ok ? integrityRecordOf(report.json, file) : null;

  return { ok: true, bytes: download.bytes, record, integrity: judgeTryPackage(download.bytes, record) };
}
