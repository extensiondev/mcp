// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { LISTING_SECTION, STORE_SECTIONS, type ListingStore } from "./store-md-declarations";

export const STORE_CATEGORY_NAMES: Partial<Record<ListingStore, readonly string[]>> = {
  chrome: [
    "Accessibility",
    "Art & Design",
    "Communication",
    "Developer Tools",
    "Education",
    "Entertainment",
    "Functionality & UI",
    "Games",
    "Household",
    "Just for Fun",
    "News & Weather",
    "Privacy & Security",
    "Shopping",
    "Social Media & Networking",
    "Tools",
    "Travel",
    "Well-being",
    "Workflow & Planning",
  ],
  edge: [
    "Accessibility",
    "Blogging",
    "Communication",
    "Developer Tools",
    "Entertainment",
    "News & Weather",
    "Photos",
    "Productivity",
    "Search Tools",
    "Shopping",
    "Social & Communication",
    "Sports",
  ],
  firefox: [
    "Alerts & Updates",
    "Appearance",
    "Bookmarks",
    "Download Management",
    "Feeds, News & Blogging",
    "Games & Entertainment",
    "Language Support",
    "Photos, Music & Videos",
    "Privacy & Security",
    "Search Tools",
    "Shopping",
    "Social & Communication",
    "Tabs",
    "Web Development",
    "Other",
  ],
};

const CATEGORY_MAP: Partial<Record<ListingStore, Record<string, string>>> = {
  firefox: {
    accessibility: "Other",
    developertools: "Web Development",
    games: "Games & Entertainment",
    entertainment: "Games & Entertainment",
    justforfun: "Games & Entertainment",
    newsandweather: "Feeds, News & Blogging",
    blogging: "Feeds, News & Blogging",
    communication: "Social & Communication",
    socialmediaandnetworking: "Social & Communication",
    photos: "Photos, Music & Videos",
  },
};

export const STORE_LABELS: Record<ListingStore, string> = {
  chrome: "Chrome",
  firefox: "Firefox",
  edge: "Edge",
  safari: "Safari",
};

export type CategoryOrigin = "section" | "note" | "listing" | "mapping";

export interface CategoryMapping {
  from: string;
  to: string;
}

export interface CategoryRead {
  categories: string[];
  from: CategoryOrigin;
  mapped?: CategoryMapping[];
}

export interface CategorySources {
  shared: { categories?: string[] };
  categoriesByStore: Partial<Record<ListingStore, string[]>>;
  categoryOverrides: Partial<Record<ListingStore, string[]>>;
  stores: Partial<Record<ListingStore, { categories?: string[] }>>;
}

export const categoryKey = (name: string): string =>
  name
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z]/g, "");

export function storeHasCategory(store: ListingStore, name: string): boolean {
  const names = STORE_CATEGORY_NAMES[store];

  return !names || names.some((own) => categoryKey(own) === categoryKey(name));
}

export function mapCategory(store: ListingStore, name: string): string | null {
  if (storeHasCategory(store, name)) return null;

  return CATEGORY_MAP[store]?.[categoryKey(name)] ?? null;
}

export function resolveStoreCategories(parsed: CategorySources, store: ListingStore): CategoryRead | null {
  const own = parsed.stores[store]?.categories;
  if (own?.length) return { categories: own, from: "section" };

  const noted = parsed.categoryOverrides[store];
  if (noted?.length) return { categories: noted, from: "note" };

  const listed = [...(parsed.shared.categories ?? []), ...(parsed.categoriesByStore[store] ?? [])];
  if (!listed.length) return null;

  const mapped: CategoryMapping[] = [];
  const categories = listed.map((name) => {
    const to = mapCategory(store, name);
    if (to) mapped.push({ from: name, to });

    return to ?? name;
  });

  return mapped.length ? { categories: [...new Set(categories)], from: "mapping", mapped } : { categories, from: "listing" };
}

export function storesNamingACategory(parsed: CategorySources): ListingStore[] {
  const named = new Set<string>([...Object.keys(parsed.categoriesByStore), ...Object.keys(parsed.categoryOverrides)]);

  for (const [store, text] of Object.entries(parsed.stores)) if (text?.categories?.length) named.add(store);

  return [...named] as ListingStore[];
}

const sectionName = (store: ListingStore): string => STORE_SECTIONS[store].replace(/^## /, "");

const listNames = (names: string[]): string =>
  names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}` : names[0] ?? "";

function origin(store: ListingStore, read: CategoryRead): string {
  if (read.from === "section") return `from the ${sectionName(store)} section`;
  if (read.from === "note") return `from the ${STORE_LABELS[store]} note on the ${LISTING_SECTION.replace(/^## /, "")} line`;
  if (read.from === "mapping") return `mapped from ${listNames(read.mapped!.map((entry) => entry.from))} in ${LISTING_SECTION.replace(/^## /, "")}`;

  return `from ${LISTING_SECTION.replace(/^## /, "")}`;
}

export interface StoreCategoryRow {
  store: ListingStore;
  read: CategoryRead;
}

export function categoriesSentences(rows: StoreCategoryRow[]): string[] {
  const sentences: string[] = [];
  const groups = new Map<string, { stores: ListingStore[]; read: CategoryRead }>();
  const ordered = [...rows].sort((a, b) => Number(a.read.from === "listing") - Number(b.read.from === "listing"));

  for (const { store, read } of ordered) {
    const key = `${read.categories.join("|")}\n${origin(store, read)}`;
    const group = groups.get(key);

    if (group) group.stores.push(store);
    else groups.set(key, { stores: [store], read });
  }

  if (groups.size > 1 || rows.some(({ read }) => read.from !== "listing")) {
    const parts = [...groups.entries()].map(([, group], index) => {
      const first = group.stores[0]!;
      const label = listNames(group.stores.map((store) => STORE_LABELS[store]));
      const noun = index === 0 ? ` ${group.read.categories.length > 1 ? "categories" : "category"}` : "";

      return `${label}${noun}: ${group.read.categories.join(", ")} (${origin(first, group.read)})`;
    });

    sentences.push(`${parts.join("; ")}.`);
  }

  for (const { store, read } of ordered) {
    for (const { from, to } of read.mapped ?? []) {
      sentences.push(
        `${STORE_LABELS[store]} has no ${from} category, so ${to} was sent; add \`- Category:\` under \`${STORE_SECTIONS[store]}\` to choose another.`,
      );
    }
  }

  return sentences;
}

export const PER_STORE_CATEGORY_RULE =
  "A `- Category:` line under a store's own section is that store's category in place of the `## Listing` value, for that store alone, and a trailing parenthetical on it is a remark; where the `## Listing` name is not one of a store's own categories and no such line exists, a built-in map sends the nearest name that store has (Chrome's Accessibility reaches Firefox Add-ons as Other) and the sync answer says so, naming the line to add to choose another.";
