// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { cappedAnswer } from "./answer-cap";
import { composedInThisCall } from "./composed-refusal";
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
/* @invariant A REFUSAL THE SERVER COMPOSES ITSELF IS NEVER FENCED, AND THE
 * SITE THAT BUILDS IT SAYS SO. The untrusted fence marks text a page, an
 * extension or a remote answer wrote; a refusal over the caller's login,
 * project or arguments holds none, and on 2026-11-19 an
 * E_NO_LOGIN_FOR_PROJECT sat inside the fence, costing tokens and teaching
 * the agent to distrust the server's own refusals (ledger 954). The code
 * alone never decides it: a platform body, the hosted lane and a published
 * build index can each put their text under any of these codes (ledger
 * 1006). A refusal goes out bare only when its builder registered it with
 * composedRefusal in this same call (composed-refusal.ts), no answer of the
 * call was relayed from the lane, and its code is one of these. Every other
 * refusal of an untrusted tool is fenced.
 */
const COMPOSED_REFUSAL_CODES = new Set([
  "E_NO_LOGIN_FOR_PROJECT",
  "E_PROJECT_AMBIGUOUS",
  "E_AUTH_REQUIRED",
  "E_AUTH_EXPIRED",
  "E_INPUT_VALIDATION",
  "E_TOOL_DISABLED",
  "E_UNKNOWN_TOOL",
  "E_SERVER_STALE",
]);

export function toolResultFrame(answer: string, untrusted = false): ToolFrame {
  const result = hintedAnswer(cappedAnswer(answer));
  let refused: boolean;
  let composed = false;

  try {
    const parsed: unknown = JSON.parse(result);
    refused = isEnvelope(parsed) && parsed.ok === false;
    composed = refused && COMPOSED_REFUSAL_CODES.has(String((parsed as Envelope).error?.code ?? "")) && composedInThisCall(parsed as Envelope);
  } catch {
    refused = false;
  }

  return {
    content: [
      {
        type: "text" as const,
        text: untrusted && !composed ? fenceUntrusted(result) : result,
      },
    ],
    ...(refused || (untrusted && !isEnvelopeText(result)) ? { isError: true } : {}),
  };
}

/* @invariant EVERY ANSWER CARRIES ITS ENVELOPE AS structuredContent TOO,
 * AND NEVER UNFENCES WHAT THE TEXT FENCED. Each listed tool declares the
 * shared envelope as its outputSchema (ledger 1107), and a client that reads
 * structuredContent sees no more than the text shows: an envelope the text
 * carries bare is the structured answer as it is; a fenced answer keeps
 * only its trusted head (ok, command, status) and puts the whole fenced
 * text in value.text, so a page's words stay between the fence markers; a
 * payload outside the envelope is carried the same way.
 */
export function withStructuredContent(frame: ToolFrame, command: string): ToolFrame {
  const text = frameText(frame);
  let parsed: unknown;

  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }

  if (isEnvelope(parsed) && !("untrustedEnd" in (parsed as object))) {
    return { ...frame, structuredContent: parsed as unknown as Record<string, unknown> };
  }

  const head = isEnvelope(parsed) ? (parsed as Envelope) : null;

  return {
    ...frame,
    structuredContent: {
      ok: head ? head.ok === true : frame.isError !== true,
      command: head && typeof head.command === "string" ? head.command : command,
      status: head && typeof head.status === "string" ? head.status : frame.isError ? "error" : "answered",
      value: head ? { untrusted: true, text } : { text },
    },
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
