// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { API_BASE } from "../lib/common-schema";
import { envelope } from "../lib/envelope";
import { mcpOrigins } from "../lib/origins";

const COMMAND = "extension_docs_search";

export const schema = {
  name: COMMAND,
  description:
    "Find pages in the Extension.js and extension.dev docs by keyword, each with a short excerpt. Use it before answering from memory on anything version-specific: a CLI flag, a manifest field across browsers, a store submission rule. Free and needs no login.",
  inputSchema: {
    type: "object" as const,
    properties: {
      query: { type: "string", description: "What to look up, in a few words." },
      limit: {
        type: "number",
        minimum: 1,
        maximum: 8,
        default: 5,
        description: "How many pages to return, 1 to 8.",
      },
      api: API_BASE,
    },
    required: ["query"],
  },
};

type Result = { title: string; url: string; snippet: string; score: number };

export async function handler(args: {
  query: string;
  limit?: number;
  api?: string;
}): Promise<string> {
  const query = String(args.query || "").trim();

  if (!query) {
    return envelope({
      ok: false,
      command: COMMAND,
      status: "bad-request",
      error: { code: "E_BAD_REQUEST", message: "query is required." },
    });
  }

  const base = mcpOrigins(args.api).www.replace(/\/+$/, "");
  const limit = Math.min(8, Math.max(1, Math.floor(Number(args.limit) || 5)));
  const url = `${base}/api/docs/search?q=${encodeURIComponent(query)}&limit=${limit}`;

  let res: Response;

  try {
    res = await fetch(url, { headers: { accept: "application/json" } });
  } catch (err) {
    return envelope({
      ok: false,
      command: COMMAND,
      status: "network-failed",
      error: {
        code: "E_NETWORK",
        message: `Could not reach ${base}: ${err instanceof Error ? err.message : String(err)}`,
      },
    });
  }

  let body: { results?: Result[]; message?: string; retryAfterSeconds?: number } = {};
  let bodyUnreadable: string | null = null;

  try {
    const parsed = (await res.json()) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not a JSON object");

    body = parsed as typeof body;
  } catch (err) {
    bodyUnreadable = err instanceof Error ? err.message : String(err);
  }

  if (!res.ok) {
    return envelope({
      ok: false,
      command: COMMAND,
      status: res.status === 429 ? "rate-limited" : "search-failed",
      error: {
        code: "E_PLATFORM",
        message: body.message || `Docs search answered ${res.status}.`,
      },
      ...(res.status === 429
        ? { hint: `Wait ${body.retryAfterSeconds ?? 60} seconds, or read the docs at https://extension.js.org/docs.` }
        : {}),
    });
  }

  /* @invariant A 2xx THE TOOL CANNOT READ IS NOT "NO MATCH". An HTML, empty
     or reshaped body used to become `{}` and answer "No page matched" from
     the tool agents consult before answering from memory. */
  if (bodyUnreadable !== null || !Array.isArray(body.results)) {
    return envelope({
      ok: false,
      command: COMMAND,
      status: "search-unreadable",
      error: {
        code: "E_PLATFORM",
        message: `Docs search answered ${res.status} but the body could not be read as {results: [...]}${bodyUnreadable !== null ? ` (${bodyUnreadable})` : ` (keys: ${Object.keys(body).join(", ") || "none"})`}. Nothing is known about whether a page matches.`,
      },
      hint: "Retry once; if it persists, read the docs at https://extension.js.org/docs.",
    });
  }

  const results = body.results;

  return envelope({
    ok: true,
    command: COMMAND,
    status: results.length ? "found" : "no-match",
    value: { query, results },
    ...(results.length
      ? {}
      : { hint: "No page matched. Try fewer or different words, or browse https://extension.js.org/docs. While the public hold is on, the platform filters its own platform pages out of these results server-side, so an extension.dev topic can be absent for that reason alone." }),
  });
}
