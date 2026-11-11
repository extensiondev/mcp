// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import fs from "node:fs";
import path from "node:path";

import { listOf, readChromeWebStoreMd, type ChromeWebStoreMd } from "./chromewebstore-md";
import { localizedMessage, messageKeyOf } from "./publish-localized-name";
import { NEVER_PREFILLED } from "./store-bring-list";
import { accessFacts, codeFactsOf, dataCollectionFacts, networkFacts, remoteCodeFacts, type CodeFacts } from "./store-code-facts";
import { STORE_MD_FILENAME } from "./store-md";
import { storeMdFieldRows, storeMdLineOf, storeMdSectionOf } from "./store-md-fields";
import {
  LISTING_SECTION,
  LISTING_STORES,
  LISTING_TEXT_LIMITS,
  PRIVACY_SECTION,
  STORE_FIELDS,
  STORE_SECTIONS,
  listingForStore,
  parseStoreMdListing,
  type ListingField,
  type ListingStore,
  type ListingText,
  type ListingTextField,
  type StoreMdListing,
} from "./store-md-listing";
import { storeGalleryOf, type GalleryStore } from "./store-gallery";

type Row = Record<string, unknown>;

export interface DraftLine {
  field: ListingField;
  line: string;
  section: string;
  stores: ListingStore[];
  value: string;
  from: string;
}

export interface AgentLine {
  field: ListingField;
  line: string;
  section: string;
  stores: ListingStore[];
  limit: string;
  facts: string[];
}

export interface OwnerAnswer {
  id: string;
  asks: string;
  codeFacts: string[];
}

export interface PrefilledFrom {
  file: string;
  fields: ListingField[];
  lines: DraftLine[];
  stillEmpty: ListingField[];
  notMapped: string[];
  say: string;
}

export interface ListingDraft {
  file: string;
  exists: boolean;
  storeMd?: string;
  fromCode: DraftLine[];
  prefilledFrom?: PrefilledFrom;
  agentWrites: AgentLine[];
  ownerAnswers: OwnerAnswer[];
  gallery: GalleryStore[];
  say: string;
}

const AGENT_FIELDS: ListingField[] = [
  "fullDescription",
  "appStoreName",
  "subtitle",
  "searchTerms",
  "singlePurpose",
  "permissionJustifications",
  "reviewerNotes",
  "certificationNotes",
  "releaseNotes",
];

const OWNER_ASKS: Record<string, string> = {
  "chrome.data_usage": "the Chrome Web Store Privacy tab: what user data the extension handles, and the certifications",
  "chrome.remote_code": "the Chrome Web Store Privacy tab: whether the extension runs remote code",
  "edge.privacy_policy_requirements": "the Partner Center Privacy page: whether the extension needs a privacy policy",
  "edge.data_usage": "the Partner Center Privacy page: what user data the extension handles",
  "edge.remote_code": "the Partner Center Privacy page: whether the extension runs remote code",
  "firefox.data_collection_permissions": "the Firefox data collection declaration, browser_specific_settings.gecko.data_collection_permissions in the manifest",
  "safari.app_privacy": "the App Privacy answers in App Store Connect",
  "safari.age_rating": "the App Store age rating questionnaire",
  "safari.content_rights": "the App Store content rights declaration",
};

const NOT_IN_CODE = "Nothing in the code answers this; it is about the content and the rights you hold.";

function readText(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

function readJson(file: string): Row | null {
  const raw = readText(file);
  if (raw === null) return null;

  try {
    const parsed: unknown = JSON.parse(raw.replace(/^\uFEFF/, ""));

    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Row) : null;
  } catch {
    return null;
  }
}

const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

function manifestText(projectPath: string, key: "name" | "description"): { value: string; from: string } | null {
  for (const dir of [path.join(projectPath, "src"), projectPath]) {
    const manifest = readJson(path.join(dir, "manifest.json"));
    if (!manifest) continue;

    const where = path.relative(projectPath, path.join(dir, "manifest.json")).split(path.sep).join("/");
    const raw = text(manifest[key]);
    const message = messageKeyOf(raw);

    if (raw && !message) return { value: raw, from: `${where} ${key}` };
    if (!message) return null;

    const locale = text(manifest.default_locale);
    const file = `_locales/${locale}/messages.json`;
    const localized = locale ? localizedMessage(readJson(path.join(dir, file)), message) : null;

    return localized ? { value: localized, from: `${path.relative(projectPath, path.join(dir, file)).split(path.sep).join("/")} ${message}` } : null;
  }

  return null;
}

function onFile(parsed: StoreMdListing | null, store: ListingStore, field: ListingField): boolean {
  if (!parsed) return false;

  const read = listingForStore(parsed, store);

  return read.listing[field] !== undefined || read.unread[field] !== undefined;
}

function limitOf(field: ListingField, store: ListingStore): string {
  return storeMdFieldRows(store).find((row) => row.field === field)?.limit ?? "";
}

function factsFor(field: ListingField, facts: CodeFacts, projectPath: string): string[] {
  const surfaces = facts.surfaces.length ? [`The manifest declares ${facts.surfaces.join(", ")}.`] : [];
  const summary = manifestText(projectPath, "description");
  const said = summary ? [`The manifest description reads "${/[.!?]$/.test(summary.value) ? summary.value : `${summary.value}.`}"`] : [];
  const matches = facts.contentScriptMatches.length ? [`Content scripts run on: ${facts.contentScriptMatches.join(", ")}.`] : [];

  if (field === "permissionJustifications") {
    const asked = [...facts.permissions, ...facts.hostPermissions];

    return asked.length
      ? [`Write one bullet per entry, keyed as the manifest spells it: ${asked.join(", ")}.`, ...matches]
      : ["The manifest asks for no permissions and no host permissions, so the section needs no bullet."];
  }

  if (field === "releaseNotes") {
    const pkg = readJson(path.join(projectPath, "package.json"));
    const changelog = ["CHANGELOG.md", "changelog.md"].find((name) => fs.existsSync(path.join(projectPath, name)));

    return [
      ...(text(pkg?.version) ? [`package.json reads version ${text(pkg?.version)}.`] : []),
      changelog ? `${changelog} is in the repository.` : "The repository has no CHANGELOG.md.",
    ];
  }

  if (field === "appStoreName") return [`The manifest name is over the App Store's ${LISTING_TEXT_LIMITS.appStoreName} characters, so the App Store needs a shorter name.`];
  if (field === "reviewerNotes" || field === "certificationNotes") return [...surfaces, ...matches];

  return [...said, ...surfaces];
}

function ownerAnswerOf(id: string, facts: CodeFacts): OwnerAnswer {
  const codeFacts = id.endsWith(".remote_code")
    ? remoteCodeFacts(facts)
    : id === "firefox.data_collection_permissions"
      ? [...dataCollectionFacts(facts), ...networkFacts(facts)]
      : id === "safari.age_rating" || id === "safari.content_rights"
        ? [NOT_IN_CODE]
        : [...accessFacts(facts), ...networkFacts(facts)];

  return { id, asks: OWNER_ASKS[id] ?? id, codeFacts };
}

function groupedBySection(field: ListingField, stores: ListingStore[]): Array<{ section: string; stores: ListingStore[] }> {
  const groups = new Map<string, ListingStore[]>();

  for (const store of stores) {
    const home = storeMdSectionOf(field, store);
    const section = [...groups.keys()].find((existing) => home.alsoRead.includes(existing)) ?? home.section;
    groups.set(section, [...(groups.get(section) ?? []), store]);
  }

  return [...groups].map(([section, members]) => ({ section, stores: members }));
}

const DRAFT_SECTIONS = [LISTING_SECTION, PRIVACY_SECTION, ...LISTING_STORES.map((store) => STORE_SECTIONS[store])];

function lineText(line: DraftLine): string[] {
  if (line.line.startsWith("### ")) return [line.line, "", line.value, ""];
  if (line.value.includes("\n")) return [line.line, "", ...line.value.split("\n").map((row) => (row ? `  ${row}` : "")), ""];

  return [`${line.line} ${line.value}`];
}

function draftText(name: string, lines: DraftLine[]): string {
  const out = [`# ${name || "Store listing"}`];

  for (const section of DRAFT_SECTIONS) {
    const rows = lines.filter((line) => line.section === section);
    if (!rows.length) continue;

    const bullets = rows.filter((line) => !line.line.startsWith("### "));
    const subsections = rows.filter((line) => line.line.startsWith("### "));

    out.push("", section, "", ...bullets.flatMap(lineText));
    for (const row of subsections) out.push("", ...lineText(row));
  }

  return `${out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
}

function valueText(field: ListingField, listing: ListingText): string {
  if (field === "permissionJustifications") return (listing.permissionJustifications ?? []).map((entry) => `- ${entry.permission}: ${entry.justification}`).join("\n");
  if (field === "categories") return (listing.categories ?? []).join(", ");

  return listing[field as ListingTextField] ?? "";
}

function prefilledLines(read: ChromeWebStoreMd, missing: (field: ListingField) => ListingStore[], drafted: DraftLine[]): DraftLine[] {
  const lines: DraftLine[] = [];

  for (const field of STORE_FIELDS.chrome) {
    if (read.listing[field] === undefined || drafted.some((line) => line.field === field)) continue;

    const stores = missing(field);
    if (!stores.length) continue;

    lines.push({ field, line: storeMdLineOf(field), section: storeMdSectionOf(field, "chrome").section, stores, value: valueText(field, read.listing), from: `${read.file} ${read.headings[field] ?? ""}`.trim() });
  }

  return lines;
}

function prefilledFromOf(read: ChromeWebStoreMd, lines: DraftLine[], stillEmpty: ListingField[]): PrefilledFrom {
  const filled = lines.length ? `${read.file} filled ${listOf(lines.map((line) => `\`${line.line}\``))}` : `${read.file} holds no line STORE.md lacks`;
  const empty = stillEmpty.length ? `; still empty for Chrome: ${listOf(stillEmpty.map((field) => `\`${storeMdLineOf(field)}\``))}` : "; every line STORE.md takes for Chrome is filled";
  const refused = read.notMapped.length ? ` Not taken from it: ${read.notMapped.join("; ")}.` : "";

  return { file: read.file, fields: lines.map((line) => line.field), lines, stillEmpty, notMapped: read.notMapped, say: `${filled}${empty}.${refused}` };
}

function addsSentence(lines: DraftLine[]): string {
  const sections = [...new Set(lines.map((line) => line.section))];

  return listOf(sections.map((section) => `${listOf(lines.filter((line) => line.section === section).map((line) => `"${line.line}"`))} under "${section}"`));
}

/* @invariant THE DRAFT WRITES ONLY WHAT THE CODE STATES, AND NO DATA-USE OR
 * PRIVACY ANSWER, EVER. Cezar ruled on 2026-11-01 (option A) that every
 * data-use and privacy declaration is the owner's: the Chrome data usage and
 * remote code answers, the Edge privacy page, the Firefox data collection
 * declaration, App Privacy, the age rating and content rights. So the drafted
 * STORE.md carries the manifest's own name and summary and nothing else; the
 * prose fields go to agentWrites with the code facts to write them from, the
 * six decisions keep their own answer, a field two stores read from one
 * section is asked once there, and every declaration in
 * NEVER_PREFILLED goes to ownerAnswers with code facts alone: what the
 * manifest asks for, what the source calls, never a proposed answer. A line
 * STORE.md already carries is never drafted again. A line the owner already
 * wrote in Google's CHROMEWEBSTORE.md is the owner's own words, not a
 * proposal: the listing copy, category, single purpose, permission reasons,
 * privacy policy URL and visibility it holds are prefilled under their
 * STORE.md lines and named in prefilledFrom, while its Privacy & Data Use
 * answers stay the owner's to give on the dashboard (ledger 512).
 */
export function listingDraftOf(args: { projectPath: string; asked: readonly string[]; statusById: Record<string, string> }): ListingDraft | null {
  const projectPath = args.projectPath.trim();
  if (!projectPath || !fs.existsSync(projectPath)) return null;

  const stores = LISTING_STORES.filter((store) => args.asked.includes(store));
  if (!stores.length) return null;

  const raw = readText(path.join(projectPath, STORE_MD_FILENAME));
  const parsed = raw === null ? null : parseStoreMdListing(raw);
  const facts = codeFactsOf(projectPath);
  const name = manifestText(projectPath, "name");
  const summary = manifestText(projectPath, "description");
  const missing = (field: ListingField): ListingStore[] => stores.filter((store) => STORE_FIELDS[store].includes(field) && !onFile(parsed, store, field));

  const fromCode: DraftLine[] = [];

  if (name && name.value.length <= LISTING_TEXT_LIMITS.title && missing("title").length) {
    fromCode.push({ field: "title", line: storeMdLineOf("title"), section: LISTING_SECTION, stores: missing("title"), value: name.value, from: name.from });
  }

  if (summary && summary.value.length <= LISTING_TEXT_LIMITS.shortDescription && missing("shortDescription").length) {
    fromCode.push({ field: "shortDescription", line: storeMdLineOf("shortDescription"), section: LISTING_SECTION, stores: missing("shortDescription"), value: summary.value, from: summary.from });
  }

  const chromeMd = readChromeWebStoreMd(projectPath);
  const prefilled = chromeMd ? prefilledLines(chromeMd, missing, fromCode) : [];
  const open = (field: ListingField): ListingStore[] => (prefilled.some((line) => line.field === field) ? [] : missing(field));
  const stillEmpty = STORE_FIELDS.chrome.filter((field) => missing(field).includes("chrome") && ![...fromCode, ...prefilled].some((line) => line.field === field));
  const longName = Boolean(name && name.value.length > LISTING_TEXT_LIMITS.appStoreName);
  const agentWrites: AgentLine[] = AGENT_FIELDS.flatMap((field) => {
    if (field === "appStoreName" && !longName) return [];

    return groupedBySection(field, open(field)).map((group) => ({
      field,
      line: storeMdLineOf(field),
      section: group.section,
      stores: group.stores,
      limit: limitOf(field, group.stores[0]!),
      facts: factsFor(field, facts, projectPath),
    }));
  });

  const ownerAnswers = [...NEVER_PREFILLED]
    .filter((id) => stores.includes(id.split(".")[0] as ListingStore) && id in args.statusById && args.statusById[id] !== "have")
    .map((id) => ownerAnswerOf(id, facts));

  const gallery = storeGalleryOf(projectPath, stores, parsed?.screenshotPaths);
  const adds = [...fromCode, ...prefilled];
  const sources = listOf([...(fromCode.length ? ["the manifest"] : []), ...(prefilled.length ? [chromeMd!.file] : [])]);
  const written = adds.length ? `${raw === null ? "storeMd is a STORE.md to save as it is" : `add ${addsSentence(adds)}`}, read from ${sources}; ` : "";
  const say = `${written}${agentWrites.length ? `write ${agentWrites.length} ${agentWrites.length === 1 ? "line" : "lines"} in agentWrites from the facts beside each, inside its limit; ` : ""}the decisions write their own lines once answered${ownerAnswers.length ? `; ${ownerAnswers.length} data-use and privacy ${ownerAnswers.length === 1 ? "answer is" : "answers are"} the owner's alone (ownerAnswers): quote the code facts, propose no answer` : ""}. Then show the person the whole file for review; nothing is sent until sync-listing.`;

  return {
    file: STORE_MD_FILENAME,
    exists: raw !== null,
    ...(raw === null && adds.length ? { storeMd: draftText(name?.value ?? "", adds) } : {}),
    fromCode,
    ...(chromeMd ? { prefilledFrom: prefilledFromOf(chromeMd, prefilled, stillEmpty) } : {}),
    agentWrites,
    ownerAnswers,
    gallery,
    say: say.charAt(0).toUpperCase() + say.slice(1),
  };
}
