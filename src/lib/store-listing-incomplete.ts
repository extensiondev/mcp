// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { isRow, text } from "./ship-act";
import { bringListOf, type BringList } from "./store-bring-list";
import { requirementsView, type RequirementRow } from "./store-requirements";

export const LISTING_INCOMPLETE_CODE = "LISTING_INCOMPLETE";

export type ListingIncompleteRow = Pick<RequirementRow, "id" | "label" | "required" | "format" | "satisfiedBy" | "how"> & {
  docs?: string;
  actual?: string;
  status?: RequirementRow["status"];
  supply?: "from your build" | "you supply";
};

export interface ListingIncompleteStub {
  code: typeof LISTING_INCOMPLETE_CODE;
  message: string;
  rows: ListingIncompleteRow[];
  store?: string;
  refusedBeforeApproval?: true;
}

export interface ListingIncomplete {
  store: string;
  missing: RequirementRow[];
  bringList: BringList | null;
}

/* @invariant THE 409 IS READ AGAINST ONE TYPED SHAPE, AND NOTHING ELSE IS
 * SAID ABOUT IT. The www publish and submissions routes refuse a review send
 * with 409 LISTING_INCOMPLETE before any approval is minted or consumed,
 * carrying the rows the store still asks for; this reader takes that body in
 * the stub shape above, `{ code, message, rows }` with `rows` the per-store
 * requirement rows the console lane reads too (`missing`, `items` and
 * `requirements.items` are read the same way until the platform's shape is
 * pinned), and hands back the rows in the platform's own words, with the
 * bring list that names the door for each. A store the body does not name
 * is the store the call asked for. A refusal of this code is never a
 * recorded submission and never spent an approval, and the answer says so.
 */
export function listingIncompleteOf(code: string, body: unknown, askedStore = ""): ListingIncomplete | null {
  if (code !== LISTING_INCOMPLETE_CODE || !isRow(body)) return null;

  const store = text(body.store) || askedStore;
  const requirements = isRow(body.requirements) ? body.requirements : null;
  const rows = [body.rows, body.missing, body.items, requirements?.items].find(Array.isArray) as unknown[] | undefined;
  const view = requirementsView({ store, items: (rows ?? []).filter(isRow).map((row) => ({ status: "missing", required: true, ...row })) });
  const missing = view ? view.items.filter((row) => row.status === "missing") : [];
  const bringList = bringListOf(store, view, false);

  return { store, missing, bringList };
}

export function listingIncompleteSentence(found: ListingIncomplete, storeName: string): string {
  const rows = found.missing.filter((row) => row.required);
  const named = (rows.length ? rows : found.missing).map((row) => `${row.label} (${row.format})`);
  const count = named.length === 1 ? "1 required input" : `${named.length} required inputs`;

  return `${storeName} would refuse this review: the listing still lacks ${count}${named.length ? `: ${named.join("; ")}` : ""}. Nothing was sent to review, no approval was spent and no submission was recorded.`;
}
