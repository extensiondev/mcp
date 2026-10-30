// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { execFileSync } from "node:child_process";
import path from "node:path";

import { dispatchedPushSentence, docsOnlySentence, headPushOf, isDocsOnly, skippedPushSentence, type HeadPush } from "./head-push";
import { projectApiBytes } from "./project-api-bytes";
import { projectApiGet, type ProjectApi } from "./project-api";
import { isRow, text } from "./ship-act";
import {
  declaredIcon128,
  icon128FromBytes,
  iconFromDist,
  iconFromSource,
  type ListingImage,
} from "./store-listing-media";
import { readZipEntry } from "./zip-entries";

import type { ListingStore } from "./store-md-listing";

const MAX_PACKAGE_BYTES = 512 * 1024 * 1024;
const MAX_PACKAGE_ENTRIES = 50_000;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_ICON_BYTES = 512 * 1024;
const BUILD_LIST_LIMIT = 50;
const SHA_PREFIX = 7;

export type IconOrigin =
  | { from: "build"; build: string; file: string }
  | { from: "dist"; file: string }
  | { from: "source"; file: string };

export interface IconPick {
  icon: ListingImage;
  origin: IconOrigin;
}

export interface IconStale {
  dist: string;
  source: string;
}

export type LocalIcon = IconPick | { missing: string; stale?: IconStale };

export function staleSentence(stale: IconStale, newestBuild: string | null): string {
  const take = newestBuild
    ? `run a build or pass useBuild: "${newestBuild}" to take the icon from build ${newestBuild}`
    : "run a build first (extension_build), or push the commit so the platform builds it";

  return `${stale.dist} is older than ${stale.source}; ${take}`;
}

/* @invariant A LOCAL ICON IS SENT ONLY WHEN IT IS THE SOURCE ICON. The
 * dist folder is whatever the last local build left, so its icon is compared
 * with the icon the source manifest names: equal bytes mean the dist is
 * current and is sent as dist; different bytes mean the dist is older than
 * the source and the icon is withheld with that sentence, never sent as if it
 * were current (ledger 255, three stores kept the old icon). With no dist the
 * source icon itself is sent, since a build copies it as it is; with no
 * source icon to compare against the dist is taken as found.
 */
export function localIcon(projectPath: string, store: ListingStore): LocalIcon {
  const source = iconFromSource(projectPath);
  const dist = iconFromDist(projectPath, store);

  if ("icon" in dist) {
    if ("icon" in source && source.icon.sha256 !== dist.icon.sha256) {
      const stale = { dist: dist.icon.source.split(path.sep).slice(0, 2).join("/"), source: source.icon.source };

      return { missing: staleSentence(stale, null), stale };
    }

    return { icon: dist.icon, origin: { from: "dist", file: dist.icon.source } };
  }

  if ("icon" in source) return { icon: source.icon, origin: { from: "source", file: source.icon.source } };

  return dist;
}

export function gitHead(projectPath: string): string {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: projectPath,
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5_000,
      encoding: "utf8",
    })
      .trim()
      .toLowerCase();
  } catch {
    return "";
  }
}

type Row = Record<string, unknown>;

interface BuildRow {
  id: string;
  commit: string;
  status: string;
  done: boolean;
}

const DONE_STATUSES = new Set(["success", "ready"]);

function buildRow(item: unknown): BuildRow | null {
  if (!isRow(item)) return null;

  const id = (text(item.buildId) || text(item.shortSha) || text(item.id)).toLowerCase();
  const status = text(item.status).toLowerCase();
  if (!id) return null;

  return { id, commit: text(item.commit).toLowerCase(), status, done: DONE_STATUSES.has(status) };
}

function buildRows(items: unknown[]): BuildRow[] {
  return items.map(buildRow).filter((row): row is BuildRow => row !== null);
}

function sameCommit(row: BuildRow, sha: string): boolean {
  if (sha.length < SHA_PREFIX) return false;

  return [row.commit, row.id].some((own) => own.length >= SHA_PREFIX && (own.startsWith(sha) || sha.startsWith(own)));
}

/* @invariant THE BUILD LIST CAN LAG THE BUILD RECORD, SO A COMMIT THE LIST
 * DOES NOT SHOW AS COMPLETED IS READ BY ITS OWN RECORD. The platform's list
 * keeps a run's status for minutes after the run concluded (ledger 263: the
 * row read status building beside conclusion success while builds/<sha>
 * already read success, so the icon fell back to dist without a word). The
 * one build the call needs, the checked out commit or useBuild, is therefore
 * read from builds/<sha> whenever the list does not answer it completed.
 */
async function wantedBuild(api: ProjectApi, rows: BuildRow[], sha: string, push: HeadPush | null): Promise<{ row: BuildRow | null; seen: BuildRow | null }> {
  const listed = rows.filter((row) => sameCommit(row, sha));
  const done = listed.find((row) => row.done);
  if (done) return { row: done, seen: done };
  if (sha.length < SHA_PREFIX) return { row: null, seen: null };
  if (!listed.length && push && !push.dispatched) return { row: null, seen: null };

  const detail = await projectApiGet<Record<string, unknown>>(api, `builds/${encodeURIComponent(listed[0]?.id ?? sha.slice(0, SHA_PREFIX))}`);
  const read = detail.ok ? buildRow(isRow(detail.json?.build) ? detail.json.build : detail.json) : null;
  const fresh = read && sameCommit(read, sha) ? read : null;

  return { row: fresh?.done ? fresh : null, seen: fresh ?? listed[0] ?? null };
}

export type BuildMiss = "no-commit" | "not-completed" | "unreadable" | "not-dispatched" | "dispatched-unlisted" | "no-record";

function missedSentence(target: string, asked: boolean, seen: BuildRow | null, unreadable: string | null, push: HeadPush | null): { why: BuildMiss; missed: string } {
  const subject = `the checked out commit ${target.slice(0, SHA_PREFIX)}`;

  if (!target) return { why: "no-commit", missed: "the project directory has no git commit checked out, so no platform build could be matched" };
  if (seen) return { why: "not-completed", missed: `build ${seen.id} of ${asked ? "that commit" : "the checked out commit"} is ${seen.status || "of unknown status"} on the platform, not completed` };
  if (unreadable) return { why: "unreadable", missed: `the platform's build list could not be read (${unreadable})` };
  if (push && !push.dispatched) return { why: "not-dispatched", missed: `${skippedPushSentence(push, subject)}; or pass useBuild with a completed build` };
  if (push) return { why: "dispatched-unlisted", missed: `${dispatchedPushSentence(push, subject)}; or pass useBuild with a completed build` };

  return { why: "no-record", missed: `${subject} has no platform build; push it, or pass useBuild with a completed build` };
}

export interface BuildIcons {
  build: string | null;
  commit: string;
  missed: string | null;
  newest: string | null;
  unreadable: string | null;
  headPush: HeadPush | null;
  why: BuildMiss | "docs-only" | null;
  reason: string | null;
  take(store: ListingStore): Promise<IconPick | { problem: string }>;
}

function packageFiles(store: ListingStore): string[] {
  return store === "chrome" ? ["chrome.zip"] : [`${store}.zip`, "chrome.zip"];
}

/* @invariant THE STORE RECEIVES THE PLATFORM BUILD, SO THE LISTING ICON IS
 * READ FROM THAT BUILD. The build is the completed platform build of the
 * commit the project directory has checked out (its git HEAD), or the one
 * useBuild names; its package comes through the platform's artifact relay
 * under the login's own token, the store's own package first and the Chrome
 * package where the store ships that one, and the 128 px icon its manifest
 * declares is read out of the archive. A project whose HEAD has no completed
 * platform build falls back to the local read, which withholds a dist older
 * than the source, unless the push record the same list answer carries says
 * the platform classified HEAD's push docs only (ledger 305): that commit
 * will never build and carries the newest build's package, so the newest
 * completed build is read and the reason says so, and no push is asked for.
 */
export async function platformBuildIcons(api: ProjectApi, projectPath: string, useBuild: string): Promise<BuildIcons> {
  const read = await projectApiGet<{ items?: unknown[]; lastPush?: unknown }>(api, "builds", { limit: BUILD_LIST_LIMIT });
  const rows = read.ok ? buildRows(Array.isArray(read.json?.items) ? read.json.items : []) : [];
  const newest = rows.find((row) => row.done)?.id ?? null;
  const asked = useBuild.toLowerCase();
  const target = asked || gitHead(projectPath);
  const headPush = asked || !target || !read.ok ? null : headPushOf(read.json?.lastPush, target);
  const wanted = target ? await wantedBuild(api, rows, target, headPush) : { row: null, seen: null };
  const fallback = !wanted.row && isDocsOnly(headPush) ? newest : null;
  const build = wanted.row?.id ?? fallback;
  const miss = build ? null : missedSentence(target, Boolean(asked), wanted.seen, read.ok ? null : read.message, headPush);
  const missed = miss?.missed ?? null;
  const why = miss?.why ?? (fallback ? "docs-only" : null);
  const reason = fallback ? docsOnlySentence(`the checked out commit ${target.slice(0, SHA_PREFIX)}`, "the icon is read from", fallback) : null;
  const packages = new Map<string, Promise<{ bytes: Buffer } | { absent: true } | { problem: string }>>();

  const fetchPackage = (file: string) => {
    const cached = packages.get(file);
    if (cached) return cached;

    const pending = (async () => {
      const sent = await projectApiBytes(api, `builds/${encodeURIComponent(build as string)}/artifacts/${file}`, { maxBytes: MAX_PACKAGE_BYTES });
      if (sent.ok) return { bytes: sent.bytes };
      if (sent.status === 404) return { absent: true as const };

      return { problem: sent.message };
    })();

    packages.set(file, pending);

    return pending;
  };

  return {
    build,
    commit: target,
    missed,
    newest,
    unreadable: read.ok ? null : read.message,
    headPush,
    why,
    reason,
    async take(store) {
      if (!build) return { problem: "no platform build" };

      for (const file of packageFiles(store)) {
        const sent = await fetchPackage(file);
        if ("absent" in sent) continue;
        if ("problem" in sent) return { problem: sent.problem };

        const manifest = readZipEntry(sent.bytes, "manifest.json", { maxEntries: MAX_PACKAGE_ENTRIES, maxBytes: MAX_MANIFEST_BYTES });
        if (!manifest.ok) return { problem: `${file} of build ${build}: ${manifest.message}` };

        let declared = "";

        try {
          declared = declaredIcon128(JSON.parse(manifest.data.toString("utf8")) as Row);
        } catch {
          return { problem: `${file} of build ${build}: manifest.json could not be read` };
        }

        if (!declared) return { problem: `${file} of build ${build}: manifest.json declares no 128 px icon` };

        const entry = declared.replace(/^\/+/, "");
        const icon = readZipEntry(sent.bytes, entry, { maxEntries: MAX_PACKAGE_ENTRIES, maxBytes: MAX_ICON_BYTES });
        if (!icon.ok) return { problem: `${file} of build ${build}: ${icon.message}` };

        const image = icon128FromBytes(icon.data, `build ${build} (${file}:${entry})`);
        if ("missing" in image) return { problem: image.missing };

        return { icon: image.icon, origin: { from: "build", build, file: `${file}:${entry}` } };
      }

      return { problem: `build ${build} has no package for ${store}` };
    },
  };
}
