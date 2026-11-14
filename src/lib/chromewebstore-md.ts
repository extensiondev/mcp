// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { chromeVisibilityOf } from "./chrome-visibility";
import { CHROMEWEBSTORE_MD_FILENAME } from "./store-md";
import { stripQuotes } from "./store-md-bullets";
import { STORE_FIELDS, type ListingField, type ListingStore, type ListingText, type PermissionJustification } from "./store-md-declarations";
import { linesNotFound, storeMdLineOf, storeMdSectionOf } from "./store-md-fields";

import type { LocalListingRead } from "./store-requirements";

type Row = Record<string, unknown>;

export { CHROMEWEBSTORE_MD_FILENAME };

export const CHROMEWEBSTORE_MD_CHECK = "listing.chromewebstore_md";

export const CHROMEWEBSTORE_MD_PREFILL_CALL = 'extension_submit_check {action: "preflight", browsers: ["chrome"], projectPath: "<project root>"}';

export const CHROMEWEBSTORE_MD_PREFILL_ANSWER = "value.readiness.listingDraft";

export interface ChromeWebStoreMd {
  file: string;
  listing: ListingText;
  headings: Partial<Record<ListingField, string>>;
  notMapped: string[];
}

export interface ChromeWebStoreHeld {
  field: ListingField;
  line: string;
  section: string;
  heading: string;
}

interface BoldField {
  key: string;
  value: string;
}

interface Section {
  heading: string;
  body: string;
}

const BOLD_FIELD = /^\*\*(.+?)\*\*(?:\s*\[(?:REQUIRED|RECOMMENDED)\])?\s*:?\s*(.*)$/;
const HEADING = /^#{1,3}\s+(.+)$/;
const RULE = /^---+\s*$/;
const TABLE_ROW = /^\|(.+)\|\s*$/;
const TABLE_RULE = /^\|?\s*:?-{2,}/;
const TABLE_HEADER = /^(permission|asset|data type|version|date)$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const URL = /^https?:\/\/\S+$/i;
const PERMISSIONS_SECTION = /^permissions? justifications?$/;
const PRIVACY_SECTION = /^privacy (&|and) data use/;
const GRAPHICS_SECTION = /^graphics/;

const BOLD_FIELDS: Array<{ key: RegExp; field: ListingField }> = [
  { key: /^extension name$/, field: "title" },
  { key: /^short description$/, field: "shortDescription" },
  { key: /^detailed description$/, field: "fullDescription" },
  { key: /^category$/, field: "categories" },
  { key: /^single purpose$/, field: "singlePurpose" },
  { key: /^privacy policy url$/, field: "privacyPolicyUrl" },
  { key: /^homepage url$/, field: "homepageUrl" },
  { key: /^visibility$/, field: "visibility" },
  { key: /^support url \/ email$/, field: "supportEmail" },
];

const NOT_MAPPED_BOLD: Array<{ key: RegExp; why: string }> = [
  { key: /^primary language$/, why: "Primary Language is the dashboard's Store listing tab language, which STORE.md has no line for" },
  { key: /^regions$/, why: "Regions are set on the dashboard's Distribution tab" },
  { key: /^publisher name$/, why: "Publisher Name is the developer account's, on the dashboard's Account tab" },
  { key: /^contact email$/, why: "Contact Email is the developer account's, verified on the dashboard's Account tab" },
];

const NOT_MAPPED_SECTIONS: Array<{ heading: RegExp; why: string }> = [
  { heading: GRAPHICS_SECTION, why: "Graphics & Assets: STORE.md carries no image; extension_screenshot and sync-listing take the screenshots, the build the icon" },
  { heading: PRIVACY_SECTION, why: "the Privacy & Data Use answers are yours to give on the dashboard's Privacy tab; this server never copies a data-use answer" },
  { heading: /^version history/, why: "Version History is the build's own record on extension.dev" },
  { heading: /^review notes/, why: "Review Notes are your own record; the Chrome Web Store takes no reviewer note" },
];

const stripComments = (content: string): string => content.replace(/<!--[\s\S]*?-->/g, "");

const placeholder = (value: string): boolean => !value || /^\[.*\]$/.test(value) || (/ \/ /.test(value) && value.split(" / ").every((option) => option.length <= 30));

const cellsOf = (line: string): string[] | null => {
  const row = TABLE_ROW.exec(line.trim());

  return row && !TABLE_RULE.test(line.trim()) ? row[1]!.split("|").map((cell) => cell.trim()) : null;
};

function sections(content: string): Section[] {
  const out: Section[] = [];
  let current: Section | null = null;

  for (const line of content.split("\n")) {
    const heading = /^##\s+(.+)$/.exec(line);

    if (heading) {
      if (current) out.push(current);

      current = { heading: heading[1]!.trim(), body: "" };
    } else if (current) current.body += `${line}\n`;
  }

  if (current) out.push(current);

  return out;
}

function boldFields(body: string): BoldField[] {
  const out: BoldField[] = [];
  let current: { key: string; lines: string[] } | null = null;

  const flush = () => {
    if (current) out.push({ key: current.key, value: current.lines.join("\n").replace(/\n{3,}/g, "\n\n").trim() });

    current = null;
  };

  for (const line of body.split("\n")) {
    const bold = BOLD_FIELD.exec(line.trim());

    if (bold) {
      flush();
      current = { key: bold[1]!.trim(), lines: bold[2]!.trim() ? [bold[2]!.trim()] : [] };
    } else if (HEADING.test(line) || RULE.test(line)) {
      flush();
    } else if (current) current.lines.push(line.replace(/\s+$/, ""));
  }

  flush();

  return out;
}

function tableRows(body: string): PermissionJustification[] {
  const rows: PermissionJustification[] = [];

  for (const line of body.split("\n")) {
    const cells = cellsOf(line);
    if (!cells) continue;

    const permission = stripQuotes(cells[0] ?? "");
    const justification = cells.length > 2 ? (cells[2] ?? "") : (cells[1] ?? "");
    if (!permission || !justification || TABLE_HEADER.test(permission)) continue;

    rows.push({ permission, justification });
  }

  return rows;
}

function privacyAnswered(body: string): boolean {
  if (/- \[x\]/i.test(body)) return true;

  const asked = /\*\*does the extension collect user data\?\*\*\s*(.*)$/im.exec(body);
  if (asked && !placeholder(asked[1]!.trim())) return true;

  return body.split("\n").some((line) => {
    const cells = cellsOf(line);

    return Boolean(cells && cells[0] && !TABLE_HEADER.test(cells[0]) && cells.slice(1).some(Boolean));
  });
}

function sectionFilled(section: Section): boolean {
  const heading = section.heading.toLowerCase();
  if (PRIVACY_SECTION.test(heading)) return privacyAnswered(section.body);
  if (GRAPHICS_SECTION.test(heading)) return /✅|🟡|\|\s*(?:ready|needs update)\s*\|/i.test(section.body);

  return section.body.split("\n").some((line) => {
    const cells = cellsOf(line);
    if (cells) return Boolean(cells[0]) && !TABLE_HEADER.test(cells[0]!);

    const text = line.trim();

    return Boolean(text) && !HEADING.test(text) && !RULE.test(text) && !TABLE_RULE.test(text) && !/^- \[ \]/.test(text);
  });
}

function takeBold(bold: BoldField, read: Omit<ChromeWebStoreMd, "file">): void {
  const key = bold.key.toLowerCase();
  const value = bold.value.trim();
  const refused = NOT_MAPPED_BOLD.find((entry) => entry.key.test(key));

  if (refused) {
    if (!placeholder(value)) read.notMapped.push(refused.why);

    return;
  }

  const field = BOLD_FIELDS.find((entry) => entry.key.test(key))?.field;
  if (!field || placeholder(value)) return;

  const { listing } = read;

  if (field === "visibility") {
    const visibility = /\//.test(value) ? null : chromeVisibilityOf(value);
    if (!visibility) return;

    listing.visibility = visibility;
  } else if (field === "supportEmail") {
    if (URL.test(value)) {
      read.notMapped.push("Support URL / Email holds a URL; STORE.md's Chrome section takes `- Support email:` only, and the dashboard's Store listing tab takes a support URL");

      return;
    }

    if (!EMAIL.test(value)) return;

    listing.supportEmail = value;
  } else if (field === "categories") {
    listing.categories = [value.replace(/\s*\n\s*/g, " ")];
  } else if (field === "fullDescription") {
    listing.fullDescription = value;
  } else {
    (listing as Record<string, string>)[field] = value.replace(/\s*\n\s*/g, " ");
  }

  read.headings[field] = `**${bold.key}**`;
}

export function parseChromeWebStoreMd(content: string): Omit<ChromeWebStoreMd, "file"> {
  const read: Omit<ChromeWebStoreMd, "file"> = { listing: {}, headings: {}, notMapped: [] };

  for (const section of sections(stripComments(content))) {
    const heading = section.heading.toLowerCase();

    if (PERMISSIONS_SECTION.test(heading)) {
      const rows = tableRows(section.body);

      if (rows.length) {
        read.listing.permissionJustifications = rows;
        read.headings.permissionJustifications = `## ${section.heading}`;
      }

      continue;
    }

    const refused = NOT_MAPPED_SECTIONS.find((entry) => entry.heading.test(heading));

    if (refused) {
      if (sectionFilled(section)) read.notMapped.push(refused.why);

      continue;
    }

    for (const bold of boldFields(section.body)) takeBold(bold, read);
  }

  return read;
}

export function chromeWebStoreMdOf(content: string | null): ChromeWebStoreMd | null {
  if (content === null) return null;

  const parsed = parseChromeWebStoreMd(content);

  return Object.keys(parsed.listing).length ? { file: CHROMEWEBSTORE_MD_FILENAME, ...parsed } : null;
}

export function chromeWebStoreHeld(read: ChromeWebStoreMd | null, store: ListingStore, missing: ListingField[]): ChromeWebStoreHeld[] {
  if (!read) return [];

  const held: ChromeWebStoreHeld[] = [];

  for (const field of missing) {
    if (read.listing[field] === undefined || !STORE_FIELDS[store].includes(field)) continue;

    const home = storeMdSectionOf(field, store);
    const written = storeMdSectionOf(field, "chrome").section;
    if (home.section !== written && !home.alsoRead.includes(written)) continue;

    held.push({ field, line: storeMdLineOf(field), section: written, heading: read.headings[field] ?? read.file });
  }

  return held;
}

export const listOf = (items: string[]): string => (items.length > 1 ? `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}` : (items[0] ?? ""));

export function chromeWebStoreHeldSentence(held: ChromeWebStoreHeld[], storeMdExists: boolean): string {
  const lines = listOf(held.map((row) => `\`${row.line}\``));
  const from = listOf(held.map((row) => row.heading));
  const answer = storeMdExists
    ? `${CHROMEWEBSTORE_MD_PREFILL_ANSWER}.prefilledFrom carries ${held.length === 1 ? "the line" : "the lines"} to add`
    : `${CHROMEWEBSTORE_MD_PREFILL_ANSWER}.storeMd is the STORE.md to save`;
  const lead = storeMdExists
    ? `STORE.md has no ${lines}, and ${CHROMEWEBSTORE_MD_FILENAME} holds ${held.length === 1 ? "it" : "them"} (${from})`
    : `There is no STORE.md, and ${CHROMEWEBSTORE_MD_FILENAME} already holds ${lines} (${from})`;

  return `${lead}; run ${CHROMEWEBSTORE_MD_PREFILL_CALL} and ${answer}, so nothing is retyped.`;
}

export function chromeWebStoreMdCheck(read: ChromeWebStoreMd | null, store: ListingStore, local: LocalListingRead): Row | null {
  if (!read) return null;

  const onFile = local !== null && !("problem" in local) ? local : null;
  const missing = onFile ? linesNotFound(onFile).map((row) => row.field) : STORE_FIELDS[store];
  const held = chromeWebStoreHeld(read, store, missing);
  if (!held.length) return null;

  return {
    id: CHROMEWEBSTORE_MD_CHECK,
    label: `STORE.md carries what ${CHROMEWEBSTORE_MD_FILENAME} already holds`,
    status: "warn",
    severity: "advisory",
    stage: "review",
    expected: `${listOf(held.map((row) => `\`${row.line}\``))} in STORE.md`,
    actual: `${onFile ? "not in STORE.md" : "no STORE.md"}; ${CHROMEWEBSTORE_MD_FILENAME} holds ${held.length === 1 ? "it" : "them"}`,
    message: chromeWebStoreHeldSentence(held, onFile !== null),
    heldBy: held,
    prefill: CHROMEWEBSTORE_MD_PREFILL_CALL,
  };
}
