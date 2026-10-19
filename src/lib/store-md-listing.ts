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
} as const;

export type ListingTextField = keyof typeof LISTING_TEXT_LIMITS;

export const LISTING_TEXT_FIELDS = Object.keys(LISTING_TEXT_LIMITS) as ListingTextField[];

export type PermissionJustification = { permission: string; justification: string };

export type ListingText = Partial<Record<ListingTextField, string>> & {
  categories?: string[];
  searchTerms?: string[];
  permissionJustifications?: PermissionJustification[];
};

export interface StoreMdListing {
  shared: ListingText;
  categoriesByStore: Partial<Record<ListingStore, string[]>>;
  stores: Partial<Record<ListingStore, ListingText>>;
}

const STORE_FIELDS: Record<ListingStore, Array<keyof ListingText>> = {
  chrome: ["title", "shortDescription", "fullDescription", "categories", "supportEmail", "privacyPolicyUrl", "homepageUrl", "singlePurpose", "permissionJustifications"],
  firefox: ["title", "shortDescription", "fullDescription", "categories", "supportEmail", "privacyPolicyUrl", "homepageUrl", "license", "reviewerNotes", "releaseNotes"],
  edge: ["title", "shortDescription", "fullDescription", "categories", "searchTerms", "supportEmail", "privacyPolicyUrl", "homepageUrl", "certificationNotes"],
  safari: ["title", "shortDescription", "fullDescription", "categories", "supportEmail", "privacyPolicyUrl", "homepageUrl"],
};

const BULLET_KEYS: Array<[RegExp, ListingTextField | "categories" | "searchTerms"]> = [
  [/^(name|title)$/, "title"],
  [/^(summary|short description)$/, "shortDescription"],
  [/^(description|long description|full description)$/, "fullDescription"],
  [/^categor(y|ies)$/, "categories"],
  [/^support email$/, "supportEmail"],
  [/^(homepage|website|homepage url)$/, "homepageUrl"],
  [/^license$/, "license"],
  [/^(search terms|keywords|tags)$/, "searchTerms"],
];

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
    } else if (/^\S/.test(line)) {
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

function parseCategories(raw: string): { all: string[]; byStore: Partial<Record<ListingStore, string[]>> } {
  const text = unwrap(raw).replace(/\.$/, "");
  const byStore: Partial<Record<ListingStore, string[]>> = {};
  const pairs = [...text.matchAll(/([^,()]+?)\s*\(([^)]*)\)/g)];

  if (pairs.length) {
    for (const [, name, where] of pairs) {
      const category = name!.replace(/^[\s,]*(and\s+)?/i, "").trim();

      for (const store of classifyStore(where!)) byStore[store] = [...(byStore[store] ?? []), category];
    }

    return { all: [], byStore };
  }

  return { all: text.split(",").map((item) => item.trim()).filter(Boolean), byStore };
}

function fieldText(body: string, prefix: string): string {
  for (const sub of splitSections(body, 3)) {
    if (sub.heading.toLowerCase().startsWith(prefix)) return usable(sub.body.replace(/<!--[\s\S]*?-->/g, "").trim());
  }

  return "";
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

export function parseStoreMdListing(content: string): StoreMdListing {
  const result: StoreMdListing = { shared: {}, categoriesByStore: {}, stores: {} };

  for (const section of splitSections(content, 2)) {
    const heading = section.heading.toLowerCase();

    if (heading.startsWith("listing")) {
      for (const { key, value } of bullets(section.body)) {
        const field = BULLET_KEYS.find(([pattern]) => pattern.test(key.toLowerCase()))?.[1];
        const text = usable(value);
        if (!field || !text) continue;

        if (field === "categories") {
          const parsed = parseCategories(text);
          if (parsed.all.length) result.shared.categories = parsed.all;

          result.categoriesByStore = parsed.byStore;
        } else if (field === "searchTerms") {
          result.shared.searchTerms = unwrap(text).split(",").map((item) => item.trim()).filter(Boolean);
        } else {
          result.shared[field] = unwrap(text);
        }
      }
    } else if (heading.startsWith("privacy")) {
      const policy = bullets(section.body).find(({ key }) => /privacy policy/i.test(key));
      const url = policy ? /https?:\/\/[^\s)>"]+/.exec(policy.value)?.[0] : undefined;
      if (url) result.shared.privacyPolicyUrl = url.replace(/[.,;]$/, "");
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

function bounded(field: string, value: unknown, skipped: string[]): unknown {
  if (typeof value === "string") {
    const text = clean(value);
    const limit = (LISTING_TEXT_LIMITS as Record<string, number>)[field];

    if (limit && text.length > limit) {
      skipped.push(`${field} is ${text.length} characters in STORE.md, over the ${limit} the listing takes, so it was left out`);

      return undefined;
    }

    const shapeless =
      (/Url$/.test(field) && !/^https?:\/\/\S+$/i.test(text)) ||
      (field === "supportEmail" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text));

    if (text && shapeless) {
      skipped.push(`${field} in STORE.md is not ${field === "supportEmail" ? "an email address" : "an http or https URL"}, so it was left out`);

      return undefined;
    }

    return text || undefined;
  }

  if (field === "permissionJustifications") {
    const entries = (value as PermissionJustification[])
      .map((entry) => ({ permission: clean(entry.permission), justification: clean(entry.justification) }))
      .filter((entry) => entry.permission && entry.permission.length <= 200 && entry.justification.length <= 1_000);

    if (entries.length < (value as unknown[]).length) skipped.push("a permission justification over 1000 characters was left out");

    return entries.length ? entries.slice(0, 50) : undefined;
  }

  const items = (value as string[]).map(clean).filter((item) => item && item.length <= 100);

  return items.length ? items.slice(0, field === "categories" ? 5 : 16) : undefined;
}

export function listingForStore(parsed: StoreMdListing, store: ListingStore): { listing: ListingText; skipped: string[] } {
  const merged: ListingText = { ...parsed.shared, ...(parsed.stores[store] ?? {}) };
  const categories = parsed.categoriesByStore[store] ?? parsed.shared.categories;
  if (categories?.length) merged.categories = categories;
  else delete merged.categories;

  const listing: ListingText = {};
  const skipped: string[] = [];

  for (const field of STORE_FIELDS[store]) {
    if (merged[field] === undefined) continue;

    const value = bounded(field, merged[field], skipped);
    if (value !== undefined) (listing as Record<string, unknown>)[field] = value;
  }

  return { listing, skipped };
}
