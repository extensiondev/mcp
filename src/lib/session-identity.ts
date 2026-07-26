// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const INSTALL_HEADER = "x-extensiondev-install";
export const SESSION_HEADER = "x-extensiondev-session";
export const TOOL_HEADER = "x-extensiondev-tool";

export const ROTATE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;

/* @invariant Neither id may ever be derived from the machine or the person.
 *
 * Both are 128 random bits. Not a hostname, not a MAC address, not a username,
 * not a home directory, not a hash of any of those. A derived id would be a
 * fingerprint that survives deletion of the file and can be recomputed by
 * anyone who guesses the recipe, which is exactly the identity Extension.js
 * refuses to collect. Random means the file IS the identity: delete it and the
 * link is gone for good.
 *
 * The install id also rotates every ROTATE_AFTER_MS so it cannot become a
 * permanent tracking cookie. That trades accuracy for the guarantee: a range
 * longer than the rotation window counts one long-lived machine more than once.
 */
export interface StoredInstallIdentity {
  version: 1;
  installId: string;
  rotatedAt: number;
}

/* @invariant This resolves its own config directory rather than reusing the
 * credentials module. The anonymous install id must exist for a caller who has
 * never signed in and must not travel with anything that identifies an account,
 * so the two files are neighbours on disk and strangers in code.
 */
export function installIdentityDir(): string {
  if (process.platform === "win32") {
    const base =
      process.env.APPDATA ||
      process.env.LOCALAPPDATA ||
      path.join(os.homedir(), "AppData", "Roaming");
    return path.join(base, "extension-dev");
  }
  const xdg = String(process.env.XDG_CONFIG_HOME || "").trim();
  const base = xdg || path.join(os.homedir(), ".config");
  return path.join(base, "extension-dev");
}

export function installIdentityPath(): string {
  return path.join(installIdentityDir(), "install.json");
}

export function telemetryDisabled(): boolean {
  const off = (value: string | undefined) => {
    const raw = String(value || "")
      .trim()
      .toLowerCase();
    return raw !== "" && raw !== "0" && raw !== "false";
  };
  return (
    off(process.env.EXTENSION_DEV_NO_TELEMETRY) || off(process.env.DO_NOT_TRACK)
  );
}

function randomId(): string {
  return crypto.randomBytes(16).toString("hex");
}

function readStoredInstallIdentity(): StoredInstallIdentity | null {
  try {
    const raw = fs.readFileSync(installIdentityPath(), "utf8");
    const data = JSON.parse(raw) as Partial<StoredInstallIdentity> | null;
    if (!data || typeof data !== "object") return null;
    if (data.version !== 1) return null;
    const installId = String(data.installId || "").trim();
    if (!/^[0-9a-f]{32}$/.test(installId)) return null;
    const rotatedAt = Number(data.rotatedAt || 0);
    if (!Number.isFinite(rotatedAt) || rotatedAt <= 0) return null;
    return { version: 1, installId, rotatedAt };
  } catch {
    return null;
  }
}

function writeStoredInstallIdentity(identity: StoredInstallIdentity): boolean {
  const file = installIdentityPath();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, JSON.stringify(identity, null, 2) + "\n", {
      mode: 0o600,
    });
    return true;
  } catch {
    return false;
  }
}

let ephemeralInstallId = "";

export function resolveInstallId(now: number = Date.now()): string {
  if (telemetryDisabled()) return "";
  try {
    installIdentityPath();
  } catch {
    return "";
  }
  const stored = readStoredInstallIdentity();
  if (stored && now - stored.rotatedAt < ROTATE_AFTER_MS) {
    return stored.installId;
  }
  const rotated: StoredInstallIdentity = {
    version: 1,
    installId: randomId(),
    rotatedAt: now,
  };
  if (writeStoredInstallIdentity(rotated)) {
    ephemeralInstallId = "";
    return rotated.installId;
  }
  /* @invariant A read-only or unwritable config directory must still produce a
   * usable session, so the id falls back to memory for this process. Every run
   * on such a host then looks like a brand new install, which OVERCOUNTS
   * distinct machines. CI containers are the common case.
   */
  if (!ephemeralInstallId) ephemeralInstallId = rotated.installId;
  return ephemeralInstallId;
}

let processSessionId = "";

export function sessionId(): string {
  if (telemetryDisabled()) return "";
  if (!processSessionId) processSessionId = randomId();
  return processSessionId;
}

export function resetSessionIdentityForTests(): void {
  processSessionId = "";
  ephemeralInstallId = "";
}

/* @invariant This may never throw, for any reason, on any host.
 *
 * It is spread into the headers of six calls that do real work for the caller:
 * publishing a build, revoking a share, submitting to a store. A counter that
 * can take one of those down is worth less than no counter at all, so every
 * path here ends in an empty object rather than an exception, and the call goes
 * out with no identity on it.
 */
export function identityHeaders(tool: string): Record<string, string> {
  try {
    if (telemetryDisabled()) return {};
    const name = String(tool || "")
      .trim()
      .toLowerCase();
    if (!/^[a-z0-9_]{1,64}$/.test(name)) return {};
    const install = resolveInstallId();
    const session = sessionId();
    if (!install || !session) return {};
    return {
      [INSTALL_HEADER]: install,
      [SESSION_HEADER]: session,
      [TOOL_HEADER]: name,
    };
  } catch {
    return {};
  }
}
