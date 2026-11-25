// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { isEnvelope, reframed, type Envelope } from "./envelope";

export const ANSWER_VALUE_CHAR_LIMIT = 40_000;

const SHRINK_STEPS: Array<[number, number]> = [
  [8_000, 200],
  [2_000, 100],
  [500, 50],
  [200, 20],
  [80, 10],
];

const NARROWER_CALLS: Record<string, string> = {
  extension_eval: "Return only what you need from the expression: a path into the object, a slice of an array, or a JSON.stringify of the fields you want.",
  extension_storage: "Read one key with key instead of the whole area.",
  extension_logs: "Call extension_logs again with a smaller limit or a later since.",
};

/* @invariant AN ANSWER CARRYING WHAT A PAGE OR AN EXTENSION HOLDS NEVER
 * OUTGROWS WHAT A CLIENT TAKES, AND A CUT ANSWER SAYS SO. Claude Code warns at 10,000 tokens, stops at 25,000 and
 * moves text over 50,000 characters to a file, and both directory reviews
 * ask for frugal answers, while an eval of a large object, a storage area
 * or a long log run had no bound at all (ledger 1125). Every answer passes
 * here once, and an answer of one of the tools whose value is whatever the
 * page or the extension holds (eval, storage, logs) is bounded: a value
 * whose JSON is longer than the limit keeps its keys,
 * with long strings shortened and long arrays cut until it fits (only its
 * opening JSON as text when even that does not), the envelope says
 * truncated: true, value.answerCut names the full and the kept length, and
 * the hint names the narrower call that reads the rest. The tool's own
 * hint moves to warnings, so nothing it said is lost.
 */
export function cappedAnswer(text: string, limit = ANSWER_VALUE_CHAR_LIMIT): string {
  if (text.length <= limit) return text;

  let parsed: unknown;

  try {
    parsed = JSON.parse(text);
  } catch {
    return text;
  }

  if (!isEnvelope(parsed) || parsed.value === undefined || parsed.value === null) return text;

  const frame = parsed as Envelope & { hint?: string };
  const narrower = NARROWER_CALLS[frame.command];
  if (!narrower) return text;

  const full = JSON.stringify(frame.value);
  if (full.length <= limit) return text;

  const kept = SHRINK_STEPS.map(([chars, items]) => shrunk(frame.value, chars, items)).find((candidate) => JSON.stringify(candidate).length <= limit);
  const base = isRecord(kept) ? kept : { opening: full.slice(0, limit) };
  const value = { ...base, answerCut: { fullChars: full.length, keptChars: JSON.stringify(base).length, limit } };

  return reframed({
    ok: frame.ok,
    command: frame.command,
    status: frame.status,
    value,
    error: frame.error ?? undefined,
    warnings: [...frame.warnings, ...(frame.hint ? [frame.hint] : [])],
    truncated: true,
    hint: `This answer's value was ${full.length} characters, over the ${limit} a client takes, so it was cut. ${narrower}`,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function shrunk(value: unknown, chars: number, items: number, nested = false): unknown {
  if (typeof value === "string") return value.length > chars ? `${value.slice(0, chars)}...` : value;
  if (Array.isArray(value)) return value.slice(0, items).map((entry) => shrunk(entry, chars, items, true));
  if (!isRecord(value)) return value;

  const entries = Object.entries(value);

  return Object.fromEntries((nested ? entries.slice(0, items) : entries).map(([key, entry]) => [key, shrunk(entry, chars, items, true)]));
}
