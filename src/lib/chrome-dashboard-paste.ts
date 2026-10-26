// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { STORE_MD_FILENAME } from "./store-md";
import { storeMdLineOf } from "./store-md-fields";

import type { ListingField } from "./store-md-listing";
import type { LocalListing } from "../tools/store-listing";

export const CHROME_TABS = {
  listing: "Store listing",
  privacy: "Privacy",
  distribution: "Distribution",
  testInstructions: "Test instructions",
} as const;

export interface DashboardPasteField {
  field: string;
  label: string;
  tab: string;
  from: string | null;
}

export interface DashboardPaste {
  dashboardUrl: string | null;
  fields: DashboardPasteField[];
}

type Row = { field: string; label: string; tab: string; source?: ListingField | "screenshots" | "icon" | "privacy" };

const ROWS: Row[] = [
  { field: "fullDescription", label: "Description", tab: CHROME_TABS.listing, source: "fullDescription" },
  { field: "categories", label: "Category", tab: CHROME_TABS.listing, source: "categories" },
  { field: "language", label: "Language", tab: CHROME_TABS.listing },
  { field: "icon", label: "Store icon", tab: CHROME_TABS.listing, source: "icon" },
  { field: "screenshots", label: "Screenshots", tab: CHROME_TABS.listing, source: "screenshots" },
  { field: "homepageUrl", label: "Homepage URL", tab: CHROME_TABS.listing, source: "homepageUrl" },
  { field: "singlePurpose", label: "Single purpose", tab: CHROME_TABS.privacy, source: "singlePurpose" },
  { field: "permissionJustifications", label: "Permission justifications", tab: CHROME_TABS.privacy, source: "permissionJustifications" },
  { field: "remoteCode", label: "Remote code", tab: CHROME_TABS.privacy },
  { field: "dataUsage", label: "Data usage and the three certifications", tab: CHROME_TABS.privacy, source: "privacy" },
  { field: "privacyPolicyUrl", label: "Privacy policy URL", tab: CHROME_TABS.privacy, source: "privacyPolicyUrl" },
  { field: "visibility", label: "Visibility", tab: CHROME_TABS.distribution, source: "visibility" },
  { field: "testInstructions", label: "Test instructions", tab: CHROME_TABS.testInstructions },
];

function fromOf(local: LocalListing, source: Row["source"]): string | null {
  if (!source) return null;

  if (source === "icon") return local.patch.icons?.length ? "the built 128 px icon" : null;

  if (source === "screenshots") {
    const shots = local.patch.screenshots?.length ?? 0;

    return shots ? `${shots} screenshot${shots === 1 ? "" : "s"} in the extension.dev listing record, sent by sync-listing` : null;
  }

  if (source === "privacy") return local.privacy.section ? `\`## Privacy and data use\` in ${STORE_MD_FILENAME}` : null;

  if ((local.patch.listing as Record<string, unknown>)[source] === undefined) return null;

  const written = local.lines[source];

  return `\`${written ? `- ${written}:` : storeMdLineOf(source)}\` in ${STORE_MD_FILENAME}`;
}

/* @invariant A CHROME LISTING SYNC IS A RECORD AND A PASTE LIST, NEVER A
 * SEND. Google's v2 API cannot write the Store listing, Privacy,
 * Distribution or Test instructions tabs, so the platform stores what
 * STORE.md says and nothing reaches Google; Leon's sync answered
 * listing-synced while the dashboard held an empty description, no
 * screenshots and Visibility Public (MCP ledger 159). The answer is the list
 * of every field the dashboard alone takes, each with its exact tab and the
 * STORE.md line to paste from, or null where STORE.md holds none, and the
 * item's dashboard address when the platform knows it. The order is the
 * dashboard's own, tab by tab.
 */
export function chromeDashboardPaste(local: LocalListing, dashboardUrl: string | null): DashboardPaste {
  return {
    dashboardUrl,
    fields: ROWS.map((row) => ({ field: row.field, label: row.label, tab: row.tab, from: fromOf(local, row.source) })),
  };
}

export function chromePasteSentence(paste: DashboardPaste): string {
  const tabs = [...new Set(paste.fields.map((field) => field.tab))].map((tab) => {
    const labels = paste.fields.filter((field) => field.tab === tab).map((field) => field.label.toLowerCase());

    return `${tab} (${labels.join(", ")})`;
  });
  const where = paste.dashboardUrl ? ` at ${paste.dashboardUrl}` : "; link the item on the project's store settings page to get its address";

  return `Nothing of this listing reached Google: Chrome takes these fields only in the item's dashboard, and its API can neither write nor read them. extension.dev recorded STORE.md as the copy to paste; the owner pastes it on each tab${where}: ${tabs.join("; ")}. value.stores.chrome.pasteInDashboard lists each field with the STORE.md line it comes from.`;
}
