// Local credentials store for the `login` flow.
//
// `login` persists a project-scoped extension.dev access token here so the
// publish path can discover it without the user exporting EXTENSION_DEV_TOKEN
// by hand. The file is the only thing on disk that holds the secret, so it is
// written 0600 (owner read/write only) and never logged.
//
// Location: $XDG_CONFIG_HOME/extension-dev/auth.json (defaulting to
// ~/.config/extension-dev/auth.json) on macOS/Linux; %APPDATA%\extension-dev\
// auth.json on Windows. The shape is versioned so the format can evolve.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface StoredCredentials {
  version: 1;
  /** The HMAC access token the publish path sends as `Bearer`. */
  token: string;
  workspaceSlug: string;
  projectSlug: string;
  /** Token expiry as unix epoch seconds (0 if unknown). */
  expiresAt: number;
  /** Platform base URL the token was minted against. */
  api: string;
  /** Which device flow minted this token: extension.dev-gated or GitHub-direct. */
  provider?: "extensiondev" | "github";
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

export function readCredentials(): StoredCredentials | null {
  try {
    const raw = fs.readFileSync(credentialsPath(), "utf8");
    const data = JSON.parse(raw) as Partial<StoredCredentials> | null;
    if (!data || typeof data !== "object") return null;
    if (data.version !== 1) return null;
    const token = String(data.token || "").trim();
    if (!token) return null;
    const provider =
      data.provider === "extensiondev" || data.provider === "github"
        ? data.provider
        : undefined;
    return {
      version: 1,
      token,
      workspaceSlug: String(data.workspaceSlug || ""),
      projectSlug: String(data.projectSlug || ""),
      expiresAt: Number(data.expiresAt || 0),
      api: String(data.api || ""),
      ...(provider ? { provider } : {}),
    };
  } catch {
    return null;
  }
}

export function writeCredentials(creds: StoredCredentials): string {
  const file = credentialsPath();
  const dir = path.dirname(file);
  // Make the directory that holds the secret owner-only (0700) too, not just the
  // file -- otherwise a world-traversable parent leaks the file's existence and
  // metadata. `mode` applies only to directories created here; the chmod also
  // tightens a pre-existing dir. The leading `0o` is the dir mode pre-umask.
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    // Best-effort: some filesystems (e.g. Windows) do not support chmod.
  }
  // The `mode` option only applies when the file is created, so chmod after
  // writing to also tighten perms on a pre-existing file.
  fs.writeFileSync(file, JSON.stringify(creds, null, 2) + "\n", {
    mode: 0o600,
  });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // Best-effort: some filesystems (e.g. Windows) do not support chmod.
  }
  return file;
}

export function clearCredentials(): { cleared: boolean; path: string } {
  const file = credentialsPath();
  try {
    fs.unlinkSync(file);
    return { cleared: true, path: file };
  } catch {
    return { cleared: false, path: file };
  }
}

/**
 * Return stored credentials only if the token has not expired. Used by the
 * publish token resolution so an expired local token falls through cleanly to
 * "no token" instead of producing a 401 from the platform.
 */
export function readValidCredentials(
  nowSeconds: number = Math.floor(Date.now() / 1000),
): StoredCredentials | null {
  const creds = readCredentials();
  if (!creds) return null;
  if (creds.expiresAt && creds.expiresAt <= nowSeconds) return null;
  return creds;
}
