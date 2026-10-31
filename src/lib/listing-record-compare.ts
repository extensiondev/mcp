// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { isRow } from "./ship-act";
import { STORE_MD_FILENAME } from "./store-md";

type Row = Record<string, unknown>;

export type ListingRecordRead = { read: true; listing: Row } | { read: false };

export const RECORD_NOT_COMPARED = "the listing record was not read, so it was not compared";

export function listingRecordOf(read: { ok: boolean; json?: unknown } | null): ListingRecordRead {
  if (!read || !read.ok) return { read: false };

  const doc = isRow(read.json) ? read.json : {};

  return { read: true, listing: isRow(doc.listing) ? doc.listing : {} };
}

function normalized(value: unknown): string {
  if (Array.isArray(value)) return value.map(normalized).join("\n");
  if (isRow(value)) return Object.keys(value).sort().map((key) => `${key}=${normalized(value[key])}`).join("\n");
  if (value === undefined || value === null) return "";

  return String(value).replace(/\s+/g, " ").trim();
}

export function sameOnRecord(local: Row, fields: string[], record: Row): boolean {
  return fields
    .filter((field) => local[field] !== undefined)
    .every((field) => normalized(local[field]) === normalized(record[field]));
}

export function onListingLine(label: string, carries: string, local: Row, fields: string[], record: ListingRecordRead): string {
  const lead = `${label}: ${STORE_MD_FILENAME} carries ${carries}`;

  if (!record.read) return `${lead}; ${RECORD_NOT_COMPARED}`;
  if (sameOnRecord(local, fields, record.listing)) return `${lead}, already on the listing`;

  return `${label}: ${STORE_MD_FILENAME} differs from the listing: sync-listing sends the new text`;
}
