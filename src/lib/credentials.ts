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

import { loginKey, serverOf, targetServer } from "./credential-server";
import { REQUEST_STORE_REFUSAL, coveredProjects, requestCredential } from "./credential-scope";
import { withFileLock, writePrivateJson } from "./private-file";
import { keepLogin, keptLogin, moveKeptLogin, releaseLogin, releaseStore } from "./session-login";

/* @invariant A LOGIN IS KEYED BY THE SLUGS IT WAS MINTED UNDER AND BOUND TO
 * THE PROJECT ID THE PLATFORM ANSWERS FOR IT. The platform mints a token for a
 * project id; the slugs are the address the token was asked for. A project
 * renamed in the console keeps its id and its tokens, so the login follows it:
 * the entry is rewritten under the new `<workspace>/<project>` key and the old
 * key stays behind as an alias (`movedTo`) that resolves to the new entry for
 * one answer, so the call that still names the old slug completes and is told
 * the new one. `projectId` is recorded when the platform answers it (the token
 * response or whoami) and is how a move is recognized as the same project.
 * `movedFrom` is never stored; it marks a selection that followed an alias.
 */
export interface StoredCredentials {
  version: 1;
  token: string;
  workspaceSlug: string;
  projectSlug: string;
  expiresAt: number;
  api: string;
  provider?: "extensiondev";
  projectId?: string;
  movedTo?: string;
  movedFrom?: string;
}

export function credentialsPath(): string {
  if (process.platform === "win32") {
    const base =
      process.env.APPDATA ||
      process.env.LOCALAPPDATA ||
      path.join(os.homedir(), "AppData", "Roaming");

    return path.join(base, "extension-dev", "auth.json");
  }

  const xdg = String(process.env.XDG_CONFIG_HOME || "").trim();
  const base = xdg || path.join(os.homedir(), ".config");

  return path.join(base, "extension-dev", "auth.json");
}

export interface CredentialStore {
  version: 2;
  active: string | null;
  entries: Record<string, StoredCredentials>;
}

export interface CredentialSelector {
  project?: string;
  api?: string;
}

export function credentialKey(workspaceSlug: string, projectSlug: string, api?: string): string {
  return loginKey(workspaceSlug, projectSlug, api);
}

function keyOf(entry: StoredCredentials, fallback: string): string {
  return entry.workspaceSlug && entry.projectSlug
    ? credentialKey(entry.workspaceSlug, entry.projectSlug, entry.api)
    : fallback.toLowerCase();
}

function readEntry(data: unknown): StoredCredentials | null {
  if (!data || typeof data !== "object") return null;

  const entry = data as Partial<StoredCredentials>;
  if (entry.version !== 1) return null;

  const token = String(entry.token || "").trim();
  if (!token) return null;

  const provider = entry.provider === "extensiondev" ? entry.provider : undefined;
  const projectId = String(entry.projectId || "").trim();
  const movedTo = String(entry.movedTo || "").trim();

  return {
    version: 1,
    token,
    workspaceSlug: String(entry.workspaceSlug || ""),
    projectSlug: String(entry.projectSlug || ""),
    expiresAt: Number(entry.expiresAt || 0),
    api: String(entry.api || ""),
    ...(provider ? { provider } : {}),
    ...(projectId.startsWith("prj_") ? { projectId } : {}),
    ...(movedTo ? { movedTo } : {}),
  };
}

function storable(entry: StoredCredentials): StoredCredentials {
  const { movedFrom: _movedFrom, ...rest } = entry;

  return rest;
}

function followAlias(
  store: CredentialStore,
  key: string,
  entry: StoredCredentials | null,
): StoredCredentials | null {
  if (!entry?.movedTo) return entry;

  const target = store.entries[entry.movedTo];
  if (!target || target.movedTo) return null;

  return { ...target, movedFrom: `${entry.workspaceSlug}/${entry.projectSlug}`.toLowerCase() };
}

export function loginMoveSentence(from: string, to: string): string {
  return `The project ${from} is now ${to}; its login moved with it, pass project: '${to}' from now on.`;
}

export type CredentialStoreRead =
  | { state: "absent" }
  | { state: "ok"; store: CredentialStore }
  | { state: "unreadable"; path: string; reason: string };

export class CredentialStoreUnreadableError extends Error {
  readonly path: string;
  readonly reason: string;
  constructor(file: string, reason: string) {
    super(
      `The login store at ${file} exists but ${reason}, so it was left untouched and nothing was stored. Fix or move that file and sign in again; extension_auth (action: logout) with no project removes it if its logins are not worth recovering.`,
    );

    this.name = "CredentialStoreUnreadableError";
    this.path = file;
    this.reason = reason;
  }
}

function requestScopedStore(): CredentialStoreRead | null {
  const scoped = requestCredential();
  if (!scoped) return null;

  const entries: Record<string, StoredCredentials> = {};

  for (const ref of scoped.projects) {
    entries[credentialKey(ref.workspace, ref.project, scoped.api)] = {
      version: 1,
      token: scoped.token,
      workspaceSlug: ref.workspace,
      projectSlug: ref.project,
      expiresAt: scoped.expiresAt ?? 0,
      api: scoped.api,
    };
  }

  const keys = Object.keys(entries);
  if (!scoped.token || keys.length === 0) return { state: "absent" };

  const [workspace = "", project = ""] = String(scoped.project ?? "").split("/");
  const selected = credentialKey(workspace, project, scoped.api);

  return { state: "ok", store: { version: 2, active: entries[selected] ? selected : (keys[0] ?? null), entries } };
}

export function inspectCredentialStore(): CredentialStoreRead {
  const scoped = requestScopedStore();
  if (scoped) return scoped;

  const file = credentialsPath();
  let text: string;

  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") return { state: "absent" };

    return {
      state: "unreadable",
      path: file,
      reason: `could not be read (${code || (err as Error)?.message || "unknown error"})`,
    };
  }

  if (!text.trim()) return { state: "absent" };

  let data: unknown;

  try {
    data = JSON.parse(text);
  } catch {
    return {
      state: "unreadable",
      path: file,
      reason: "is not valid JSON (it may have been cut short mid-write)",
    };
  }

  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return { state: "unreadable", path: file, reason: "does not hold a login store" };
  }

  const record = data as Record<string, unknown>;

  if (record.version === 1) {
    const only = readEntry(record);
    if (!only) return { state: "absent" };

    const key = keyOf(only, credentialKey(only.workspaceSlug, only.projectSlug));

    return {
      state: "ok",
      store: { version: 2, active: key, entries: { [key]: only } },
    };
  }

  if (record.version !== 2) {
    return {
      state: "unreadable",
      path: file,
      reason: `is a version ${JSON.stringify(record.version)} store, which this client does not read (a newer client may have written it)`,
    };
  }

  if (
    !record.entries ||
    typeof record.entries !== "object" ||
    Array.isArray(record.entries)
  ) {
    return { state: "unreadable", path: file, reason: "has no entries map" };
  }

  const entries: Record<string, StoredCredentials> = {};
  const renamed = new Map<string, string>();

  for (const [key, value] of Object.entries(record.entries as Record<string, unknown>)) {
    const entry = readEntry(value);
    if (!entry) continue;

    const canonical = keyOf(entry, key);
    entries[canonical] = entry;
    renamed.set(key.toLowerCase(), canonical);
  }

  const keys = Object.keys(entries);
  if (keys.length === 0) return { state: "absent" };

  const named = typeof record.active === "string" ? renamed.get(record.active.toLowerCase()) : undefined;
  const active = named && entries[named] ? named : (keys[0] ?? null);

  return { state: "ok", store: { version: 2, active, entries } };
}

export function readCredentialStore(): CredentialStore | null {
  const read = inspectCredentialStore();

  return read.state === "ok" ? read.store : null;
}

export function credentialStoreProblem(): { path: string; reason: string } | null {
  const read = inspectCredentialStore();

  return read.state === "unreadable"
    ? { path: read.path, reason: read.reason }
    : null;
}

export const TOKEN_TTL_SECONDS = 7 * 24 * 3600;

export function tokenExpiry(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);

  return Number.isFinite(n) && n > 0 ? n : Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS;
}

export const PROJECT_PIN_ENV = "EXTENSION_DEV_PROJECT";

export function pinnedProject(): string {
  if (requestCredential()) return "";

  return String(process.env[PROJECT_PIN_ENV] || "").trim().toLowerCase();
}

export function isProjectRef(value: string): boolean {
  return /^[a-z0-9][a-z0-9-_.]*\/[a-z0-9][a-z0-9-_.]*$/i.test(value);
}

export function sameProject(named: string, pinned: string): boolean {
  const a = named.trim().toLowerCase();
  if (!a || !pinned) return true;

  return a.includes("/") ? a === pinned : a === pinned.split("/")[1];
}

function selectEntry(
  store: CredentialStore,
  selector: CredentialSelector | undefined,
): StoredCredentials | null {
  const wanted = (String(selector?.project ?? "").trim() || pinnedProject()).toLowerCase();
  const server = targetServer(selector?.api);
  const onServer = Object.entries(store.entries).filter(([, entry]) => serverOf(entry.api) === server);

  if (!wanted) {
    const live = onServer.filter(([, entry]) => !entry.movedTo);
    const file = requestCredential() ? "" : credentialsPath();
    const held = file ? keptLogin(file, server) : null;
    const session = held ? live.find(([key]) => key === held) : undefined;
    const chosen = session ?? live.find(([key]) => key === store.active) ?? live[live.length - 1];

    if (chosen && file && !session) keepLogin(file, server, chosen[0]);

    return chosen?.[1] ?? null;
  }

  if (wanted.includes("/")) {
    const [workspace = "", project = ""] = wanted.split("/");
    const key = credentialKey(workspace, project, server);

    return followAlias(store, key, onServer.find(([name]) => name === key)?.[1] ?? null);
  }

  const bySlug = onServer.filter(([, entry]) => entry.projectSlug.toLowerCase() === wanted);
  const [found] = bySlug;

  return bySlug.length === 1 && found ? followAlias(store, found[0], found[1]) : null;
}

export function readCredentials(selector?: CredentialSelector): StoredCredentials | null {
  const store = readCredentialStore();

  return store ? selectEntry(store, selector) : null;
}

export function listCredentials(): Array<StoredCredentials & { key: string; active: boolean; server: string }> {
  const store = readCredentialStore();
  if (!store) return [];

  const file = requestCredential() ? "" : credentialsPath();

  return Object.entries(store.entries)
    .filter(([, entry]) => !entry.movedTo)
    .map(([key, entry]) => {
      const server = serverOf(entry.api);
      const held = file ? keptLogin(file, server) : null;

      return {
        ...entry,
        key,
        active: key === (held && store.entries[held] ? held : store.active),
        server,
      };
    });
}

export function defaultLoginDrift(api?: string): { kept: string; newest: string } | null {
  if (requestCredential()) return null;

  const store = readCredentialStore();
  if (!store?.active) return null;

  const server = targetServer(api);
  const held = keptLogin(credentialsPath(), server);
  const newest = store.entries[store.active];
  if (!held || held === store.active || !newest || newest.movedTo || serverOf(newest.api) !== server) return null;

  const current = store.entries[held];
  if (!current || current.movedTo) return null;

  return {
    kept: `${current.workspaceSlug}/${current.projectSlug}`.toLowerCase(),
    newest: `${newest.workspaceSlug}/${newest.projectSlug}`.toLowerCase(),
  };
}

export function loginDriftSentence(drift: { kept: string; newest: string }): string {
  return `This server keeps using ${drift.kept}, the login it resolved first; ${drift.newest} was signed in later by another process that shares this machine's login store, and a call here with no project does not follow it. Pass project: '${drift.newest}' to act on it, or run extension_auth (action: login, project: '${drift.newest}') in this server.`;
}

export function moveLogin(args: {
  workspaceSlug: string;
  fromProjectSlug: string;
  toProjectSlug: string;
  api?: string;
  projectId?: string;
}): { from: string; to: string } | null {
  if (requestCredential()) return null;

  const from = credentialKey(args.workspaceSlug, args.fromProjectSlug, args.api);
  const to = credentialKey(args.workspaceSlug, args.toProjectSlug, args.api);
  if (from === to) return null;

  return withStoreLock(() => {
    const existing = storeForWrite();
    const entry = existing?.entries[from];
    if (!existing || !entry || entry.movedTo) return null;

    const projectId = String(args.projectId || entry.projectId || "").trim();
    const entries = { ...existing.entries };
    entries[to] = storable({
      ...entry,
      projectSlug: args.toProjectSlug,
      ...(projectId ? { projectId } : {}),
    });

    entries[from] = storable({ ...entry, movedTo: to });

    writeStore({
      version: 2,
      active: existing.active === from ? to : existing.active,
      entries,
    });

    moveKeptLogin(credentialsPath(), from, to);

    return {
      from: `${entry.workspaceSlug}/${entry.projectSlug}`.toLowerCase(),
      to: `${entry.workspaceSlug}/${args.toProjectSlug}`.toLowerCase(),
    };
  });
}

export function dropLoginAlias(args: { workspaceSlug: string; projectSlug: string; api?: string }): boolean {
  if (requestCredential()) return false;

  const key = credentialKey(args.workspaceSlug, args.projectSlug, args.api);

  return withStoreLock(() => {
    const existing = storeForWrite();
    if (!existing?.entries[key]?.movedTo) return false;

    const entries = { ...existing.entries };
    delete entries[key];
    writeStore({ ...existing, entries });

    return true;
  });
}

export function rememberLoginProjectId(args: {
  workspaceSlug: string;
  projectSlug: string;
  api?: string;
  projectId: string;
}): boolean {
  const projectId = String(args.projectId || "").trim();
  if (!projectId.startsWith("prj_") || requestCredential()) return false;

  const key = credentialKey(args.workspaceSlug, args.projectSlug, args.api);

  return withStoreLock(() => {
    const existing = storeForWrite();
    const entry = existing?.entries[key];
    if (!existing || !entry || entry.movedTo || entry.projectId === projectId) return false;

    writeStore({ ...existing, entries: { ...existing.entries, [key]: { ...entry, projectId } } });

    return true;
  });
}

function writeStore(store: CredentialStore): string {
  return writePrivateJson(credentialsPath(), store);
}

function withStoreLock<T>(change: () => T): T {
  return withFileLock(credentialsPath(), "login store", change);
}

function storeForWrite(): CredentialStore | null {
  const read = inspectCredentialStore();

  if (read.state === "unreadable") {
    throw new CredentialStoreUnreadableError(read.path, read.reason);
  }

  return read.state === "ok" ? read.store : null;
}

export function writeCredentials(creds: StoredCredentials): string {
  if (requestCredential()) throw new Error(REQUEST_STORE_REFUSAL);

  const key = credentialKey(creds.workspaceSlug, creds.projectSlug, creds.api);

  return withStoreLock(() => {
    const existing = storeForWrite();
    const entries = { ...(existing?.entries ?? {}) };
    delete entries[key];
    entries[key] = storable(creds);
    keepLogin(credentialsPath(), serverOf(creds.api), key);

    return writeStore({ version: 2, active: key, entries });
  });
}

export function writeCredentialBatch(batch: StoredCredentials[]): string | null {
  if (batch.length === 0) return null;
  if (requestCredential()) throw new Error(REQUEST_STORE_REFUSAL);

  return withStoreLock(() => {
    const existing = storeForWrite();
    const entries = { ...(existing?.entries ?? {}) };

    for (const creds of batch) {
      const key = credentialKey(creds.workspaceSlug, creds.projectSlug, creds.api);
      delete entries[key];
      entries[key] = storable(creds);
    }

    const first = batch[0] as StoredCredentials;
    const active =
      existing?.active && entries[existing.active]
        ? existing.active
        : credentialKey(first.workspaceSlug, first.projectSlug, first.api);
    const chosen = entries[active];
    if (chosen) keepLogin(credentialsPath(), serverOf(chosen.api), active);

    return writeStore({ version: 2, active, entries });
  });
}

export function clearCredentials(selector?: CredentialSelector): {
  cleared: boolean;
  path: string;
  removed: string[];
  remaining: string[];
  failure?: string;
} {
  const file = credentialsPath();
  if (requestCredential()) return { cleared: false, path: file, removed: [], remaining: [], failure: REQUEST_STORE_REFUSAL };

  const read = inspectCredentialStore();
  const store = read.state === "ok" ? read.store : null;
  const wanted = String(selector?.project ?? "").trim();
  const describe = (err: unknown): string =>
    String((err as NodeJS.ErrnoException)?.code || (err as Error)?.message || err);
  const stillThere = (): string[] => listCredentials().map((entry) => entry.key);
  const server = targetServer(selector?.api);
  const serverKeys = store
    ? Object.entries(store.entries)
        .filter(([, entry]) => serverOf(entry.api) === server)
        .map(([key]) => key)
    : [];

  if (!wanted && (!store || serverKeys.length === Object.keys(store.entries).length)) {
    try {
      fs.unlinkSync(file);
      releaseStore(file);
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
        return { cleared: false, path: file, removed: [], remaining: [] };
      }

      return {
        cleared: false,
        path: file,
        removed: [],
        remaining: stillThere(),
        failure: `the store at ${file} could not be deleted (${describe(err)})`,
      };
    }

    return {
      cleared: true,
      path: file,
      removed: store ? Object.keys(store.entries) : [],
      remaining: [],
    };
  }

  if (read.state === "unreadable") {
    return {
      cleared: false,
      path: file,
      removed: [],
      remaining: [],
      failure: `the store at ${file} exists but ${read.reason}, so the login for ${wanted} could not be looked up in it`,
    };
  }

  if (!store) return { cleared: false, path: file, removed: [], remaining: [] };

  const entry = wanted ? selectEntry(store, { project: wanted, api: selector?.api }) : null;
  const keys = entry ? [credentialKey(entry.workspaceSlug, entry.projectSlug, entry.api)] : wanted ? [] : serverKeys;

  if (keys.length === 0) {
    return { cleared: false, path: file, removed: [], remaining: Object.keys(store.entries) };
  }

  const key = keys.join(", ");

  try {
    return withStoreLock(() => {
      const current = storeForWrite() ?? store;
      const entries = { ...current.entries };
      for (const gone of keys) delete entries[gone];
      const remaining = Object.keys(entries);

      if (remaining.length === 0) {
        try {
          fs.unlinkSync(file);
        } catch (err) {
          if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") throw err;
        }

        releaseStore(file);

        return { cleared: true, path: file, removed: keys, remaining: [] };
      }

      for (const gone of keys) releaseLogin(file, gone);

      writeStore({
        version: 2,
        active: current.active && entries[current.active] ? current.active : (remaining[0] ?? null),
        entries,
      });

      return { cleared: true, path: file, removed: keys, remaining };
    });
  } catch (err) {
    return {
      cleared: false,
      path: file,
      removed: [],
      remaining: stillThere(),
      failure: `the login for ${key} could not be removed from ${file} (${describe(err)})`,
    };
  }
}

export function readValidCredentials(
  nowSeconds: number = Math.floor(Date.now() / 1000),
  selector?: CredentialSelector,
): StoredCredentials | null {
  const creds = readCredentials(selector);
  if (!creds) return null;
  if (creds.expiresAt && creds.expiresAt <= nowSeconds) return null;

  return creds;
}

export const PROJECT_TOKEN_INPUT = {
  type: "string",
  description:
    "Which stored login to use, as '<workspace>/<project>' (or a project slug that matches one login), when extension_auth has signed in to more than one project on this machine. Omitted, the login this server resolved first is used, after EXTENSION_DEV_TOKEN when that is set, and a login made elsewhere on this machine does not move it. Named, it outranks EXTENSION_DEV_TOKEN. extension_auth (action: status) lists the stored logins.",
} as const;

export const LOGIN_STEPS =
  "Run extension_auth (action: login), or set EXTENSION_DEV_TOKEN (create one in the extension.dev dashboard). An extension with no extension.dev project yet starts with extension_project_create, which makes one from its GitHub repository, then extension_auth.";

export const NO_TOKEN_MESSAGE = `No token. ${LOGIN_STEPS}`;

export function noStoredLoginHint(project: string): string {
  if (requestCredential()) {
    const covered = coveredProjects();

    return `This connection's token does not cover ${project}${covered.length ? `; it covers ${covered.join(", ")}` : ""}. Sign in again from the MCP client and approve ${project} to use it.`;
  }

  return `No stored login for ${project}. extension_auth (action: status) lists the logins on this machine; extension_auth (action: login, project: "${project}") adds one. Logging in to another project no longer replaces this one.`;
}
