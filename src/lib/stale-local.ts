// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { envelope, isEnvelope, type Envelope } from "./envelope";
import { SERVER_STALE_STATUS, staleLocalWarning, type ServerStamp } from "./server-stamp";
import { ASSERT_CHECKS } from "./verdict";

type Row = Record<string, unknown>;

export interface HeldLocal {
  rebuilt: string;
  reason: string;
  version: string | null;
  assertChecks: string[] | null;
}

export interface NewerBuild {
  version: string | null;
  builtAt: string;
}

export function newerBuildOf(held: HeldLocal): NewerBuild {
  return { version: held.version, builtAt: held.rebuilt };
}

export function noLocalCarryReason(at: string): string {
  return `the ${at} build does not carry this process's local sessions (it predates the local-state handover of ledger 300)`;
}

function row(value: unknown): Row | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Row) : null;
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

/* @invariant EVERY ANSWER FROM HELD LOCAL CODE SAYS SO, AND SO DOES THE
 * VERDICT IT PRODUCES. Until ledger 300 the stale-code warning rode on
 * whichever call came first after a rebuild, so an extension_start warned
 * and the extension_wait and extension_assert after it did not, and the
 * verdict read producer.version 10.18.1+a4ffd3d, outcome pass, which the
 * agent reported as the rerun of the fix it was checking. Now a local tool
 * reloads the rebuilt build like a platform tool does; when it cannot (the
 * reload failed, or the build on disk cannot adopt this process's sessions)
 * every answer the held code gives carries the warning with the reason,
 * value.server.stale with the newer build's stamp, and a verdict's producer
 * carries stale: true and newerBuild, so a pass from old code can never be
 * read as the new build's.
 */
export function markStaleLocal(result: string, stamp: ServerStamp, held: HeldLocal): string {
  const parsed = envelopeRow(result);
  if (!parsed) return result;

  const value: Row = row(parsed.value) ?? {};
  const newerBuild = newerBuildOf(held);
  const producer = row(value.producer);

  return envelope({
    ok: parsed.ok,
    command: parsed.command,
    status: parsed.status,
    value: {
      ...value,
      ...(producer ? { producer: { ...producer, stale: true, newerBuild } } : {}),
      server: { ...stamp, stale: true, newerBuild },
    },
    error: parsed.error,
    warnings: [...parsed.warnings, staleLocalWarning(stamp.builtAt, held.rebuilt, held.reason)],
    ...(parsed.truncated !== undefined ? { truncated: parsed.truncated } : {}),
    ...(parsed.hint ? { hint: parsed.hint } : {}),
  });
}

function assertIdsOf(args: Row): string[] {
  if (!Array.isArray(args.expect)) return [];

  const ids: string[] = [];

  for (const clause of args.expect) {
    const id = row(clause)?.assert;
    if (typeof id === "string" && id && !ids.includes(id)) ids.push(id);
  }

  return ids;
}

export function predatedChecks(name: string, args: Row, held: HeldLocal): string[] {
  if (name !== "extension_assert" || !held.assertChecks) return [];

  const known = new Set(ASSERT_CHECKS.map((check) => check.id));
  const newer = new Set(held.assertChecks);

  return assertIdsOf(args).filter((id) => !known.has(id) && newer.has(id));
}

export function predatesCheckEnvelope(name: string, ids: string[], stamp: ServerStamp, held: HeldLocal): string {
  const plural = ids.length === 1 ? "check" : "checks";
  const built = stamp.builtAt ?? "an unstamped time";

  return envelope({
    ok: false,
    command: name,
    status: SERVER_STALE_STATUS,
    value: {
      predates: ids,
      server: { ...stamp, stale: true, newerBuild: newerBuildOf(held) },
      reloadError: held.reason,
    },
    error: {
      code: "E_SERVER_STALE",
      name: "ServerStale",
      message: `This server predates the ${plural} ${ids.join(", ")}: it was built at ${built}, the build on disk at ${held.rebuilt} declares ${ids.length === 1 ? "it" : "them"}, and ${held.reason}; run /mcp and pick extension-dev, then assert again.`,
    },
  });
}
