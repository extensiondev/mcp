// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { hintedAnswer, isEnvelope, type Envelope, reframed } from "./envelope";
import { fenceUntrusted } from "./untrusted-fence";

import type { ToolFrame } from "./server-reload";

function isEnvelopeText(result: string): boolean {
  try {
    return isEnvelope(JSON.parse(result));
  } catch {
    return false;
  }
}

/* @invariant NO REFUSAL LEAVES THE DISPATCHER WITHOUT error.code AND
 * error.hint. envelope() fills both for every frame this server builds
 * (envelope.ts), and the two serializers that do not pass through it do so
 * on purpose: an act frame the engine wrote (act.ts) and an answer the
 * hosted lane wrote, relayed as its bytes (hosted-forwarder.ts). Both
 * frames end here, so this is the one place a failure written by another
 * program, or by an engine older than the hint, is completed before the
 * client reads it (ledger 912). A frame that already says its hint is
 * returned as the same string.
 */
export function toolResultFrame(answer: string, untrusted = false): ToolFrame {
  const result = hintedAnswer(answer);
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
  return { content: [{ type: "text" as const, text: hintedAnswer(text) }], isError: true };
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

  return reframed({
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
