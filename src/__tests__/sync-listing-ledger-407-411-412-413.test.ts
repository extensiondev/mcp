import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import { STORE_FIELDS, listingForStore, parseStoreMdListing } from "../lib/store-md-listing";
import { storeMdSectionOf } from "../lib/store-md-fields";
import { readLocalListing } from "../lib/submit-facts-local";
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
});

describe("412: Edge takes the single purpose and the permission justifications, from its own section or the Chrome one, and counts its rows as still blocking", () => {
  const platform = useProjectRoutes("extdev-ledger-412-api-");
  const root = "";

  beforeEach(() => {
    platform.login();
    platform.routes[`PUT ${LISTING("edge")}`] = () => ({ body: { ok: true, store: "edge", changes: [] } });
  });

  it("declares both fields for Edge, read also under the Chrome section", () => {
    expect(STORE_FIELDS.edge).toEqual(expect.arrayContaining(["singlePurpose", "permissionJustifications"]));
    expect(storeMdSectionOf("singlePurpose", "edge")).toEqual({ section: "## Edge Add-ons", alsoRead: ["## Chrome Web Store"] });
    expect(storeMdSectionOf("singlePurpose", "chrome")).toEqual({ section: "## Chrome Web Store", alsoRead: [] });
  });
});
