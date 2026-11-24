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
import { dropTrailing } from "../lib/linear-text";
import { STORE_MD_FORMAT_URL, renderStoreMdFormat } from "../lib/docs-store-md-fields";

const COMMAND = "extension_docs_search";
const NAMES_STORE_MD = /\bstore\.md\b/i;

export const schema = {
  name: COMMAND,
  description:
    "Search the Extension.js and extension.dev docs (free) for a WebExtension API, a manifest key, a permission or a browser difference. Answers matching pages with URLs and snippets to cite; extension_templates answers code to start from. An empty answer means the docs hold no match.",
  inputSchema: {
    type: "object" as const,
    properties: {
      query: { type: "string", description: "Words or a question; an API, manifest key or permission name matches best." },
      limit: {
        type: "number",
        minimum: 1,
        maximum: 8,
        default: 5,
        description: "Most pages to answer.",
      },
      api: API_BASE,
    },
    required: ["query"],
  },
};

type Result = { title: string; url: string; snippet: string; score: number };

const NO_MATCH = "No page matched. Try fewer or different words, or browse https://extension.js.org/docs; answer from memory only after that, and say the docs had no page.";
const HOLD_MAY_FILTER = "While the public hold is on, the platform filters its own platform pages out of these results server-side, so an extension.dev topic can be absent for that reason alone.";

function heldBackPlatformPages(heldBack: unknown): number {
  if (!heldBack || typeof heldBack !== "object") return 0;

  const count = (heldBack as { platformPages?: unknown }).platformPages;

  return typeof count === "number" && Number.isInteger(count) && count > 0 ? count : 0;
}

function holdFiltered(count: number): string {
  return `The public hold is on: the platform held back ${count} of its own platform pages from these results server-side, so this list is partial and an extension.dev topic can be absent for that reason alone.`;
}

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

  if (NAMES_STORE_MD.test(query)) {
    return envelope({
      ok: true,
      command: COMMAND,
      status: "found",
      value: { query, results: [{ title: "STORE.md format", url: STORE_MD_FORMAT_URL, snippet: renderStoreMdFormat() }] },
    });
  }

  const base = dropTrailing(mcpOrigins(args.api).www, "/");
  const limit = Math.floor(args.limit ?? 5);
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

  let body: { results?: Result[]; message?: string; retryAfterSeconds?: number; heldBack?: unknown } = {};
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
  const held = heldBackPlatformPages(body.heldBack);
  const hint = [results.length ? "" : NO_MATCH, held ? holdFiltered(held) : results.length ? "" : HOLD_MAY_FILTER].filter(Boolean).join(" ");

  return envelope({
    ok: true,
    command: COMMAND,
    status: results.length ? "found" : "no-match",
    value: { query, results, ...(held ? { heldBack: { platformPages: held } } : {}) },
    ...(hint ? { hint } : {}),
  });
}
