// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { isRow, text } from "./ship-act";

type Row = Record<string, unknown>;

export interface PreflightDetail {
  all: boolean;
  keys: Set<string>;
}

export const PREFLIGHT_DETAIL_SENTENCE =
  'compact: each store\'s requirements and bringList list only the rows not on file (a missing row whole, an unknown row by its id and status) and count the rest in onFile, and the bringList sentence is in sayToPerson; detail: true answers every row in full, and detail: ["<store>" or "<requirement id>", ...] only those';

const UNKNOWN_REQUIREMENT_KEEPS = ["id", "label", "required", "status", "dashboardTab"];
const UNKNOWN_BRING_KEEPS = ["id", "status", "supply"];

export function preflightDetail(raw: unknown): PreflightDetail | { problem: string } {
  if (raw === undefined || raw === null || raw === false) return { all: false, keys: new Set() };
  if (raw === true) return { all: true, keys: new Set() };

  const list = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(",") : null;

  if (!list || list.some((key) => typeof key !== "string")) {
    return { problem: 'detail is true, or a list of stores and requirement ids such as ["chrome", "safari.subtitle"]' };
  }

  const keys = new Set(list.map((key) => text(key).toLowerCase()).filter(Boolean));

  return { all: keys.has("all") || keys.has("true"), keys };
}

function compactRow(row: unknown, keys: Set<string>, keeps: string[]): Row | null {
  if (!isRow(row)) return null;

  const id = text(row.id).toLowerCase();
  if (keys.has(id)) return row;

  const status = text(row.status);
  if (status === "have") return null;
  if (status !== "unknown") return row;

  return Object.fromEntries(keeps.filter((key) => row[key] !== undefined).map((key) => [key, row[key]]));
}

function compactRows(rows: unknown[], keys: Set<string>, keeps: string[]): { rows: Row[]; onFile: number } {
  const kept: Row[] = [];
  let onFile = 0;

  for (const row of rows) {
    const compact = compactRow(row, keys, keeps);
    if (compact) kept.push(compact);
    else if (isRow(row)) onFile += 1;
  }

  return { rows: kept, onFile };
}

/* @invariant A PREFLIGHT ANSWERS WHAT IS NOT ON FILE, AND COUNTS THE REST.
 * Every requirement row the platform lists carries its format, how and docs
 * text, so a four-store preflight that was all green answered 96,272
 * characters, over the client's tool-result limit, and the agent got a file
 * to slice instead of an answer (ledger 262). By default a row on file is
 * counted in onFile, an unknown row keeps its id, status and tab, a missing
 * row stays whole with its fix, and the bringList sentence, already in
 * sayToPerson, is not said twice; the failing and warning checks,
 * the summary, the connection and the STORE.md advisory are never trimmed.
 * detail: true, or the stores and requirement ids it names, answers them in
 * full.
 */
export function compactPreflightStores(stores: Row, detail: PreflightDetail): { stores: Row; trimmed: boolean } {
  if (detail.all) return { stores, trimmed: false };

  let trimmed = false;
  const shown: Row = {};

  for (const [store, view] of Object.entries(stores)) {
    if (!isRow(view) || detail.keys.has(store)) {
      shown[store] = view;
      continue;
    }

    const next: Row = { ...view };

    if (isRow(view.requirements) && Array.isArray(view.requirements.items)) {
      const { rows, onFile } = compactRows(view.requirements.items, detail.keys, UNKNOWN_REQUIREMENT_KEEPS);
      next.requirements = { ...view.requirements, items: rows, onFile };
      trimmed = true;
    }

    if (isRow(view.bringList) && Array.isArray(view.bringList.rows)) {
      const { rows, onFile } = compactRows(view.bringList.rows, detail.keys, UNKNOWN_BRING_KEEPS);
      const { say: _said, ...list } = view.bringList;

      next.bringList = { ...list, rows, onFile };
      trimmed = true;
    }

    shown[store] = next;
  }

  return { stores: shown, trimmed };
}
