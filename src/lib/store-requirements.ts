// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { isRow, text } from "./ship-act";
import { STORE_MD_FILENAME } from "./store-md";

import type { ListingField } from "./store-md-listing";
import type { LocalListing } from "../tools/store-listing";

export interface RequirementRow {
  id: string;
  label: string;
  required: boolean;
  format: string;
  status: "have" | "missing" | "unknown";
  satisfiedBy: string;
  how: string;
  docs?: string;
  actual?: string;
  push?: string;
}

export interface RequirementsView {
  store: string;
  items: RequirementRow[];
  missingRequired: number;
  missingOptional: number;
}

export type LocalListingRead = LocalListing | { problem: string } | null;

const STORE_NAMES: Record<string, string> = {
  chrome: "The Chrome Web Store",
  edge: "Edge Add-ons",
  firefox: "Firefox AMO",
  safari: "The App Store",
};

const NAMED_AT_MOST = 8;

const STORE_MD_REFS: Record<string, ListingField | "screenshots"> = {
  name: "title",
  subtitle: "subtitle",
  summary: "shortDescription",
  description: "fullDescription",
  category: "categories",
  screenshots: "screenshots",
  "single purpose": "singlePurpose",
  "permissions justification": "permissionJustifications",
  "privacy policy url": "privacyPolicyUrl",
  homepage: "homepageUrl",
  "search terms": "searchTerms",
  "release notes": "releaseNotes",
  "reviewer notes": "reviewerNotes",
  "review contact name": "reviewContactName",
  "review contact email": "reviewContactEmail",
  "review contact phone": "reviewContactPhone",
  license: "license",
  "support email": "supportEmail",
  "certification notes": "certificationNotes",
};

const SECTION_HEADINGS: Partial<Record<ListingField, string>> = {
  singlePurpose: "### Single purpose",
  permissionJustifications: "### Permissions justification",
  reviewerNotes: "### Reviewer notes",
  releaseNotes: "### Release notes",
  certificationNotes: "### Certification notes",
  privacyPolicyUrl: "- Privacy policy URL:",
};

function statusOf(value: unknown): RequirementRow["status"] {
  const status = text(value);

  return status === "have" || status === "missing" ? status : "unknown";
}

function storeMdField(satisfiedBy: string): ListingField | "screenshots" | null {
  const match = /^store-md:\s*(.+)$/i.exec(satisfiedBy);

  return match ? (STORE_MD_REFS[match[1]!.trim().toLowerCase()] ?? null) : null;
}

function lineOf(local: LocalListing, field: ListingField): string {
  const written = local.lines[field];

  return written ? `- ${written}:` : SECTION_HEADINGS[field] ?? `- ${field}:`;
}

/* @invariant STORE.md SATISFIES AN INPUT THROUGH THE ONE PARSER THE SYNC USES.
 * The platform reads its listing record; this server holds the project's
 * STORE.md and reads it with parseStoreMdListing, the same read sync-listing
 * sends. An input the platform calls missing that STORE.md already carries is
 * answered have with the line that carries it, so the owner is never told to
 * write a line that is there; a line the reader could not take keeps the
 * input missing and names, in actual, the line it wants. Nothing here invents
 * an input, and the storeMd block of the same answer is built from the same
 * LocalListing, so the two can only agree.
 */
function withStoreMd(row: RequirementRow, local: LocalListingRead): RequirementRow {
  if (!local || "problem" in local || row.status !== "missing") return row;

  const field = storeMdField(row.satisfiedBy);
  if (!field) return row;

  if (field === "screenshots") {
    const shots = local.patch.screenshots;

    if (shots?.length && local.screenshotsLine) {
      return {
        ...row,
        status: "have",
        satisfiedBy: `store-md: ${local.screenshotsLine}`,
        actual: `${shots.length} files on the \`${local.screenshotsLine}\` line of ${STORE_MD_FILENAME}; sync-listing uploads them`,
      };
    }

    return local.screenshotsUnread
      ? {
          ...row,
          actual: `the \`${local.screenshotsUnread.line}\` line in ${STORE_MD_FILENAME} ${local.screenshotsUnread.reason}; the reader takes \`- Screenshots:\` with one PNG path per line below it`,
        }
      : row;
  }

  const listing = local.patch.listing as Record<string, unknown>;

  if (listing[field] !== undefined) {
    return {
      ...row,
      status: "have",
      satisfiedBy: `store-md: ${lineOf(local, field)}`,
      actual: `in ${STORE_MD_FILENAME}; sync-listing writes it`,
    };
  }

  const unread = local.unread[field];

  return unread
    ? { ...row, actual: `the \`${unread.line}\` line in ${STORE_MD_FILENAME} ${unread.reason}` }
    : row;
}

/* @invariant THE LIST IS THE PLATFORM'S, PASSED THROUGH WHOLE. Every row the
 * platform answers is kept with its own words: the store's label, the exact
 * format, what satisfies it, whether the project has it and, for the App
 * Store, the state of the push that carries it. Nothing here adds an input,
 * drops one, or offers to make one; the platform generates none of these
 * artifacts and neither does this server. A missing count is read from the
 * platform when it answers one and counted from the rows only when it does
 * not, so the sentence and the list never disagree; a push state is never a
 * count, because an input that is on file and not yet pushed is on file.
 */
export function requirementsView(value: unknown, local: LocalListingRead = null): RequirementsView | null {
  if (!isRow(value) || !Array.isArray(value.items)) return null;

  const items = value.items.filter(isRow).map((row): RequirementRow =>
    withStoreMd(
      {
        id: text(row.id),
        label: text(row.label),
        required: row.required === true,
        format: text(row.format),
        status: statusOf(row.status),
        satisfiedBy: text(row.satisfiedBy),
        how: text(row.how),
        ...(text(row.docs) ? { docs: text(row.docs) } : {}),
        ...(text(row.actual) ? { actual: text(row.actual) } : {}),
        ...(text(row.push) ? { push: text(row.push) } : {}),
      },
      local,
    ),
  );
  const counted = (required: boolean) =>
    items.filter((item) => item.required === required && item.status === "missing").length;
  const overlaid = local !== null && !("problem" in local);

  return {
    store: text(value.store),
    items,
    missingRequired: !overlaid && typeof value.missingRequired === "number" ? value.missingRequired : counted(true),
    missingOptional: !overlaid && typeof value.missingOptional === "number" ? value.missingOptional : counted(false),
  };
}

export function missingRequiredSentence(store: string, view: RequirementsView | null): string {
  if (!view) return "";

  const missing = view.items.filter((item) => item.required && item.status === "missing");
  if (!missing.length) return "";

  const named = missing.slice(0, NAMED_AT_MOST).map((item) => `${item.label} (${item.format})`);
  const more = missing.length - named.length;
  const count = missing.length === 1 ? "1 required input" : `${missing.length} required inputs`;

  return `${STORE_NAMES[store] ?? store} asks for ${count} the project does not have yet: ${named.join("; ")}${more > 0 ? `; and ${more} more` : ""}.`;
}

export function missingRequirementsSentences(stores: Record<string, unknown>): string {
  return Object.entries(stores)
    .map(([store, view]) =>
      isRow(view) && isRow(view.requirements)
        ? missingRequiredSentence(store, requirementsView(view.requirements))
        : "",
    )
    .filter(Boolean)
    .join(" ");
}

export function configuredRequirementsNote(answer: unknown, store: string): string {
  if (!isRow(answer)) return "";

  const direct = requirementsView(answer.requirements);
  const byStore = isRow(answer.requirements) ? requirementsView((answer.requirements as Record<string, unknown>)[store]) : null;
  const view = direct && direct.store === store ? direct : byStore;
  if (!view) return "";

  if (view.missingRequired === 0) return " Every required input the store asks for is on file.";

  const count = view.missingRequired === 1 ? "1 required input" : `${view.missingRequired} required inputs`;

  return ` The store asks for ${count} the project does not have yet; the preflight names each with its format.`;
}
