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
import { withFileLock, writePrivateJson } from "./private-file";

export interface StoredCredentials {
  version: 1;
  token: string;
  workspaceSlug: string;
  projectSlug: string;
  expiresAt: number;
  api: string;
  provider?: "extensiondev";
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

  return {
    version: 1,
    token,
    workspaceSlug: String(entry.workspaceSlug || ""),
    projectSlug: String(entry.projectSlug || ""),
    expiresAt: Number(entry.expiresAt || 0),
    api: String(entry.api || ""),
    ...(provider ? { provider } : {}),
  };
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

export function inspectCredentialStore(): CredentialStoreRead {
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
    const active = onServer.find(([key]) => key === store.active);

    return (active ?? onServer[onServer.length - 1])?.[1] ?? null;
  }

  if (wanted.includes("/")) {
    const [workspace = "", project = ""] = wanted.split("/");

    return onServer.find(([key]) => key === credentialKey(workspace, project, server))?.[1] ?? null;
  }

  const bySlug = onServer.map(([, entry]) => entry).filter(
    (entry) => entry.projectSlug.toLowerCase() === wanted,
  );

  return bySlug.length === 1 ? (bySlug[0] ?? null) : null;
}

export function readCredentials(selector?: CredentialSelector): StoredCredentials | null {
  const store = readCredentialStore();

  return store ? selectEntry(store, selector) : null;
}

export function listCredentials(): Array<StoredCredentials & { key: string; active: boolean; server: string }> {
  const store = readCredentialStore();
  if (!store) return [];

  return Object.entries(store.entries).map(([key, entry]) => ({
    ...entry,
    key,
    active: key === store.active,
    server: serverOf(entry.api),
  }));
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
  const key = credentialKey(creds.workspaceSlug, creds.projectSlug, creds.api);

  return withStoreLock(() => {
    const existing = storeForWrite();
    const entries = { ...(existing?.entries ?? {}) };
    delete entries[key];
    entries[key] = creds;

    return writeStore({ version: 2, active: key, entries });
  });
}

export function writeCredentialBatch(batch: StoredCredentials[]): string | null {
  if (batch.length === 0) return null;

  return withStoreLock(() => {
    const existing = storeForWrite();
    const entries = { ...(existing?.entries ?? {}) };

    for (const creds of batch) {
      const key = credentialKey(creds.workspaceSlug, creds.projectSlug, creds.api);
      delete entries[key];
      entries[key] = creds;
    }

    const first = batch[0] as StoredCredentials;
    const active =
      existing?.active && entries[existing.active]
        ? existing.active
        : credentialKey(first.workspaceSlug, first.projectSlug, first.api);

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

        return { cleared: true, path: file, removed: keys, remaining: [] };
      }

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
    "Which stored login to use, as '<workspace>/<project>' (or a project slug that matches one login), when extension_auth has signed in to more than one project on this machine. Omitted, the most recent login is used, after EXTENSION_DEV_TOKEN when that is set. Named, it outranks EXTENSION_DEV_TOKEN. extension_auth (action: status) lists the stored logins.",
} as const;

export function noStoredLoginHint(project: string): string {
  return `No stored login for ${project}. extension_auth (action: status) lists the logins on this machine; extension_auth (action: login, project: "${project}") adds one. Logging in to another project no longer replaces this one.`;
}
