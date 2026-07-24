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
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    // Best-effort: some filesystems (e.g. Windows) do not support chmod.
  }
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

export function readValidCredentials(
  nowSeconds: number = Math.floor(Date.now() / 1000),
): StoredCredentials | null {
  const creds = readCredentials();
  if (!creds) return null;
  if (creds.expiresAt && creds.expiresAt <= nowSeconds) return null;
  return creds;
}
