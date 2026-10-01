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

/* @invariant A token is scoped to one workspace/project, and an agent that
   works across projects logs in to each in turn; one slot made the second
   login erase the first and left copying raw tokens out of this file as the
   only multi-project route. The file now keeps one entry per
   workspace/project with the latest login marked active, and every reader
   that used to take the single entry takes the active one unless it names a
   project. A version 1 file (one entry) is read as a store of one and
   rewritten as version 2 on the next login, so nothing stored before this is
   lost or asked for again. */
export interface CredentialStore {
  version: 2;
  active: string | null;
  entries: Record<string, StoredCredentials>;
}

export interface CredentialSelector {
  project?: string;
}

export function credentialKey(workspaceSlug: string, projectSlug: string): string {
  return `${workspaceSlug}/${projectSlug}`.toLowerCase();
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

export function readCredentialStore(): CredentialStore | null {
  let data: unknown;
  try {
    data = JSON.parse(fs.readFileSync(credentialsPath(), "utf8"));
  } catch {
    return null;
  }
  if (!data || typeof data !== "object") return null;
  const record = data as Record<string, unknown>;
  if (record.version === 1) {
    const only = readEntry(record);
    if (!only) return null;
    const key = credentialKey(only.workspaceSlug, only.projectSlug);
    return { version: 2, active: key, entries: { [key]: only } };
  }
  if (record.version !== 2 || !record.entries || typeof record.entries !== "object") {
    return null;
  }
  const entries: Record<string, StoredCredentials> = {};
  for (const [key, value] of Object.entries(record.entries as Record<string, unknown>)) {
    const entry = readEntry(value);
    if (entry) entries[key.toLowerCase()] = entry;
  }
  const keys = Object.keys(entries);
  if (keys.length === 0) return null;
  const active =
    typeof record.active === "string" && entries[record.active.toLowerCase()]
      ? record.active.toLowerCase()
      : keys[0];
  return { version: 2, active, entries };
}

function selectEntry(
  store: CredentialStore,
  selector: CredentialSelector | undefined,
): StoredCredentials | null {
  const wanted = String(selector?.project ?? "").trim().toLowerCase();
  if (!wanted) {
    return (store.active && store.entries[store.active]) || Object.values(store.entries)[0] || null;
  }
  if (wanted.includes("/")) return store.entries[wanted] ?? null;
  const bySlug = Object.values(store.entries).filter(
    (entry) => entry.projectSlug.toLowerCase() === wanted,
  );
  return bySlug.length === 1 ? bySlug[0] : null;
}

export function readCredentials(selector?: CredentialSelector): StoredCredentials | null {
  const store = readCredentialStore();
  return store ? selectEntry(store, selector) : null;
}

export function listCredentials(): Array<StoredCredentials & { key: string; active: boolean }> {
  const store = readCredentialStore();
  if (!store) return [];
  return Object.entries(store.entries).map(([key, entry]) => ({
    ...entry,
    key,
    active: key === store.active,
  }));
}

function writeStore(store: CredentialStore): string {
  const file = credentialsPath();
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    // Best-effort: some filesystems (e.g. Windows) do not support chmod.
  }
  fs.writeFileSync(file, JSON.stringify(store, null, 2) + "\n", {
    mode: 0o600,
  });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // Best-effort: some filesystems (e.g. Windows) do not support chmod.
  }
  return file;
}

export function writeCredentials(creds: StoredCredentials): string {
  const key = credentialKey(creds.workspaceSlug, creds.projectSlug);
  const existing = readCredentialStore();
  const entries = { ...(existing?.entries ?? {}), [key]: creds };
  return writeStore({ version: 2, active: key, entries });
}

export function clearCredentials(selector?: CredentialSelector): {
  cleared: boolean;
  path: string;
  removed: string[];
  remaining: string[];
} {
  const file = credentialsPath();
  const store = readCredentialStore();
  const wanted = String(selector?.project ?? "").trim();
  if (!wanted) {
    try {
      fs.unlinkSync(file);
      return {
        cleared: true,
        path: file,
        removed: store ? Object.keys(store.entries) : [],
        remaining: [],
      };
    } catch {
      return { cleared: false, path: file, removed: [], remaining: [] };
    }
  }
  if (!store) return { cleared: false, path: file, removed: [], remaining: [] };
  const entry = selectEntry(store, { project: wanted });
  if (!entry) {
    return { cleared: false, path: file, removed: [], remaining: Object.keys(store.entries) };
  }
  const key = credentialKey(entry.workspaceSlug, entry.projectSlug);
  const entries = { ...store.entries };
  delete entries[key];
  const remaining = Object.keys(entries);
  if (remaining.length === 0) {
    try {
      fs.unlinkSync(file);
    } catch {
      // nothing left to remove
    }
    return { cleared: true, path: file, removed: [key], remaining: [] };
  }
  writeStore({
    version: 2,
    active: store.active === key ? remaining[0] : store.active,
    entries,
  });
  return { cleared: true, path: file, removed: [key], remaining };
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
