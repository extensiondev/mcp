// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators


import type { ImageRows } from "../tools/store-listing";
import type { RequirementsView } from "./store-requirements";

type Row = Record<string, unknown>;

export interface RecordRead {
  read: boolean;
  screenshots: string | null;
}

export const RECORD_UNREAD =
  "the listing record was not read back after the write, so whether it keeps screenshots from an earlier sync-listing was not looked at";

export function screenshotsOnRecord(requirements: RequirementsView | null): string | null {
  const row = requirements?.items.find((item) => /\.screenshots$/.test(item.id));

  return row && row.status === "have" ? row.actual || "screenshots on the listing record" : null;
}

export function screenshotsFrom(sent: number, record: RecordRead | null): string | null {
  if (sent) return `${sent} screenshot${sent === 1 ? "" : "s"} in the extension.dev listing record, sent by sync-listing`;
  if (!record) return null;
  if (record.screenshots) return `${record.screenshots} on the extension.dev listing record, kept from an earlier sync-listing; this call sent none`;

  return record.read ? null : `not read: ${RECORD_UNREAD}`;
}

export function onRecordRow(record: RecordRead): Row | null {
  if (record.screenshots) return { screenshots: record.screenshots };
  if (!record.read) return { unread: RECORD_UNREAD };

  return null;
}

const STORE_NAMES: Record<string, string> = {
  chrome: "Chrome Web Store",
  edge: "Edge Add-ons",
  firefox: "Firefox AMO",
  safari: "App Store",
};

export function onRecordSentence(store: string, record: RecordRead, images: ImageRows | null): string {
  if (!record.screenshots) return `This call sent no screenshots, and ${RECORD_UNREAD}.`;

  const name = STORE_NAMES[store] ?? store;
  const clears = images?.clears.length ? `, which clear the ${name} ${images.clears.join(" and ")} row${images.clears.length === 1 ? "" : "s"}` : "";
  const remain = images?.remain.length ? `; still open: ${images.remain.join("; ")}` : "";

  return `This call sent no screenshots; the extension.dev listing record keeps ${record.screenshots} from an earlier sync-listing${clears}${remain}.`;
}
