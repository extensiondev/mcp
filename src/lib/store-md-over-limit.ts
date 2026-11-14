// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { isRow, text } from "./row";
import { STORE_MD_FILENAME } from "./store-md";
import { STORE_SECTIONS, SUBSECTION_KEYS, type ListingField, type ListingStore } from "./store-md-declarations";
import { storeMdLineOf, storeMdSectionOf } from "./store-md-fields";
import { STORE_LABELS } from "./store-text-limits";

import type { OverLimitMeasure } from "./store-md-bounded";

export interface StoreMdOverLimit extends OverLimitMeasure {
  store: ListingStore;
  field: ListingField;
  line: string;
  section: string;
}

export const OVER_LIMIT_CODE = "LISTING_FIELD_OVER_LIMIT";

const count = (n: number): string => n.toLocaleString("en-US");

const isSubsection = (field: ListingField): boolean => SUBSECTION_KEYS.some((key) => key.field === field);

/* @invariant A VALUE OVER ITS STORE'S LIMIT IS NAMED BY THE LINE THE OWNER
 * WROTE, WITH THE NUMBER IT IS AND THE NUMBER THE STORE TAKES. The preflight
 * and sync-listing read the same STORE.md with the same table of per-store
 * limits (store-text-limits.ts, www's own copy), so a Firefox reviewer note
 * of 3,114 characters is refused here, before anything is sent, and not by
 * AMO after the other stores were written (ledger 413). The row names the
 * `###` heading and its `##` section for a subsection field, the bullet
 * line for a shared one, the measured length in the store's unit and the
 * limit, and the fix is always the same: shorten that line, or give the
 * store its own, then sync that store again.
 */
export function storeMdOverLimitOf(store: ListingStore, field: ListingField, measure: OverLimitMeasure, written?: string): StoreMdOverLimit {
  const line = written && !isSubsection(field) ? `- ${written}:` : storeMdLineOf(field);
  const section = isSubsection(field) ? STORE_SECTIONS[store] : storeMdSectionOf(field, store).section;

  return { store, field, line, section, ...measure };
}

export function overLimitPlace(over: StoreMdOverLimit): string {
  return `\`${over.line}\` under \`${over.section}\` in ${STORE_MD_FILENAME}`;
}

export function overLimitSentence(over: StoreMdOverLimit): string {
  return `${overLimitPlace(over)} (${over.field}) is ${count(over.length)} ${over.unit}, over the ${count(over.limit)} ${over.unit} ${STORE_LABELS[over.store]} takes`;
}

export function overLimitFix(over: StoreMdOverLimit): string {
  const own = isSubsection(over.field) ? "" : `, or give ${over.store} its own \`${over.line}\` line under \`${STORE_SECTIONS[over.store]}\``;

  return `Shorten ${overLimitPlace(over)} to ${count(over.limit)} ${over.unit} or fewer${own}`;
}

export function syncRetryCall(store: string, useBuild?: string): string {
  return `extension_submit action:"sync-listing" browsers:["${store}"] with the same projectPath${useBuild ? ` and useBuild ${useBuild}` : ""}`;
}

export function overLimitRefusalMessage(overs: StoreMdOverLimit[]): string {
  return `${overs.map(overLimitSentence).join("; ")}, so nothing was sent to ${overs[0]!.store}.`;
}

export function overLimitHint(overs: StoreMdOverLimit[], useBuild?: string): string {
  return `${overs.map(overLimitFix).join("; ")}, then call ${syncRetryCall(overs[0]!.store, useBuild)}.`;
}

export function overLimitSentences(stores: Record<string, unknown>): string {
  return Object.values(stores)
    .map((view) => {
      const storeMd = isRow(view) && isRow(view.storeMd) ? view.storeMd : null;
      const rows = storeMd && Array.isArray(storeMd.overLimit) ? (storeMd.overLimit as StoreMdOverLimit[]) : [];
      if (!rows.length) return "";

      return `${rows.map(overLimitSentence).join("; ")}; sync-listing refuses the ${rows[0]!.store} listing until it fits. ${overLimitFix(rows[0]!)}.`;
    })
    .filter(Boolean)
    .join(" ");
}

const MEASURED = /is ([\d,]+) (characters|bytes)/;

/* @invariant A LIMIT THE PLATFORM NAMES IS READ BACK INTO THE SAME ROW. When
 * www refuses a write with LISTING_FIELD_OVER_LIMIT (a limit this server's
 * table did not know, or a server behind the platform), its body carries the
 * field, the limit and the unit, and its message the measured length; the
 * row is rebuilt from those so the answer names the STORE.md line and the
 * fix the same way a local refusal does, instead of handing the person the
 * console page.
 */
export function platformOverLimitOf(store: ListingStore, body: unknown, message: string): StoreMdOverLimit | null {
  const row = isRow(body) ? body : null;
  const field = (row ? text(row.field) : "") || (/listing\.(\w+)/.exec(message)?.[1] ?? "");
  if (!field) return null;

  const measured = MEASURED.exec(message);
  const limit = row && typeof row.limit === "number" ? row.limit : 0;
  const unit = (row && text(row.unit) === "bytes") || measured?.[2] === "bytes" ? "bytes" : "characters";
  const length = measured ? Number(measured[1]!.replace(/,/g, "")) : 0;

  return storeMdOverLimitOf(store, field as ListingField, { length, limit, unit });
}
