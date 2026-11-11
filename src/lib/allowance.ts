// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

export const ALLOWANCE_PHRASE = "is metered against the workspace's build allowance on extension.dev";

export const ALLOWANCE_WALL = "The console's workspace settings show what the allowance covers and how much of it is used.";

export interface SpendNarration {
  spent: string;
  remains: string;
  wall: string;
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
    spent: `${options.what} ${ALLOWANCE_PHRASE}.`,
    remains: counted
      ? `The platform reports ${counted.used} of ${counted.limit} used.`
      : "The platform sent no remaining count on this call, and this client never invents one.",
    wall: ALLOWANCE_WALL,
  };
}
