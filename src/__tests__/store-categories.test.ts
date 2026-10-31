import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import { renderStoreMdFieldsDoc } from "../lib/docs-store-md-fields";
import {
  STORE_CATEGORY_NAMES,
  categoriesSentences,
  mapCategory,
  resolveStoreCategories,
  storeHasCategory,
} from "../lib/store-categories";
import { storeMdSectionOf } from "../lib/store-md-fields";
import { listingForStore, parseStoreMdListing } from "../lib/store-md-listing";
import { readLocalListing } from "../tools/store-listing";
import { handler as submit } from "../tools/submit";
import { API, PROJECT_ROUTE, useProjectRoutes } from "./fixtures/project-routes";

const LISTING = (store: string) => `${PROJECT_ROUTE}/stores/${store}/listing`;
const PREFLIGHT = (store: string) => `${PROJECT_ROUTE}/stores/${store}/submissions/preflight`;

const HEAD = `# Store metadata

## Listing

- Name: Hands-free
- Summary: Read the page aloud and scroll it by voice.
- Description:

  Reads any page aloud and scrolls it by voice.

- Category: Accessibility
`;

const FIREFOX_OTHER = `${HEAD}
## Firefox Add-ons

- Category: Other

### Reviewer notes

Say "next" to scroll.
`;

const FIREFOX_NOTED = `${HEAD}
## Firefox Add-ons

### Reviewer notes

Say "next" to scroll.

### Listing

- Category: Other (AMO has no Accessibility category)
`;

const AMO_EXTENSION_CATEGORIES_2026_10_26 = [
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
];

describe("a per-store `- Category:` line overrides the Listing value for that store alone", () => {
  it("reads `- Category: Other` under `## Firefox Add-ons` for firefox and keeps Accessibility for chrome and edge", () => {
    const parsed = parseStoreMdListing(FIREFOX_OTHER);

    expect(listingForStore(parsed, "firefox").listing.categories).toEqual(["Other"]);
    expect(listingForStore(parsed, "firefox").categories).toEqual({ categories: ["Other"], from: "section" });
    expect(listingForStore(parsed, "chrome").listing.categories).toEqual(["Accessibility"]);
    expect(listingForStore(parsed, "chrome").categories).toEqual({ categories: ["Accessibility"], from: "listing" });
    expect(listingForStore(parsed, "edge").listing.categories).toEqual(["Accessibility"]);
    expect(listingForStore(parsed, "edge").categories).toEqual({ categories: ["Accessibility"], from: "listing" });
  });

  it("reads the line under a sub-heading of the store section and keeps a trailing parenthetical out of the value", () => {
    const parsed = parseStoreMdListing(FIREFOX_NOTED);

    expect(listingForStore(parsed, "firefox").listing.categories).toEqual(["Other"]);
    expect(listingForStore(parsed, "firefox").categories?.from).toBe("section");
    expect(listingForStore(parsed, "firefox").listing.reviewerNotes).toBe('Say "next" to scroll.');
  });

  it("wins over a Firefox note on the Listing line and over the built-in map", () => {
    const parsed = parseStoreMdListing(`${FIREFOX_OTHER.replace("- Category: Accessibility", "- Category: Accessibility (Firefox: Tabs)")}`);

    expect(listingForStore(parsed, "firefox").listing.categories).toEqual(["Other"]);
    expect(listingForStore(parsed, "firefox").categories?.from).toBe("section");
  });

  it("names the stores whose own section carries a category when another store is left without one", () => {
    const parsed = parseStoreMdListing(
      `${HEAD.replace("- Category: Accessibility", "- Category: Accessibility (Chrome Web Store), Tools (Edge)")}\n## Firefox Add-ons\n\n- Category: Other\n`,
    );

    expect(listingForStore(parsed, "firefox").listing.categories).toEqual(["Other"]);
    expect(listingForStore(parsed, "safari").listing.categories).toBeUndefined();
    expect(listingForStore(parsed, "safari").unread.categories).toEqual({ line: "- Category:", reason: "names chrome, edge and firefox only" });
  });

  it("puts the store section in the field reference's also-read column for the Category line", () => {
    expect(storeMdSectionOf("categories", "firefox")).toEqual({ section: "## Listing", alsoRead: ["## Firefox Add-ons"] });
    expect(renderStoreMdFieldsDoc()).toContain("A `- Category:` line under a store's own section is that store's category in place of the `## Listing` value");
    expect(renderStoreMdFieldsDoc()).toContain("Chrome's Accessibility reaches Firefox Add-ons as Other");
  });
});

describe("the built-in category map fills the gap between the stores' vocabularies", () => {
  it("pins AMO's extension categories as www pins them from /api/v5/addons/categories/ (2026-10-26)", () => {
    expect(STORE_CATEGORY_NAMES.firefox).toEqual(AMO_EXTENSION_CATEGORIES_2026_10_26);
    expect(STORE_CATEGORY_NAMES.firefox).not.toContain("Accessibility");
    expect(STORE_CATEGORY_NAMES.chrome).toContain("Accessibility");
    expect(STORE_CATEGORY_NAMES.edge).toContain("Accessibility");
  });

  it("maps Chrome's Accessibility to AMO's Other and leaves a name AMO has, or one it cannot place, alone", () => {
    expect(mapCategory("firefox", "Accessibility")).toBe("Other");
    expect(mapCategory("firefox", "Privacy & Security")).toBeNull();
    expect(mapCategory("firefox", "Privacy and security")).toBeNull();
    expect(storeHasCategory("firefox", "privacy & SECURITY")).toBe(true);
    expect(mapCategory("firefox", "Productivity")).toBeNull();
    expect(mapCategory("chrome", "Accessibility")).toBeNull();
    expect(mapCategory("edge", "Accessibility")).toBeNull();
    expect(mapCategory("safari", "Utilities")).toBeNull();
  });

  it("applies the map only when no per-store line exists and marks the read as mapped", () => {
    const parsed = parseStoreMdListing(HEAD);

    expect(listingForStore(parsed, "firefox").listing.categories).toEqual(["Other"]);
    expect(listingForStore(parsed, "firefox").categories).toEqual({
      categories: ["Other"],
      from: "mapping",
      mapped: [{ from: "Accessibility", to: "Other" }],
    });

    expect(listingForStore(parsed, "chrome").listing.categories).toEqual(["Accessibility"]);
    expect(listingForStore(parsed, "chrome").categories?.from).toBe("listing");

    const kept = parseStoreMdListing(HEAD.replace("- Category: Accessibility", "- Category: Productivity"));
    expect(listingForStore(kept, "firefox").listing.categories).toEqual(["Productivity"]);
    expect(listingForStore(kept, "firefox").categories?.from).toBe("listing");
  });

  it("resolves a Listing note for a store before the map and never maps it", () => {
    const read = resolveStoreCategories(
      { shared: { categories: ["Accessibility"] }, categoriesByStore: {}, categoryOverrides: { firefox: ["Accessibility"] }, stores: {} },
      "firefox",
    );

    expect(read).toEqual({ categories: ["Accessibility"], from: "note" });
  });

  it("prints the mapping and names the line to add, and says which value each store got when they differ", () => {
    const firefox = { categories: ["Other"], from: "mapping" as const, mapped: [{ from: "Accessibility", to: "Other" }] };
    const chrome = { categories: ["Accessibility"], from: "listing" as const };

    expect(categoriesSentences([{ store: "chrome", read: chrome }, { store: "firefox", read: firefox }, { store: "edge", read: chrome }])).toEqual([
      "Firefox category: Other (mapped from Accessibility in Listing); Chrome and Edge: Accessibility (from Listing).",
      "Firefox has no Accessibility category, so Other was sent; add `- Category:` under `## Firefox Add-ons` to choose another.",
    ]);

    const section = { categories: ["Other"], from: "section" as const };

    expect(categoriesSentences([{ store: "chrome", read: chrome }, { store: "edge", read: chrome }, { store: "firefox", read: section }])).toEqual([
      "Firefox category: Other (from the Firefox Add-ons section); Chrome and Edge: Accessibility (from Listing).",
    ]);

    expect(categoriesSentences([{ store: "firefox", read: section }])).toEqual(["Firefox category: Other (from the Firefox Add-ons section)."]);
    expect(categoriesSentences([{ store: "chrome", read: chrome }, { store: "edge", read: chrome }])).toEqual([]);
  });
});

describe("sync-listing sends each store its own category", () => {
  const platform = useProjectRoutes("extdev-store-categories-");
  let root = "";

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "extdev-categories-"));
    platform.login();

    for (const store of ["chrome", "firefox", "edge"]) {
      platform.routes[`PUT ${LISTING(store)}`] = () => ({ body: { ok: true, store, changes: [`categories: [] -> set`] } });
      platform.routes[`POST ${PREFLIGHT(store)}`] = () => ({ body: { checks: [] } });
    }
  });

  it("reads the per-store line into the local listing", () => {
    fs.writeFileSync(path.join(root, "STORE.md"), FIREFOX_OTHER);

    const local = readLocalListing(root, "firefox");
    if ("problem" in local) throw new Error(local.problem);

    expect(local.patch.listing.categories).toEqual(["Other"]);
    expect(local.categories).toEqual({ categories: ["Other"], from: "section" });
  });

  it("carries the Firefox section's category in the firefox body and the Listing value in the chrome and edge bodies, and says so", async () => {
    if (process.platform === "win32") return;

    fs.writeFileSync(path.join(root, "STORE.md"), FIREFOX_OTHER);

    const out = JSON.parse(await submit({ action: "sync-listing", browsers: ["chrome", "edge", "firefox"], projectPath: root, api: API }));

    expect(out.status).toBe("listing-synced");
    expect(platform.sent("PUT", LISTING("firefox"))[0]!.body.listing.categories).toEqual(["Other"]);
    expect(platform.sent("PUT", LISTING("chrome"))[0]!.body.listing.categories).toEqual(["Accessibility"]);
    expect(platform.sent("PUT", LISTING("edge"))[0]!.body.listing.categories).toEqual(["Accessibility"]);
    expect(out.value.stores.firefox.categories).toEqual({ sent: ["Other"], from: "section" });
    expect(out.value.stores.chrome.categories).toEqual({ sent: ["Accessibility"], from: "listing" });
    expect(out.value.sayToPerson).toContain("Firefox category: Other (from the Firefox Add-ons section); Chrome and Edge: Accessibility (from Listing).");
    expect(out.hint).toContain("Firefox category: Other (from the Firefox Add-ons section); Chrome and Edge: Accessibility (from Listing).");
    expect(out.value.sayToPerson).not.toContain("has no Accessibility category");
  });

  it("sends AMO's Other for a Listing Accessibility with no Firefox line and prints the mapping", async () => {
    if (process.platform === "win32") return;

    fs.writeFileSync(path.join(root, "STORE.md"), HEAD);

    const out = JSON.parse(await submit({ action: "sync-listing", browsers: ["firefox"], projectPath: root, api: API }));

    expect(out.status).toBe("listing-synced");
    expect(platform.sent("PUT", LISTING("firefox"))[0]!.body.listing.categories).toEqual(["Other"]);
    expect(out.value.stores.firefox.categories).toEqual({ sent: ["Other"], from: "mapping", mapped: [{ from: "Accessibility", to: "Other" }] });
    expect(out.value.sayToPerson).toContain("Firefox category: Other (mapped from Accessibility in Listing).");
    expect(out.value.sayToPerson).toContain(
      "Firefox has no Accessibility category, so Other was sent; add `- Category:` under `## Firefox Add-ons` to choose another.",
    );
  });

  it("says nothing about categories when every store reads the same Listing value", async () => {
    if (process.platform === "win32") return;

    fs.writeFileSync(path.join(root, "STORE.md"), HEAD.replace("- Category: Accessibility", "- Category: Privacy & Security"));

    const out = JSON.parse(await submit({ action: "sync-listing", browsers: ["chrome", "firefox"], projectPath: root, api: API }));

    expect(out.status).toBe("listing-synced");
    expect(platform.sent("PUT", LISTING("firefox"))[0]!.body.listing.categories).toEqual(["Privacy & Security"]);
    expect(out.value.sayToPerson ?? "").not.toMatch(/category:|has no .* category/);
  });
});
