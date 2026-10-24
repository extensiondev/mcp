// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import fs from "node:fs";
import { fileURLToPath } from "node:url";

import { envelope, isEnvelope } from "./envelope";

import { version } from "../../package.json";

type Row = Record<string, unknown>;

export interface ServerStamp {
  version: string;
  builtAt: string | null;
}

export function rebuiltWarning(at: string): string {
  return `The server you are running was rebuilt at ${at}; reconnect once to use it.`;
}

export const SERVER_STALE_STATUS = "server-stale";

export function staleSentence(at: string): string {
  return `This server was rebuilt at ${at}; run /mcp and pick extension-dev, then call again.`;
}

export function reloadedWarning(at: string): string {
  return `This server reloaded its code from the ${at} build before answering.`;
}

export function localRebuiltWarning(at: string): string {
  return `This server was rebuilt at ${at}; its local tools keep the code they loaded until you run /mcp and pick extension-dev, while platform tools already answer from the new build.`;
}

export function staleEnvelope(command: string, at: string, stamp: ServerStamp, args: Row = {}, reloadError?: string): string {
  return envelope({
    ok: false,
    command,
    status: SERVER_STALE_STATUS,
    value: {
      ...(typeof args.action === "string" ? { action: args.action } : {}),
      server: stamp,
      ...(reloadError ? { reloadError } : {}),
    },
    error: { code: "E_SERVER_STALE", name: "ServerStale", message: staleSentence(at) },
  });
}

function mtimeOf(file: string): string | null {
  if (!file) return null;

  try {
    return fs.statSync(file).mtime.toISOString();
  } catch {
    return null;
  }
}

/* @invariant EVERY PLATFORM ANSWER SAYS WHICH SERVER ANSWERED, AND WHETHER
 * A NEWER ONE IS WAITING. The operation rebuilds this server from source on
 * the person's machine several times a night, and the only sign that a fix
 * is live was the person reconnecting on a guess: five reconnects in one
 * session. The stamp is the package version and the build time of the file
 * this process loaded; the warning appears when that file on disk is newer
 * than the one running, which is exactly when a reconnect does something.
 */
export function createServerStamp(entry: string): {
  entry: string;
  stamp: () => ServerStamp;
  rebuiltSince: () => string | null;
  apply: (result: string) => string;
} {
  const loadedAt = mtimeOf(entry);

  const stamp = (): ServerStamp => ({ version, builtAt: loadedAt });

  const rebuiltSince = (): string | null => {
    const now = mtimeOf(entry);

    return now && loadedAt && now > loadedAt ? now : null;
  };

  const apply = (result: string): string => {
    let parsed: unknown;

    try {
      parsed = JSON.parse(result);
    } catch {
      return result;
    }

    if (!isEnvelope(parsed)) return result;

    const value: Row = parsed.value && typeof parsed.value === "object" && !Array.isArray(parsed.value) ? { ...(parsed.value as Row) } : {};
    const rebuilt = rebuiltSince();
    const warnings = [...(Array.isArray(parsed.warnings) ? parsed.warnings : []), ...(rebuilt ? [rebuiltWarning(rebuilt)] : [])];

    return envelope({
      ok: parsed.ok,
      command: parsed.command,
      status: parsed.status,
      value: { ...value, server: stamp() },
      error: parsed.error,
      warnings,
      ...(parsed.truncated !== undefined ? { truncated: parsed.truncated } : {}),
      ...(typeof (parsed as { hint?: unknown }).hint === "string" ? { hint: (parsed as { hint: string }).hint } : {}),
    });
  };

  return { entry, stamp, rebuiltSince, apply };
}

export type ServerStampReader = ReturnType<typeof createServerStamp>;

function runningEntry(): string {
  try {
    return fileURLToPath(import.meta.url);
  } catch {
    return "";
  }
}

export const serverStamp = createServerStamp(runningEntry());
