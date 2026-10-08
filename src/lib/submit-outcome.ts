// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

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
