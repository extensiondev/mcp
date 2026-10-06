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

/* @invariant
 * "NO LOGINS" IS A FILE THAT IS NOT THERE. EVERYTHING ELSE IS "CANNOT READ".
 *
 * Every failure to read the store used to come back as null: a file another
 * process was halfway through writing, one cut short by a crash, one this
 * user may not read, one written by a newer client. The writers then built
 * the next store from nothing and wrote it over the file, so signing in to
 * one project erased every other login, and the answer said "logged in".
 * The read now has three outcomes and only one of them may be written over:
 * absent (or a file holding no usable entry). An unreadable store keeps its
 * bytes, the write refuses and says why, and status reports it as unreadable
 * instead of "logged out".
 */
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
    const key = credentialKey(only.workspaceSlug, only.projectSlug);
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
  for (const [key, value] of Object.entries(record.entries as Record<string, unknown>)) {
    const entry = readEntry(value);
    if (entry) entries[key.toLowerCase()] = entry;
  }
  const keys = Object.keys(entries);
  if (keys.length === 0) return { state: "absent" };
  const active =
    typeof record.active === "string" && entries[record.active.toLowerCase()]
      ? record.active.toLowerCase()
      : (keys[0] ?? null);
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

/* @invariant A TOKEN WITHOUT AN EXPIRY IS NOT ETERNAL. A missing or
   non-numeric `expiresAt` used to be stored as 0, which the reader treats as
   "never expires" while the sentence said seven days. The
   platform mints seven-day tokens; a token that arrives without its expiry
   is stored with that documented life, counted from now. */
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

/* @invariant
 * A PINNED SERVER READS ONE PROJECT'S LOGIN AND NO OTHER.
 *
 * With several logins stored, an unnamed read used to take the most recent
 * one, so an agent configured for project A acted on project B the moment the
 * person signed in to B in another terminal. EXTENSION_DEV_PROJECT (or the
 * --project flag, which sets it) names the project a server was configured
 * for; every unnamed read then selects that login. The dispatch layer refuses
 * a call that names a different project, so the pin cannot be argued around.
 */
function selectEntry(
  store: CredentialStore,
  selector: CredentialSelector | undefined,
): StoredCredentials | null {
  const wanted = (String(selector?.project ?? "").trim() || pinnedProject()).toLowerCase();
  if (!wanted) {
    return (store.active && store.entries[store.active]) || Object.values(store.entries)[0] || null;
  }
  if (wanted.includes("/")) return store.entries[wanted] ?? null;
  const bySlug = Object.values(store.entries).filter(
    (entry) => entry.projectSlug.toLowerCase() === wanted,
  );
  return bySlug.length === 1 ? (bySlug[0] ?? null) : null;
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

function ensureStoreDir(): string {
  const file = credentialsPath();
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    // Best-effort: some filesystems (e.g. Windows) do not support chmod.
  }
  return file;
}

/* @invariant THE STORE IS REPLACED WHOLE OR NOT AT ALL. The bytes go to a
 * sibling file and are renamed over the store, so a reader, in this process
 * or another server's, sees the old store or the new one and never a file cut
 * off mid-write. A crash between the two leaves the old store and a stray
 * temp file, which is the harmless way round. */
function writeStore(store: CredentialStore): string {
  const file = ensureStoreDir();
  const tmpFile = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmpFile, JSON.stringify(store, null, 2) + "\n", {
      mode: 0o600,
    });
    try {
      fs.chmodSync(tmpFile, 0o600);
    } catch {
      // Best-effort: some filesystems (e.g. Windows) do not support chmod.
    }
    fs.renameSync(tmpFile, file);
  } catch (err) {
    fs.rmSync(tmpFile, { force: true });
    throw err;
  }
  return file;
}

const LOCK_STALE_MS = 2_000;
const LOCK_WAIT_MS = 3_000;

function pause(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/* @invariant ONE WRITER READS AND REPLACES THE STORE AT A TIME. Two servers
 * signing in at once each read the store, added their login and wrote it
 * back, and the second write dropped the first one's login. The read, the
 * change and the replace happen under a lock file taken with an exclusive
 * create; a lock older than two seconds belongs to a writer that died (the
 * work under it takes milliseconds) and is taken over. A writer that cannot
 * take the lock in time refuses instead of writing over a store it could not
 * read under the lock. */
function takeLock(lock: string): boolean {
  try {
    fs.closeSync(fs.openSync(lock, "wx", 0o600));
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "EEXIST") throw err;
    return false;
  }
}

function lockAgeMs(lock: string): number | null {
  try {
    return Date.now() - fs.statSync(lock).mtimeMs;
  } catch {
    return null;
  }
}

function withStoreLock<T>(change: () => T): T {
  const file = ensureStoreDir();
  const lock = `${file}.lock`;
  const deadline = Date.now() + LOCK_WAIT_MS;
  while (!takeLock(lock)) {
    const age = lockAgeMs(lock);
    if (age === null) continue;
    if (age > LOCK_STALE_MS) {
      fs.rmSync(lock, { force: true });
      continue;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `Another process is writing the login store at ${file} and did not finish in ${LOCK_WAIT_MS} ms; nothing was stored. Try again.`,
      );
    }
    pause(25);
  }
  try {
    return change();
  } finally {
    fs.rmSync(lock, { force: true });
  }
}

function storeForWrite(): CredentialStore | null {
  const read = inspectCredentialStore();
  if (read.state === "unreadable") {
    throw new CredentialStoreUnreadableError(read.path, read.reason);
  }
  return read.state === "ok" ? read.store : null;
}

export function writeCredentials(creds: StoredCredentials): string {
  const key = credentialKey(creds.workspaceSlug, creds.projectSlug);
  return withStoreLock(() => {
    const existing = storeForWrite();
    const entries = { ...(existing?.entries ?? {}), [key]: creds };
    return writeStore({ version: 2, active: key, entries });
  });
}

/* @invariant A BATCH ADDS LOGINS AND DOES NOT CHOOSE THE DEFAULT ONE. A
 * single login makes its project the active entry because signing in to one
 * project is a statement about which project comes next. One approval for a
 * list says no such thing, and letting whichever name happened to be written
 * last become the default would silently repoint every unnamed token read. So
 * the active entry is kept when there is one, and only an empty store takes
 * the first name of the batch. Every entry lands in one replace of the file,
 * so a reader never sees half a batch.
 */
export function writeCredentialBatch(batch: StoredCredentials[]): string | null {
  if (batch.length === 0) return null;
  return withStoreLock(() => {
    const existing = storeForWrite();
    const entries = { ...(existing?.entries ?? {}) };
    for (const creds of batch) {
      entries[credentialKey(creds.workspaceSlug, creds.projectSlug)] = creds;
    }
    const first = batch[0] as StoredCredentials;
    const active =
      existing?.active && entries[existing.active]
        ? existing.active
        : credentialKey(first.workspaceSlug, first.projectSlug);
    return writeStore({ version: 2, active, entries });
  });
}

/* @invariant A LOGOUT THAT DID NOT REMOVE THE TOKEN SAYS SO. Only a file
 * that is not there means "nothing to remove". Every other failure to delete
 * or rewrite the store used to be read as that, or swallowed, so a logout
 * answered "removed from this machine" over a token still on disk and still
 * in use, and "no stored credentials" over a file it could not delete. A
 * failure now comes back as `failure` with the reason and the store as it
 * still stands, and nothing is reported removed. */
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
  if (!wanted) {
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
  const entry = selectEntry(store, { project: wanted });
  if (!entry) {
    return { cleared: false, path: file, removed: [], remaining: Object.keys(store.entries) };
  }
  const key = credentialKey(entry.workspaceSlug, entry.projectSlug);
  try {
    return withStoreLock(() => {
      const current = storeForWrite() ?? store;
      const entries = { ...current.entries };
      delete entries[key];
      const remaining = Object.keys(entries);
      if (remaining.length === 0) {
        try {
          fs.unlinkSync(file);
        } catch (err) {
          if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") throw err;
        }
        return { cleared: true, path: file, removed: [key], remaining: [] };
      }
      writeStore({
        version: 2,
        active: current.active === key ? (remaining[0] ?? null) : current.active,
        entries,
      });
      return { cleared: true, path: file, removed: [key], remaining };
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
