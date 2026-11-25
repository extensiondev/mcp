// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import fs from "node:fs";
import path from "node:path";

import { requestCredential } from "./credential-scope";
import { serverOf, targetServer } from "./credential-server";
import { credentialsPath, liveAt, loginEntries, readCredentialStore, storeKey, type StoredCredentials } from "./credentials";
import { keptLogin } from "./session-login";

export interface PathIdentity {
  owner: string;
  repo: string;
  pkg: string;
}

export type PathLogin =
  | { state: "unnamed" }
  | { state: "match"; project: string; via: string }
  | { state: "unmatched"; named: string[] };

const SLUG = /^[a-z0-9][a-z0-9-_.]*$/;

function slugOf(raw: unknown): string {
  const value = String(raw ?? "").trim().toLowerCase().replace(/^@[^/]+\//, "").replace(/\.git$/, "");

  return SLUG.test(value) ? value : "";
}

function readText(file: string): string {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

function gitConfigOf(dir: string): string {
  const dotGit = path.join(dir, ".git");
  let stat: fs.Stats;

  try {
    stat = fs.statSync(dotGit);
  } catch {
    return "";
  }

  if (stat.isDirectory()) return readText(path.join(dotGit, "config"));

  const pointer = /^gitdir:\s*(.+)$/m.exec(readText(dotGit))?.[1]?.trim();
  if (!pointer) return "";

  const gitDir = path.resolve(dir, pointer);
  const common = readText(path.join(gitDir, "commondir")).trim();

  return readText(path.join(common ? path.resolve(gitDir, common) : gitDir, "config"));
}

function originOf(config: string): { owner: string; repo: string } {
  const section = /\[remote\s+"origin"\]([^[]*)/.exec(config)?.[1] ?? "";
  const url = /^\s*url\s*=\s*(.+)$/m.exec(section)?.[1]?.trim() ?? "";
  const match = /github\.com[:/]+([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(url);

  return { owner: slugOf(match?.[1]), repo: slugOf(match?.[2]) };
}

export function pathIdentity(projectPath: string): PathIdentity {
  const root = path.resolve(projectPath);
  let pkg = "";

  try {
    pkg = slugOf((JSON.parse(readText(path.join(root, "package.json"))) as { name?: unknown })?.name);
  } catch {
    pkg = "";
  }

  let dir = root;

  for (let depth = 0; depth < 12; depth++) {
    const config = gitConfigOf(dir);

    if (config) return { ...originOf(config), pkg };

    const parent = path.dirname(dir);
    if (parent === dir) break;

    dir = parent;
  }

  return { owner: "", repo: "", pkg };
}

function refOf(entry: StoredCredentials): string {
  return `${entry.workspaceSlug}/${entry.projectSlug}`.toLowerCase();
}

/* @invariant A CALL THAT NAMES A PROJECT DIRECTORY ANSWERS FOR THAT PROJECT
 * OR SAYS WHY IT CANNOT. On 2026-10-24 a preflight given the rebeccat
 * directory scored leon's stores, because leon was the newest login on the
 * machine and the call named no project. The directory names its project
 * twice over: the package.json name and the GitHub origin. The stored login
 * whose '<workspace>/<project>' is '<origin owner>/<package name>' or
 * '<origin owner>/<repo>' is the one, then the one login on the server whose
 * project slug is the package or repo name; a login a rename left behind
 * resolves to where it moved. When the directory names a project and no
 * stored login is it, the call is refused with both names and nothing is
 * sent, never answered for the default login.
 */
export function loginForPath(projectPath: string, api?: string): PathLogin {
  const { owner, repo, pkg } = pathIdentity(projectPath);
  const slugs = [...new Set([pkg, repo].filter(Boolean))];
  if (slugs.length === 0) return { state: "unnamed" };

  const store = readCredentialStore();
  const server = targetServer(api);
  const entries = store ? loginEntries(store).filter(([, entry]) => serverOf(entry.api) === server) : [];

  const resolve = (entry: StoredCredentials): StoredCredentials | null => {
    if (!entry.movedTo) return entry;

    const target = store?.entries[entry.movedTo];

    return target && !target.movedTo ? target : null;
  };

  const via = (slug: string): string => (slug === pkg ? "package.json name" : "GitHub repository");

  if (owner) {
    for (const slug of slugs) {
      const found = entries.find(([, entry]) => refOf(entry) === `${owner}/${slug}`)?.[1];
      const live = found ? resolve(found) : null;

      if (live) return { state: "match", project: refOf(live), via: via(slug) };
    }
  }

  for (const slug of slugs) {
    const named = entries.filter(([, entry]) => !entry.movedTo && entry.projectSlug.toLowerCase() === slug);
    const unexpired = named.filter(([, entry]) => liveAt(entry));
    const found = unexpired.length > 0 ? unexpired : named;
    const [only] = found;

    if (found.length === 1 && only) return { state: "match", project: refOf(only[1]), via: via(slug) };
  }

  return { state: "unmatched", named: slugs.map((slug) => (owner ? `${owner}/${slug}` : slug)) };
}

export function loginForRepository(named: string, dir: string, api?: string): { project: string; dir: string } | null {
  const { owner, repo } = pathIdentity(dir);
  if (!owner || !repo || `${owner}/${repo}` !== named.trim().toLowerCase()) return null;

  const found = loginForPath(dir, api);

  return found.state === "match" && found.project !== `${owner}/${repo}` ? { project: found.project, dir } : null;
}

export function loginForOrigin(dir: string, api?: string): { project: string; owner: string; repo: string } | null {
  const { owner, repo } = pathIdentity(dir);
  if (!owner || !repo) return null;

  const store = readCredentialStore();
  const server = targetServer(api);
  const matches = store
    ? loginEntries(store)
        .map(([, entry]) => entry)
        .filter((entry) => serverOf(entry.api) === server && !entry.movedTo && refOf(entry) === `${owner}/${repo}`)
    : [];

  return matches.length === 1 && matches[0] ? { project: refOf(matches[0]), owner, repo } : null;
}

export interface ServerLogins {
  live: string[];
  kept: string | null;
  expired: string[];
}

/* @invariant AN EXPIRED LOGIN IS NO CHOICE. A login past its expiry can
 * answer nothing, so it does not count toward the logins a call has to
 * choose between and is never offered as one. On 2026-11-18 (ledger 940) a
 * store with one live login and one expired three days earlier refused every
 * unnamed platform call as project-ambiguous and offered both. live lists
 * the logins that have not expired, expired the rest. kept stays this
 * server's default even once it has expired: the call then says that login
 * expired, and never moves to another project on its own.
 */

export function serverLogins(api?: string): ServerLogins {
  const store = readCredentialStore();
  const server = targetServer(api);
  const stored = store
    ? loginEntries(store).filter(([, entry]) => serverOf(entry.api) === server && !entry.movedTo)
    : [];
  const held = requestCredential() ? null : keptLogin(credentialsPath(), server);
  const named = held ? stored.filter(([, entry]) => storeKey(entry) === held) : [];
  const kept = named.length === 1 ? named[0]?.[1] : undefined;

  return {
    live: stored.filter(([, entry]) => liveAt(entry)).map(([, entry]) => refOf(entry)),
    kept: kept ? refOf(kept) : null,
    expired: stored.filter(([, entry]) => !liveAt(entry)).map(([, entry]) => refOf(entry)),
  };
}
