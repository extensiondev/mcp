// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { mcpOrigins } from "./origins";

export const FREE_ALLOWANCE_PHRASE = "counts against your free allowance";

/* @invariant
 * THE NUMBERS AND THE DATES ARE THE PLATFORM'S, NEVER THIS TARBALL'S.
 *
 * Every spending result counts the allowance out loud, with the sizes and
 * dates sourced from the platform's own commerce and readiness modules and
 * never written as literals. Those modules are private workspace packages a
 * published npm client cannot depend on, so this module reads the same
 * sources one hop later: the wall sentence points at the pricing page, which
 * renders what those modules say at request time, and a count is spoken only
 * when a platform response carries one. Today no spend response does, so the
 * honest narration names the spend and the wall and refuses to guess a
 * number. The moment the platform answers with used and limit,
 * readPlatformAllowance threads them through with no release of this package.
 * Nothing here may ever hold a calendar date or an allowance size of its own;
 * the specs assert both absences.
 */
export interface SpendNarration {
  spent: string;
  remains: string;
  wall: string;
}

export function allowanceWallUrl(apiHint?: string): string {
  return `${mcpOrigins(apiHint).www.replace(/\/+$/, "")}/pricing`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asCount(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

export function readPlatformAllowance(
  body: unknown,
): { used: number; limit: number } | null {
  const record = asRecord(body);
  if (!record) return null;
  for (const key of ["allowance", "quota"]) {
    const nested = asRecord(record[key]);
    if (!nested) continue;
    const used = asCount(nested.used);
    const limit = asCount(nested.limit);
    if (used !== null && limit !== null) return { used, limit };
  }
  return null;
}

export function spendNarration(options: {
  what: string;
  body?: unknown;
  api?: string;
}): SpendNarration {
  const counted = readPlatformAllowance(options.body);
  return {
    spent: `${options.what} ran on extension.dev's machines and ${FREE_ALLOWANCE_PHRASE}.`,
    remains: counted
      ? `The platform reports ${counted.used} of ${counted.limit} used.`
      : "The platform sent no remaining count on this call, and this client never invents one. When the allowance runs out, the platform refuses with its own numbers.",
    wall: `What the free allowance covers and when the paid plan starts are published at ${allowanceWallUrl(
      options.api,
    )}.`,
  };
}
