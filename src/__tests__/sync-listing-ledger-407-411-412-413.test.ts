import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import { STORE_FIELDS, listingForStore, parseStoreMdListing } from "../lib/store-md-listing";
import { storeMdSectionOf } from "../lib/store-md-fields";
import { readLocalListing } from "../lib/submit-facts-local";
import { EDGE_STORE_LOGO_SENTENCE, PLAIN_LISTING_SENTENCE } from "../tools/store-listing";
import { handler as submit } from "../tools/submit-local";
import { storeMdNamedForPerson } from "../lib/store-md-words";
import { solidPng } from "./fixtures/png";
import { API, PROJECT_ROUTE, useProjectRoutes } from "./fixtures/project-routes";

const LISTING = (store: string) => `${PROJECT_ROUTE}/stores/${store}/listing`;
const PREFLIGHT = (store: string) => `${PROJECT_ROUTE}/stores/${store}/submissions/preflight`;

const CHROME_SECTION = `## Chrome Web Store

### Single purpose

Hide personal information on the pages the user has open, on demand.

### Permissions justification

- storage: Remembers whether the shield is on.
- scripting: Adds the hiding script to open tabs.
`;

const storeMd = (firefoxNotes: string, edgeSection = "## Edge Add-ons\n\n### Certification notes\n\nClick the toolbar button.\n"): string => `# Store metadata

## Listing

- Name: PII Shield
- Summary: Hide personal information on every open tab with one click.
- Description:

  Sharing your screen? Click PII Shield and names are blurred.

- Category: Productivity
- Screenshots: TODO at least one 1280x800 screenshot per store.

${CHROME_SECTION}
${edgeSection}
## Firefox Add-ons

### Reviewer notes

${firefoxNotes}
`;

function project(content: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "extdev-ledger-413-"));
  fs.writeFileSync(path.join(root, "STORE.md"), content);
  fs.mkdirSync(path.join(root, "dist", "chrome", "icons"), { recursive: true });
  fs.writeFileSync(path.join(root, "dist", "chrome", "manifest.json"), JSON.stringify({ icons: { "128": "icons/128.png" } }));
  fs.writeFileSync(path.join(root, "dist", "chrome", "icons", "128.png"), solidPng(128, 128));

  return root;
}

const LONG_NOTES = "a".repeat(3_100);
const SHORT_NOTES = "To test, click the toolbar button.";

const OVER = "`### Reviewer notes` under `## Firefox Add-ons` in STORE.md (reviewerNotes) is 3,100 characters, over the 3,000 characters Firefox Add-ons takes";

const requirement = (id: string, status: "have" | "missing" | "unknown", over: Record<string, unknown> = {}) => ({
  id,
  label: id.split(".")[1]!.replace(/_/g, " "),
  required: true,
  format: "As the store asks.",
  satisfiedBy: "store-md: Single purpose",
  how: "Set it.",
  status,
  ...over,
});

describe("413: a Firefox reviewer note over AMO's 3,000 characters is refused here, by the preflight and by sync-listing, before anything is sent", () => {
  const platform = useProjectRoutes("extdev-ledger-413-api-");
  let root = "";

  beforeEach(() => {
    root = project(storeMd(LONG_NOTES));
    platform.login();
    platform.routes[`POST ${PREFLIGHT("firefox")}`] = () => ({ body: { summary: { canSubmit: true }, checks: [] } });
    platform.routes[`PUT ${LISTING("firefox")}`] = () => ({ body: { ok: true, store: "firefox", changes: [] } });
  });

  it("measures the field against the store's own limit and names the heading, the section, the length and the limit", () => {
    const read = listingForStore(parseStoreMdListing(storeMd(LONG_NOTES)), "firefox");

    expect(read.listing).not.toHaveProperty("reviewerNotes");
    expect(read.overLimit).toEqual([{ field: "reviewerNotes", length: 3_100, limit: 3_000, unit: "characters" }]);
    expect(read.unread.reviewerNotes?.line).toBe("### Reviewer notes");

    const local = readLocalListing(root, "firefox");
    if ("problem" in local) throw new Error(local.problem);

    expect(local.overLimit).toEqual([{ store: "firefox", field: "reviewerNotes", line: "### Reviewer notes", section: "## Firefox Add-ons", length: 3_100, limit: 3_000, unit: "characters" }]);
    expect(listingForStore(parseStoreMdListing(storeMd(SHORT_NOTES)), "firefox").overLimit).toEqual([]);
  });

  it("the preflight with projectPath says it in the answer and in the store's storeMd block", async () => {
    if (process.platform === "win32") return;

    const out = JSON.parse(await submit({ action: "preflight", browsers: ["firefox"], projectPath: root, api: API }));

    expect(out.value.stores.firefox.storeMd.overLimit).toEqual([
      { store: "firefox", field: "reviewerNotes", line: "### Reviewer notes", section: "## Firefox Add-ons", length: 3_100, limit: 3_000, unit: "characters", say: OVER },
    ]);

    expect(out.value.sayToPerson).toContain(storeMdNamedForPerson(`${OVER}; sync-listing refuses the firefox listing until it fits. Shorten \`### Reviewer notes\` under \`## Firefox Add-ons\` in STORE.md to 3,000 characters or fewer.`));
    expect(out.value.stores.firefox.storeMd.skipped).toBeUndefined();
  });

  it("sync-listing refuses the store as a bad request with the fix and the retry call, and sends nothing", async () => {
    if (process.platform === "win32") return;

    const out = JSON.parse(await submit({ action: "sync-listing", browsers: ["firefox"], projectPath: root, api: API }));

    expect(platform.sent("PUT", LISTING("firefox"))).toHaveLength(0);
    expect(out.ok).toBe(false);
    expect(out.status).toBe("sync-listing-refused");
    expect(out.error).toMatchObject({ code: "E_BAD_REQUEST", name: "ListingFieldRefused" });
    expect(out.error.message).toBe(`firefox: ${OVER}, so nothing was sent to firefox.`);
    expect(out.hint).toBe(
      'Shorten `### Reviewer notes` under `## Firefox Add-ons` in STORE.md to 3,000 characters or fewer, then call extension_submit action:"sync-listing" browsers:["firefox"] with the same projectPath.',
    );

    expect(out.value.stores.firefox).toMatchObject({ status: "refused", code: "LISTING_FIELD_OVER_LIMIT" });
    expect(out.value.stores.firefox.overLimit[0]).toMatchObject({ field: "reviewerNotes", line: "### Reviewer notes", length: 3_100, limit: 3_000 });
    expect(out.hint).not.toContain("console");
  });
});

describe("411: a sync-listing that landed on one store and was refused on another answers a partial status, not a platform fault", () => {
  const platform = useProjectRoutes("extdev-ledger-411-api-");
  let root = "";

  beforeEach(() => {
    platform.login();
    platform.routes[`POST ${PREFLIGHT("edge")}`] = () => ({ body: { summary: { canSubmit: true }, checks: [] } });
    platform.routes[`POST ${PREFLIGHT("firefox")}`] = () => ({ body: { summary: { canSubmit: true }, checks: [] } });
    platform.routes[`PUT ${LISTING("edge")}`] = () => ({ body: { ok: true, store: "edge", changes: ['title: "" -> "PII Shield"'] } });
  });

  it("answers listing-partly-synced with what landed, the refused field's heading and limit, and the retry for the refused store alone", async () => {
    if (process.platform === "win32") return;

    root = project(storeMd(LONG_NOTES));

    const out = JSON.parse(await submit({ action: "sync-listing", browsers: ["edge", "firefox"], projectPath: root, useBuild: undefined, api: API }));

    expect(platform.sent("PUT", LISTING("edge"))).toHaveLength(1);
    expect(platform.sent("PUT", LISTING("firefox"))).toHaveLength(0);
    expect(out.ok).toBe(true);
    expect(out.status).toBe("listing-partly-synced");
    expect(out.error).toBeNull();
    expect(out.value.landed).toEqual(["edge"]);
    expect(out.value.refused).toEqual([{ store: "firefox", code: "LISTING_FIELD_OVER_LIMIT", message: `${OVER}, so nothing was sent to firefox.`, overLimit: out.value.stores.firefox.overLimit }]);
    expect(out.value.stores.edge.status).toBe("synced");
    expect(out.warnings[0]).toContain("firefox refused:");
    expect(out.hint).toContain("edge synced; firefox refused and was not written.");
    expect(out.hint).toContain('Shorten `### Reviewer notes` under `## Firefox Add-ons` in STORE.md to 3,000 characters or fewer, then call extension_submit action:"sync-listing" browsers:["firefox"] with the same projectPath.');
    expect(out.hint).toContain("The store that landed needs no second call.");
  });

  it("reads a limit the platform refuses into the same row, with useBuild in the retry, and keeps E_PLATFORM for a platform fault", async () => {
    if (process.platform === "win32") return;

    root = project(storeMd(SHORT_NOTES));
    platform.routes[`PUT ${LISTING("firefox")}`] = () => ({
      status: 400,
      body: { code: "LISTING_FIELD_OVER_LIMIT", field: "reviewerNotes", limit: 3_000, unit: "characters", message: "listing.reviewerNotes (Notes to reviewer) is 3,114 characters, over the 3,000 characters Firefox Add-ons takes, so nothing was written" },
    });

    const partial = JSON.parse(await submit({ action: "sync-listing", browsers: ["edge", "firefox"], projectPath: root, api: API }));

    expect(partial.status).toBe("listing-partly-synced");
    expect(partial.value.stores.firefox.overLimit[0]).toMatchObject({ field: "reviewerNotes", line: "### Reviewer notes", section: "## Firefox Add-ons", length: 3_114, limit: 3_000, unit: "characters" });
    expect(partial.hint).toContain("Shorten `### Reviewer notes` under `## Firefox Add-ons` in STORE.md to 3,000 characters or fewer, then call extension_submit action:\"sync-listing\" browsers:[\"firefox\"] with the same projectPath.");

    const alone = JSON.parse(await submit({ action: "sync-listing", browsers: ["firefox"], projectPath: root, api: API }));

    expect(alone.ok).toBe(false);
    expect(alone.status).toBe("sync-listing-refused");
    expect(alone.error.code).toBe("E_BAD_REQUEST");

    platform.routes[`PUT ${LISTING("firefox")}`] = () => ({ status: 500, body: { code: "INTERNAL", message: "The registry is down." } });

    const fault = JSON.parse(await submit({ action: "sync-listing", browsers: ["firefox"], projectPath: root, api: API }));

    expect(fault.ok).toBe(false);
    expect(fault.error.code).toBe("E_PLATFORM");
    expect(fault.hint).toContain('call extension_submit action:"sync-listing" browsers:["firefox"] with the same projectPath');
  });
});

describe("412: Edge takes the single purpose and the permission justifications, from its own section or the Chrome one, and counts its rows as still blocking", () => {
  const platform = useProjectRoutes("extdev-ledger-412-api-");
  let root = "";

  beforeEach(() => {
    platform.login();
    platform.routes[`PUT ${LISTING("edge")}`] = () => ({ body: { ok: true, store: "edge", changes: [] } });
  });

  it("declares both fields for Edge, read also under the Chrome section", () => {
    expect(STORE_FIELDS.edge).toEqual(expect.arrayContaining(["singlePurpose", "permissionJustifications"]));
    expect(storeMdSectionOf("singlePurpose", "edge")).toEqual({ section: "## Edge Add-ons", alsoRead: ["## Chrome Web Store"] });
    expect(storeMdSectionOf("singlePurpose", "chrome")).toEqual({ section: "## Chrome Web Store", alsoRead: [] });
  });

  it("sends the Chrome section's text when Edge has none of its own, says which section it read, and names the Edge rows still missing on read back", async () => {
    if (process.platform === "win32") return;

    root = project(storeMd(SHORT_NOTES));
    platform.routes[`POST ${PREFLIGHT("edge")}`] = () => ({
      body: {
        summary: { canSubmit: true },
        checks: [],
        requirements: {
          store: "edge",
          items: [
            requirement("edge.single_purpose", "missing"),
            requirement("edge.permission_justifications", "missing", { satisfiedBy: "store-md: Permissions justification" }),
            requirement("edge.name", "have"),
            requirement("edge.promo_video", "missing", { required: false }),
          ],
          missingRequired: 2,
          missingOptional: 1,
        },
      },
    });

    const out = JSON.parse(await submit({ action: "sync-listing", browsers: ["edge"], projectPath: root, api: API }));
    const put = platform.sent("PUT", LISTING("edge"))[0]!.body;

    expect(put.listing.singlePurpose).toBe("Hide personal information on the pages the user has open, on demand.");
    expect(put.listing.permissionJustifications).toEqual([
      { permission: "storage", justification: "Remembers whether the shield is on." },
      { permission: "scripting", justification: "Adds the hiding script to open tabs." },
    ]);

    expect(out.value.stores.edge.filled).toEqual(expect.arrayContaining(["singlePurpose", "permissionJustifications"]));
    expect(out.value.stores.edge.borrowed).toEqual({ singlePurpose: "## Chrome Web Store", permissionJustifications: "## Chrome Web Store" });
    expect(out.value.sayToPerson).toContain(
      "For edge, `### Single purpose` and `### Permissions justification` were read from the `## Chrome Web Store` section of your store listing (STORE.md), since `## Edge Add-ons` has none of its own; Edge takes the same text Chrome does.",
    );

    expect(out.value.stores.edge.stillBlocking).toEqual(["edge.single_purpose", "edge.permission_justifications"]);
    expect(out.hint).toContain("edge still lacks a single purpose statement and permission justifications");
  });

  it("an Edge section with its own subsections wins and borrows nothing", async () => {
    if (process.platform === "win32") return;

    root = project(storeMd(SHORT_NOTES, "## Edge Add-ons\n\n### Single purpose\n\nEdge's own statement.\n\n### Permissions justification\n\n- storage: Edge's own reason.\n"));
    platform.routes[`POST ${PREFLIGHT("edge")}`] = () => ({ body: { summary: { canSubmit: true }, checks: [] } });

    const out = JSON.parse(await submit({ action: "sync-listing", browsers: ["edge"], projectPath: root, api: API }));
    const put = platform.sent("PUT", LISTING("edge"))[0]!.body;

    expect(put.listing.singlePurpose).toBe("Edge's own statement.");
    expect(put.listing.permissionJustifications).toEqual([{ permission: "storage", justification: "Edge's own reason." }]);
    expect(out.value.stores.edge).not.toHaveProperty("borrowed");
    expect(out.value.sayToPerson).not.toContain("were read from");
  });
});

describe("407: the screenshots line is said once at the top of a sync-listing or preflight answer, and the plain-act sentence quotes no ruling", () => {
  const platform = useProjectRoutes("extdev-ledger-407-api-");
  let root = "";

  beforeEach(() => {
    root = project(storeMd(SHORT_NOTES));
    platform.login();

    for (const store of ["chrome", "edge"]) {
      platform.routes[`POST ${PREFLIGHT(store)}`] = () => ({
        body: {
          summary: { canSubmit: true },
          checks: [],
          requirements: {
            store,
            items: store === "edge" ? [requirement("edge.store_logo", "unknown", { label: "Store logo", format: "300x300 px PNG.", satisfiedBy: "store-dashboard", dashboardTab: "Store listings" })] : [],
            missingRequired: 0,
            missingOptional: 0,
          },
        },
      });

      platform.routes[`PUT ${LISTING(store)}`] = () => ({ body: { ok: true, store, changes: ['title: "" -> "PII Shield"'] } });
    }
  });

  it("sync-listing carries screenshotsLine once and no store row repeats it; the Edge row says the icon did not fill the store logo (408)", async () => {
    if (process.platform === "win32") return;

    const out = JSON.parse(await submit({ action: "sync-listing", browsers: ["chrome", "edge"], projectPath: root, api: API }));

    expect(out.value.screenshotsLine).toBe(
      'the `- Screenshots:` line in STORE.md names no screenshot file; capture them with extension_screenshot store:"<store>", one call per view, and sync-listing picks them up from store/screenshots/<store>/',
    );

    expect(out.value.stores.chrome).not.toHaveProperty("skipped");
    expect(out.value.stores.edge).not.toHaveProperty("skipped");
    expect(JSON.stringify(out.value.stores)).not.toContain("- Screenshots:");

    expect(out.value.sayToPerson).toContain(PLAIN_LISTING_SENTENCE);
    expect(PLAIN_LISTING_SENTENCE).not.toMatch(/ruling/i);
    expect(out.value.sayToPerson).not.toMatch(/ruling \d+/);

    expect(out.value.stores.edge.images).toEqual({
      clears: [],
      remain: ["Store logo (300x300 px PNG.), not filled by the icon sync-listing sent: resize the largest icon the manifest names to 300x300 px on this machine and upload it on the Partner Center Store listings page; the 128 px icon sync-listing sends is the package icon, not the store logo"],
      storeLogo: "unknown",
    });

    expect(out.value.sayToPerson).toContain(EDGE_STORE_LOGO_SENTENCE);
  });

  it("the preflight carries screenshotsLine once at the top and in no store's storeMd block", async () => {
    if (process.platform === "win32") return;

    const out = JSON.parse(await submit({ action: "preflight", browsers: ["chrome", "edge"], projectPath: root, api: API }));

    expect(out.value.screenshotsLine).toContain("the `- Screenshots:` line in STORE.md names no screenshot file");
    expect(out.value.stores.chrome.storeMd).not.toHaveProperty("screenshotsLine");
    expect(out.value.stores.edge.storeMd).not.toHaveProperty("screenshotsLine");
    expect(out.value.stores.chrome.storeMd.skipped).toBeUndefined();
    expect(JSON.stringify(out.value.stores)).not.toContain("- Screenshots:");
  });
});
