// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

export const LISTING_STORES = ["chrome", "firefox", "edge", "safari"] as const;

export type ListingStore = (typeof LISTING_STORES)[number];

export const LISTING_TEXT_LIMITS = {
  title: 100,
  subtitle: 30,
  shortDescription: 250,
  fullDescription: 16_000,
  supportEmail: 200,
  privacyPolicyUrl: 2_000,
  homepageUrl: 2_000,
  license: 100,
  singlePurpose: 1_000,
  reviewerNotes: 8_000,
  releaseNotes: 8_000,
  certificationNotes: 8_000,
  reviewContactName: 100,
  reviewContactEmail: 200,
  reviewContactPhone: 20,
} as const;

export type ListingTextField = keyof typeof LISTING_TEXT_LIMITS;

export const SEARCH_TERMS_JOINED_LIMITS: Partial<Record<ListingStore, number>> = { safari: 100 };

export const LISTING_TEXT_FIELDS = Object.keys(LISTING_TEXT_LIMITS) as ListingTextField[];

export type PermissionJustification = { permission: string; justification: string };

export type ListingText = Partial<Record<ListingTextField, string>> & {
  categories?: string[];
  searchTerms?: string[];
  permissionJustifications?: PermissionJustification[];
};

export interface StoreMdPrivacy {
  section: string;
  attested: boolean | null;
}

export type ListingField = keyof ListingText;

export interface StoreMdScreenshots {
  line: string;
  files: string[];
}

export interface StoreMdListing {
  shared: ListingText;
  categoriesByStore: Partial<Record<ListingStore, string[]>>;
  stores: Partial<Record<ListingStore, ListingText>>;
  privacy: StoreMdPrivacy;
  lines: Partial<Record<ListingField, string>>;
  screenshots?: StoreMdScreenshots;
}

export interface UnreadLine {
  line: string;
  reason: string;
}

export interface StoreListingRead {
  listing: ListingText;
  skipped: string[];
  unread: Partial<Record<ListingField, UnreadLine>>;
}

const NOTED_FIELDS: ListingField[] = ["license", "supportEmail", "homepageUrl"];

export const STORE_FIELDS: Record<ListingStore, ListingField[]> = {
  chrome: ["title", "shortDescription", "fullDescription", "categories", "supportEmail", "privacyPolicyUrl", "homepageUrl", "singlePurpose", "permissionJustifications"],
  firefox: ["title", "shortDescription", "fullDescription", "categories", "supportEmail", "privacyPolicyUrl", "homepageUrl", "license", "reviewerNotes", "releaseNotes"],
  edge: ["title", "shortDescription", "fullDescription", "categories", "searchTerms", "supportEmail", "privacyPolicyUrl", "homepageUrl", "certificationNotes"],
  safari: ["title", "subtitle", "shortDescription", "fullDescription", "categories", "searchTerms", "supportEmail", "privacyPolicyUrl", "homepageUrl", "reviewerNotes", "reviewContactName", "reviewContactEmail", "reviewContactPhone"],
};

const BULLET_KEYS: Array<[RegExp, ListingTextField | "categories" | "searchTerms"]> = [
  [/^(name|title)$/, "title"],
  [/^subtitle$/, "subtitle"],
  [/^(summary|short description)$/, "shortDescription"],
  [/^(description|long description|full description)$/, "fullDescription"],
  [/^categor(y|ies)$/, "categories"],
  [/^support email$/, "supportEmail"],
  [/^(homepage|website|homepage url)$/, "homepageUrl"],
  [/^license$/, "license"],
  [/^(search terms|keywords|tags)$/, "searchTerms"],
  [/^(app review contact name|review contact name|contact name)$/, "reviewContactName"],
  [/^(app review contact email|review contact email|contact email)$/, "reviewContactEmail"],
  [/^(app review contact phone|review contact phone|contact phone)$/, "reviewContactPhone"],
];

const SCREENSHOTS_KEY = /^screenshots(\s*\([^()]*\))?$/;
const IMAGE_FILE = /\S+\.(png|jpe?g)$/i;
const LIST_MARKER = /^\s*(?:\d+[.)]|[-*+])\s+/;


const E164 = /^\+[1-9]\d{6,14}$/;

const E164_REASON = "is not an E.164 phone number (a plus, the country code and the digits, for example +5511999999999)";

interface Section {
  heading: string;
  body: string;
}

function splitSections(content: string, level: number): Section[] {
  const pattern = new RegExp(`^${"#".repeat(level)} +(.+)$`, "gm");
  const sections: Section[] = [];
  let match = pattern.exec(content);

  while (match) {
    const start = pattern.lastIndex;
    const next = pattern.exec(content);
    sections.push({ heading: match[1]!.trim(), body: content.slice(start, next ? next.index : content.length) });
    match = next;
  }

  return sections;
}

function classifyStore(text: string): ListingStore[] {
  const lower = text.toLowerCase();
  const found: ListingStore[] = [];

  if (/\bchrome\b|chrome-web-store/.test(lower)) found.push("chrome");
  if (/\bfirefox\b|\bamo\b/.test(lower)) found.push("firefox");
  if (/\bedge\b/.test(lower)) found.push("edge");
  if (/\bsafari\b|app store/.test(lower)) found.push("safari");

  return found;
}

function dedent(lines: string[]): string {
  const indents = lines.filter((line) => line.trim()).map((line) => line.match(/^ */)![0].length);
  const cut = indents.length ? Math.min(...indents) : 0;

  return lines.map((line) => line.slice(cut)).join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function bullets(body: string): Array<{ key: string; value: string }> {
  const out: Array<{ key: string; value: string }> = [];
  let current: { key: string; lines: string[] } | null = null;

  const flush = () => {
    if (current) {
      const [first, ...rest] = current.lines;
      out.push({ key: current.key, value: [first, dedent(rest)].filter(Boolean).join("\n") });
    }

    current = null;
  };

  for (const line of body.replace(/<!--[\s\S]*?-->/g, "").split("\n")) {
    const bullet = /^- +([^:\n]{1,80}?):(?:\s+(.*))?$/.exec(line);

    if (bullet) {
      flush();
      current = { key: bullet[1]!.trim(), lines: [(bullet[2] ?? "").trim()] };
    } else if (/^\S/.test(line) && !(current && /^\d+[.)]\s/.test(line))) {
      flush();
    } else if (current) {
      current.lines.push(line);
    }
  }

  flush();

  return out;
}

const usable = (value: string): string => {
  const text = value.trim();

  return !text || /^todo\b/i.test(text) ? "" : text;
};

const unwrap = (value: string): string =>
  value
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.replace(/\s*\n\s*/g, " ").trim())
    .filter(Boolean)
    .join("\n\n");

const TRAILING_NOTE = /^(.*?)\s*\(([^()]*)\)$/;

const withoutNote = (value: string): string => {
  const noted = TRAILING_NOTE.exec(value);

  return noted && noted[1]!.trim() ? noted[1]!.trim() : value;
};

function splitOutsideNotes(text: string): string[] {
  const items: string[] = [];
  let depth = 0;
  let current = "";

  for (const char of text) {
    if (char === "(") depth += 1;
    if (char === ")") depth = Math.max(0, depth - 1);

    if (char === "," && depth === 0) {
      items.push(current);
      current = "";
    } else current += char;
  }

  items.push(current);

  return items.map((item) => item.replace(/^\s*(and\s+)?/i, "").trim()).filter(Boolean);
}

/* @invariant A STORE NOTE ON ONE CATEGORY IS A REMARK. A single category
 * applies to every store whatever its parenthetical says, since the
 * template's wording invites a note like "(Chrome Web Store)" beside the
 * one category the author chose. Only a line that lists several categories
 * reads a parenthetical naming stores as the stores that category is for;
 * a category without a store note on such a line applies to every store,
 * and a store that none of the notes name is answered with the line shape
 * the reader takes, never guessed.
 */
function parseCategories(raw: string): { all: string[]; byStore: Partial<Record<ListingStore, string[]>> } {
  const items = splitOutsideNotes(unwrap(raw).replace(/\.$/, "")).map((item) => {
    const noted = TRAILING_NOTE.exec(item);

    return noted ? { name: noted[1]!.trim(), stores: classifyStore(noted[2]!) } : { name: item, stores: [] as ListingStore[] };
  });
  const all: string[] = [];
  const byStore: Partial<Record<ListingStore, string[]>> = {};

  for (const { name, stores } of items) {
    if (!name) continue;

    if (items.length === 1 || !stores.length) {
      all.push(name);
      continue;
    }

    for (const store of stores) byStore[store] = [...(byStore[store] ?? []), name];
  }

  return { all, byStore };
}

function fieldText(body: string, prefix: string): string {
  for (const sub of splitSections(body, 3)) {
    if (sub.heading.toLowerCase().startsWith(prefix)) return usable(sub.body.replace(/<!--[\s\S]*?-->/g, "").trim());
  }

  return "";
}

const POLICY_ROW = /^- +privacy policy( url| attested)?:/i;

function privacyProse(body: string): string {
  const kept: string[] = [];
  let skipping = false;

  for (const line of body.replace(/<!--[\s\S]*?-->/g, "").split("\n")) {
    if (POLICY_ROW.test(line)) {
      skipping = true;
      continue;
    }

    if (skipping && /^\s+\S/.test(line)) continue;

    skipping = false;
    kept.push(line);
  }

  return usable(kept.join("\n").trim());
}

function justifications(body: string): PermissionJustification[] {
  for (const sub of splitSections(body, 3)) {
    if (!sub.heading.toLowerCase().startsWith("permission")) continue;

    return bullets(sub.body)
      .map(({ key, value }) => ({ permission: key, justification: usable(unwrap(value)) }))
      .filter((entry) => entry.permission && entry.justification);
  }

  return [];
}

/* @invariant THE SCREENSHOTS LINE IS READ IN THE TWO FORMS AUTHORS WRITE. The
 * template's bare "- Screenshots:" and the walk's "- Screenshots (1280x800,
 * in this order):" both name the files below them, one per line, as a
 * numbered or dashed list or bare paths, and a short inline list on the line
 * itself is read too. A token is a file only when it ends in .png, .jpg or
 * .jpeg, so a prose line ("TODO at least one screenshot") yields no files and
 * the line is reported as written, with the shape the reader takes, instead
 * of a silent miss.
 */
function screenshotFiles(value: string): string[] {
  const files: string[] = [];

  for (const raw of value.split("\n")) {
    const line = raw.replace(LIST_MARKER, "").replace(/`/g, "").trim();
    if (!line) continue;

    for (const token of line.split(/[,\s]+/)) {
      const file = token.replace(/[.,;]$/, "");
      if (IMAGE_FILE.test(file)) files.push(file);
    }
  }

  return files;
}

function readBullets(result: StoreMdListing, body: string, into: ListingText, ownSection: boolean): void {
  for (const { key, value } of bullets(body)) {
    if (!ownSection && SCREENSHOTS_KEY.test(key.toLowerCase())) {
      const text = usable(value);
      if (text) result.screenshots = { line: key, files: screenshotFiles(text) };

      continue;
    }

    const field = BULLET_KEYS.find(([pattern]) => pattern.test(key.toLowerCase()))?.[1];
    const text = usable(value);
    if (!field || !text || (ownSection && field === "categories")) continue;

    result.lines[field] = key;

    if (field === "categories") {
      const parsed = parseCategories(text);
      if (parsed.all.length) into.categories = parsed.all;

      result.categoriesByStore = parsed.byStore;
    } else if (field === "searchTerms") {
      into.searchTerms = unwrap(text).split(",").map((item) => item.trim()).filter(Boolean);
    } else if (NOTED_FIELDS.includes(field)) {
      into[field] = withoutNote(unwrap(text));
    } else {
      into[field] = unwrap(text);
    }
  }
}

/* @invariant A STORE SECTION'S OWN LINES OVERRIDE THE SHARED LISTING. The
 * lines above a store section's first "###" subsection are read with the
 * same keys as "## Listing" and win for that store alone, so the App Store's
 * subtitle, keywords and review contact phone can sit under "## Safari" as
 * the owed message asks, while "- Category:" keeps its per-store note syntax
 * on the shared line.
 */
export function parseStoreMdListing(content: string): StoreMdListing {
  const result: StoreMdListing = { shared: {}, categoriesByStore: {}, stores: {}, privacy: { section: "", attested: null }, lines: {} };

  for (const section of splitSections(content, 2)) {
    const heading = section.heading.toLowerCase();

    if (heading.startsWith("listing")) {
      readBullets(result, section.body, result.shared, false);
    } else if (heading.startsWith("privacy")) {
      const rows = bullets(section.body);
      const policy = rows.find(({ key }) => /privacy policy/i.test(key) && !/attested/i.test(key));
      const attested = rows.find(({ key }) => /^privacy policy attested$/i.test(key));
      const url = policy ? /https?:\/\/[^\s)>"]+/.exec(policy.value)?.[0] : undefined;
      if (url) result.shared.privacyPolicyUrl = url.replace(/[.,;]$/, "");

      result.privacy = { section: privacyProse(section.body), attested: attested ? /^yes\b/i.test(attested.value.trim()) : null };
    } else {
      const [store] = classifyStore(section.heading);
      if (!store || result.stores[store]) continue;

      const text: ListingText = {};
      const singlePurpose = fieldText(section.body, "single purpose");
      const reviewerNotes = fieldText(section.body, "reviewer notes");
      const releaseNotes = fieldText(section.body, "release notes");
      const certificationNotes = fieldText(section.body, "certification notes");
      const permissions = justifications(section.body);

      if (singlePurpose) text.singlePurpose = singlePurpose;
      if (reviewerNotes) text.reviewerNotes = reviewerNotes;
      if (releaseNotes) text.releaseNotes = releaseNotes;
      if (certificationNotes) text.certificationNotes = certificationNotes;
      if (permissions.length) text.permissionJustifications = permissions;

      readBullets(result, section.body.split(/^###\s/m)[0]!, text, true);
      result.stores[store] = text;
    }
  }

  return result;
}

const kept = (char: string): boolean => {
  const code = char.charCodeAt(0);

  return code === 9 || code === 10 || code === 13 || (code >= 32 && code !== 127);
};

const clean = (value: string): string => Array.from(value).filter(kept).join("").trim();

type Bounded = { value: unknown } | { reason: string };

function bounded(field: string, value: unknown, skipped: string[], store: ListingStore): Bounded {
  if (typeof value === "string") {
    const text = clean(value);
    const limit = (LISTING_TEXT_LIMITS as Record<string, number>)[field];

    if (limit && text.length > limit) {
      return { reason: `is ${text.length} characters, over the ${limit} the listing takes` };
    }

    const emailField = field === "supportEmail" || field === "reviewContactEmail";
    const shapeless =
      (/Url$/.test(field) && !/^https?:\/\/\S+$/i.test(text)) ||
      (emailField && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text));

    if (text && shapeless) {
      return { reason: `is not ${emailField ? "an email address" : "an http or https URL"}` };
    }

    if (field === "reviewContactPhone" && text) {
      const digits = text.replace(/[\s().-]/g, "");

      return E164.test(digits) ? { value: digits } : { reason: E164_REASON };
    }

    return { value: text || undefined };
  }

  if (field === "permissionJustifications") {
    const entries = (value as PermissionJustification[])
      .map((entry) => ({ permission: clean(entry.permission), justification: clean(entry.justification) }))
      .filter((entry) => entry.permission && entry.permission.length <= 200 && entry.justification.length <= 1_000);

    if (entries.length < (value as unknown[]).length) skipped.push("a permission justification over 1000 characters was left out");

    return { value: entries.length ? entries.slice(0, 50) : undefined };
  }

  const items = (value as string[]).map(clean).filter((item) => item && item.length <= 100);
  const joinedLimit = field === "searchTerms" ? SEARCH_TERMS_JOINED_LIMITS[store] : undefined;
  const joined = items.join(",").length;

  if (joinedLimit && joined > joinedLimit) {
    return { reason: `is ${joined} characters joined by commas, over the ${joinedLimit} the App Store keywords take` };
  }

  return { value: items.length ? items.slice(0, field === "categories" ? 5 : 16) : undefined };
}

export interface DerivedListingField {
  field: "subtitle";
  from: "shortDescription";
  line: string;
  value: string;
}

/* @invariant THIS SERVER COPIES STORE.md; IT NEVER WRITES A LISTING LINE.
 * Every field the sync sends is the owner's own text from a STORE.md line,
 * bounded and cleaned, never composed. The one value a store receives
 * without a line is derived downstream, by the platform's Safari push: the
 * App Store subtitle, copied from the Summary when STORE.md has no
 * `- Subtitle:` line and the Summary is 30 characters or fewer. This names
 * that value from the same two facts before the sync is sent, so the answer
 * can say which value the owner did not write and why the platform asked an
 * owner to approve it (the listing-derived row of the approval table), and
 * the owner learns the line to add. Nothing here puts the value into the
 * patch: the listing the platform stores holds only what STORE.md says.
 */
export function derivedListingFields(store: ListingStore, listing: ListingText): DerivedListingField[] {
  if (store !== "safari" || listing.subtitle) return [];

  const summary = listing.shortDescription ?? "";

  return summary && summary.length <= LISTING_TEXT_LIMITS.subtitle
    ? [{ field: "subtitle", from: "shortDescription", line: "Summary", value: summary }]
    : [];
}

const storeList = (stores: string[]): string =>
  stores.length > 1 ? `${stores.slice(0, -1).join(", ")} and ${stores[stores.length - 1]}` : stores[0] ?? "";

export function listingForStore(parsed: StoreMdListing, store: ListingStore): StoreListingRead {
  const merged: ListingText = { ...parsed.shared, ...(parsed.stores[store] ?? {}) };
  const categories = [...(parsed.shared.categories ?? []), ...(parsed.categoriesByStore[store] ?? [])];
  if (categories.length) merged.categories = categories;
  else delete merged.categories;

  const listing: ListingText = {};
  const skipped: string[] = [];
  const unread: Partial<Record<ListingField, UnreadLine>> = {};

  for (const field of STORE_FIELDS[store]) {
    if (merged[field] === undefined) continue;

    const read = bounded(field, merged[field], skipped, store);

    if ("reason" in read) {
      skipped.push(`${field} in STORE.md ${read.reason}, so it was left out`);
      unread[field] = { line: `- ${parsed.lines[field] ?? field}:`, reason: read.reason };
    } else if (read.value !== undefined) {
      (listing as Record<string, unknown>)[field] = read.value;
    }
  }

  if (listing.categories === undefined && parsed.lines.categories) {
    const named = Object.keys(parsed.categoriesByStore);

    unread.categories = {
      line: `- ${parsed.lines.categories}:`,
      reason: named.length ? `names ${storeList(named)} only` : "carries no category the reader takes",
    };
  }

  return { listing, skipped, unread };
}
