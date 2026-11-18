// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { hintedAnswer } from "./envelope";

/* @invariant THE HTML A TOOL ANSWERS FITS THE CLIENT THAT ASKED. The cap was
 * 262144 characters on every path, and on 2026-11-18 (ledger 938) an
 * extension_dom_snapshot answer of 259,473 characters came back under it and
 * the client refused the whole answer as too large, so the call bought
 * nothing; extension_inspect kept the same default (ledger 939). One default
 * for both tools lives here: it is what a client reads in one answer, it is
 * sent to whatever reads the page and applied again to what came back, and a
 * cut answer says so three ways: value.htmlTruncated, the full size in
 * value.summary.htmlLength, and a hint naming what the tool offers to read
 * less and the argument that reads more. Closed shadow roots share one cap
 * between them, since a page can hold any number of them.
 */
export const HTML_DEFAULT_MAX_BYTES = 32_768;

function htmlCutHint(shown: number, full: number, readLess: string): string {
  return `value.html is the first ${shown} ${full > shown ? `of ${full} ` : ""}characters of the page's markup (value.htmlTruncated). To read less, ${readLess}. To read more of the markup in one answer, pass maxBytes${full > shown ? `, up to ${full}` : ""}${full > HTML_DEFAULT_MAX_BYTES ? "; a client may refuse an answer that long" : ""}.`;
}

export function withHtmlCap(raw: string, maxBytes: number, readLess: string): string {
  let frame: Record<string, any> | null;

  try {
    frame = JSON.parse(raw);
  } catch {
    return raw;
  }

  const value = frame?.ok === true ? frame.value : null;
  if (!frame || !value || typeof value !== "object" || typeof value.html !== "string") return raw;

  const cap = Number.isFinite(maxBytes) && maxBytes > 0 ? Math.floor(maxBytes) : 0;
  const over = cap > 0 && value.html.length > cap;
  if (!over && value.htmlTruncated !== true) return raw;

  const summary = value.summary && typeof value.summary === "object" ? value.summary : null;
  const reported = Number(summary?.htmlLength);
  const full = Math.max(value.html.length, Number.isFinite(reported) ? reported : 0);

  if (over) value.html = value.html.slice(0, cap);

  value.htmlTruncated = true;

  if (summary) summary.htmlLength = full;

  const hint = htmlCutHint(value.html.length, full, readLess);
  frame.hint = typeof frame.hint === "string" && frame.hint ? `${hint} ${frame.hint}` : hint;

  return hintedAnswer(JSON.stringify(frame));
}

export type ClosedRoot = { host: string; type: string; html: string; truncated?: boolean };

export function withinOneCap(roots: ClosedRoot[], maxBytes: number): ClosedRoot[] {
  let left = Math.max(0, Math.floor(maxBytes));

  return roots.map((root) => {
    const html = root.html.slice(0, left);
    left -= html.length;

    return html.length < root.html.length ? { ...root, html, truncated: true } : root;
  });
}
