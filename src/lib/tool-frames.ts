// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { envelope, isEnvelope, type Envelope } from "./envelope";
import { fenceUntrusted } from "./untrusted-fence";

import type { ToolFrame } from "./server-reload";

function isEnvelopeText(result: string): boolean {
  try {
    return isEnvelope(JSON.parse(result));
  } catch {
    return false;
  }
}

export function toolResultFrame(result: string, untrusted = false): ToolFrame {
  let refused: boolean;

  try {
    const parsed: unknown = JSON.parse(result);
    refused = isEnvelope(parsed) && parsed.ok === false;
  } catch {
    refused = false;
  }

  return {
    content: [
      {
        type: "text" as const,
        text: untrusted ? fenceUntrusted(result) : result,
      },
    ],
    ...(refused || (untrusted && !isEnvelopeText(result)) ? { isError: true } : {}),
  };
}

export function refusedFrame(text: string): ToolFrame {
  return { content: [{ type: "text" as const, text }], isError: true };
}

export function frameText(frame: ToolFrame): string {
  return frame.content[0]?.text ?? "";
}

export function annotate(result: string, said: { note?: string; warning?: string }): string {
  if (!said.note && !said.warning) return result;

  let parsed: unknown;

  try {
    parsed = JSON.parse(result);
  } catch {
    return result;
  }

  if (!isEnvelope(parsed)) return result;

  const frame = parsed as Envelope & { hint?: string };
  const value = frame.value && typeof frame.value === "object" && !Array.isArray(frame.value) ? (frame.value as Record<string, unknown>) : {};
  const note = said.note ? (typeof value.note === "string" && value.note.trim() ? `${value.note.trim()} ${said.note}` : said.note) : undefined;

  return envelope({
    ok: frame.ok,
    command: frame.command,
    status: frame.status,
    value: note ? { ...value, note } : frame.value,
    error: frame.error ?? undefined,
    warnings: [...frame.warnings, said.warning],
    ...(frame.truncated !== undefined ? { truncated: frame.truncated } : {}),
    ...(frame.hint ? { hint: frame.hint } : {}),
  });
}
