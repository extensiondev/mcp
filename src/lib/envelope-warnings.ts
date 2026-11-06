// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { envelope, isEnvelope } from "./envelope";

export function appendWarnings(out: string, warnings: string[] | undefined): string {
  if (!warnings?.length) return out;

  let parsed: unknown;

  try {
    parsed = JSON.parse(out);
  } catch {
    return out;
  }

  if (!isEnvelope(parsed)) return out;

  const frame = parsed as typeof parsed & { hint?: string };

  return envelope({
    ok: frame.ok,
    command: frame.command,
    status: frame.status,
    value: frame.value,
    error: frame.error ?? undefined,
    warnings: [...(frame.warnings ?? []), ...warnings],
    ...(frame.truncated !== undefined ? { truncated: frame.truncated } : {}),
    ...(frame.hint ? { hint: frame.hint } : {}),
  });
}
