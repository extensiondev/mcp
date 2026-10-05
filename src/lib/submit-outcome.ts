// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

/* @invariant
 * "SUBMITTED" MEANS A SUBMISSION ROW PER STORE ASKED, READ OFF THE ANSWER.
 *
 * A real submission is irreversible: it dispatches the store workflow, and a
 * second call dispatches it again. The platform answers 200 with one
 * `submissions` row per store it dispatched, and it dispatches the stores one
 * at a time, so a call for three stores can die after the first. This client
 * used to print "submitted" for any 2xx, including an empty list and a body
 * it could not parse. The stores are matched one by one: a row for every
 * store asked is submitted, a row for some is partial with the missing ones
 * named, and an answer without the list is unconfirmed, which is never
 * rounded up to yes and never retried blind.
 */
export type SubmitOutcome =
  | { state: "submitted"; stores: string[] }
  | { state: "partial"; stores: string[]; missing: string[] }
  | { state: "refused" }
  | { state: "unconfirmed"; why: string };

export function readSubmitOutcome(
  body: unknown,
  browsers: string[],
): SubmitOutcome {
  const record =
    body && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : null;
  if (!record) {
    return { state: "unconfirmed", why: "the answer was not a JSON object" };
  }
  if (record.ok === false) return { state: "refused" };
  if (record.ok !== true) {
    return { state: "unconfirmed", why: "the answer did not carry ok: true" };
  }
  if (!Array.isArray(record.submissions)) {
    return {
      state: "unconfirmed",
      why: "the answer carried no list of submissions",
    };
  }
  const recorded = new Set(
    record.submissions
      .map((row) =>
        row && typeof row === "object" && !Array.isArray(row)
          ? String((row as Record<string, unknown>).store ?? "")
              .trim()
              .toLowerCase()
          : "",
      )
      .filter(Boolean),
  );
  const stores = browsers.filter((browser) => recorded.has(browser));
  const missing = browsers.filter((browser) => !recorded.has(browser));
  if (stores.length === 0) {
    return {
      state: "unconfirmed",
      why: "the answer recorded a submission for none of the stores asked",
    };
  }
  if (missing.length) return { state: "partial", stores, missing };
  return { state: "submitted", stores };
}
