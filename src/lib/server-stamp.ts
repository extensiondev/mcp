// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import fs from "node:fs";
import { fileURLToPath } from "node:url";

import { envelope, isEnvelope, type Envelope } from "./envelope";
import { serverCommit, serverVersion } from "./producer-version";

type Row = Record<string, unknown>;

export interface ServerStamp {
  version: string;
  commit: string | null;
  builtAt: string | null;
  startedAt: string;
  pid: number;
}

export interface ListStaleStamp extends Partial<ServerStamp> {
  listStale: true;
  listedAt: string | null;
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

export function staleLocalWarning(loadedAt: string | null, at: string, reason: string): string {
  const held = loadedAt ? `the ${loadedAt} build this server loaded` : "the code this server loaded";

  return `This answer came from ${held}, not from the ${at} build on disk, because ${reason}; run /mcp and pick extension-dev to use that build. Every answer from the held code says this, and a verdict it produces carries producer.stale: true with the newer build.`;
}

export function listStaleSentence(listedAt: string | null, builtAt: string): string {
  const held = listedAt ? `is from the ${listedAt} build` : `predates it`;

  return `This server's tool list changed with the ${builtAt} build and the list your client holds ${held}: list the tools again before the next call, since this answer was validated by the new build's schema.`;
}

function envelopeRow(result: string): Envelope | null {
  let parsed: unknown;

  try {
    parsed = JSON.parse(result);
  } catch {
    return null;
  }

  return isEnvelope(parsed) ? parsed : null;
}

export function markListStale(result: string, listedAt: string | null, builtAt: string): string {
  const parsed = envelopeRow(result);
  if (!parsed) return result;

  const value: Row = parsed.value && typeof parsed.value === "object" && !Array.isArray(parsed.value) ? { ...(parsed.value as Row) } : {};
  const server: Row = value.server && typeof value.server === "object" && !Array.isArray(value.server) ? (value.server as Row) : { builtAt };
  const stale: ListStaleStamp = { ...server, listStale: true, listedAt };
  const sentence = listStaleSentence(listedAt, builtAt);

  return envelope({
    ok: parsed.ok,
    command: parsed.command,
    status: parsed.status,
    value: { ...value, server: stale },
    error: parsed.error,
    warnings: parsed.warnings,
    ...(parsed.truncated !== undefined ? { truncated: parsed.truncated } : {}),
    hint: parsed.hint ? `${parsed.hint} ${sentence}` : sentence,
  });
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

function processStartedAt(): string {
  return new Date(Date.now() - process.uptime() * 1000).toISOString();
}

function mtimeOf(file: string): string | null {
  if (!file) return null;

  try {
    return fs.statSync(file).mtime.toISOString();
  } catch {
    return null;
  }
}

/* @invariant EVERY ANSWER SAYS WHICH SERVER ANSWERED, AND WHETHER A NEWER
 * ONE IS WAITING. The operation rebuilds this server from source on
 * the person's machine several times a night, and the only sign that a fix
 * is live was the person reconnecting on a guess: five reconnects in one
 * session. The stamp is the package version and the build time of the file
 * this process loaded; the warning appears when that file on disk is newer
 * than the one running, which is exactly when a reconnect does something.
 * Since ledger 301 the stamp is on every envelope the dispatcher lets out,
 * refusals included: an agent that read `bad-request` with no version spent
 * a git log and an /mcp round trip finding out which checkout answered, and
 * `brand` adds value.server to any answer that carries none, leaving a stamp
 * a rebuilt build already wrote on its own answer alone.
 */
export function createServerStamp(entry: string): {
  entry: string;
  stamp: () => ServerStamp;
  rebuiltSince: () => string | null;
  apply: (result: string) => string;
  brand: (result: string) => string;
} {
  const loadedAt = mtimeOf(entry);
  const startedAt = processStartedAt();

  const stamp = (): ServerStamp => ({ version: serverVersion(), commit: serverCommit(), builtAt: loadedAt, startedAt, pid: process.pid });

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

  const brand = (result: string): string => {
    const parsed = envelopeRow(result);
    if (!parsed) return result;
    if (Array.isArray(parsed.value) || (parsed.value !== null && typeof parsed.value !== "object")) return result;

    const value: Row = parsed.value ? (parsed.value as Row) : {};
    if (value.server !== undefined) return result;

    return envelope({
      ok: parsed.ok,
      command: parsed.command,
      status: parsed.status,
      value: { ...value, server: stamp() },
      error: parsed.error,
      warnings: parsed.warnings,
      ...(parsed.truncated !== undefined ? { truncated: parsed.truncated } : {}),
      ...(parsed.hint ? { hint: parsed.hint } : {}),
    });
  };

  return { entry, stamp, rebuiltSince, apply, brand };
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
