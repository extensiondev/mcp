import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import { listingDigest } from "../lib/store-listing-media";
import { storeMdFieldRows } from "../lib/store-md-fields";
import { LISTING_TEXT_FIELDS, listingForStore, parseStoreMdListing } from "../lib/store-md-listing";
import { PLAIN_LISTING_SENTENCE } from "../tools/store-listing";
import { handler as submit } from "../tools/submit";
import { API, PROJECT_ROUTE, useProjectRoutes } from "./fixtures/project-routes";

const LEON = [
  "# Leon",
  "",
  "## Listing",
  "",
  "- Name: Leon: Blur Faces in Every Photo!!",
  "- Summary: Blurs faces on the page.",
  "",
  "## Safari",
  "",
  "- App Store name: Leon: Blur Faces",
  "",
].join("\n");

describe("the App Store name line (ledger 158)", () => {
  it("leaves a Name over 30 characters out of the App Store title with the limit, and keeps one that fits (ledger 160)", () => {
    const long = listingForStore(parseStoreMdListing(LEON.replace("- App Store name: Leon: Blur Faces", "")), "safari");

    expect(long.listing).not.toHaveProperty("title");
    expect(long.unread.title).toEqual({
      line: "- Name:",
      reason: "is 33 characters, over the 30 the App Store takes; add `- App Store name:` under `## Safari` with the name the app record keeps",
    });

    expect(long.skipped.some((line) => line.startsWith("title in STORE.md is 33 characters"))).toBe(true);
    expect(listingForStore(parseStoreMdListing(LEON.replace("- App Store name: Leon: Blur Faces", "")), "chrome").listing.title).toBe(
      "Leon: Blur Faces in Every Photo!!",
    );

    const fits = listingForStore(parseStoreMdListing(LEON.replace("Leon: Blur Faces in Every Photo!!", "Leon").replace("- App Store name: Leon: Blur Faces", "")), "safari");

    expect(fits.listing.title).toBe("Leon");
  });

  it("is read from ## Safari into the App Store listing only, beside the shared Name", () => {
    const parsed = parseStoreMdListing(LEON);

    expect(listingForStore(parsed, "safari").listing).toMatchObject({
      title: "Leon: Blur Faces",
      appStoreName: "Leon: Blur Faces",
    });

    expect(listingForStore(parsed, "chrome").listing).not.toHaveProperty("appStoreName");
  });

  it("is left out with the reason when it is over Apple's 30 characters", () => {
    const parsed = parseStoreMdListing(LEON.replace("- App Store name: Leon: Blur Faces", "- App Store name: Leon: Blur Faces in Every Photo!!"));
    const read = listingForStore(parsed, "safari");

    expect(read.listing).not.toHaveProperty("appStoreName");
    expect(read.unread.appStoreName).toEqual({
      line: "- App Store name:",
      reason: "is 33 characters, over the 30 the listing takes",
    });
  });

  it("is a row of the generated App Store field table, homed in ## Safari with a 30-character limit", () => {
    const row = storeMdFieldRows("safari").find((entry) => entry.field === "appStoreName");

    expect(row).toMatchObject({ line: "- App Store name:", section: "## Safari", limit: "up to 30 characters" });
    expect(storeMdFieldRows("chrome").some((entry) => entry.field === "appStoreName")).toBe(false);
  });

  it("hashes right after title, the place the platform's digest gives it", () => {
    expect(LISTING_TEXT_FIELDS.slice(0, 3)).toEqual(["title", "appStoreName", "subtitle"]);

    const withName = listingDigest({ listing: { title: "Leon", appStoreName: "Leon: Blur Faces", subtitle: "Blur" } } as never);
    const reordered = listingDigest({ listing: { subtitle: "Blur", appStoreName: "Leon: Blur Faces", title: "Leon" } } as never);

    expect(withName).toBe(reordered);
  });
});

describe("sync-listing's App Store title (ledger 160)", () => {
  const platform = useProjectRoutes("extdev-app-store-name-");
  let root = "";
  let sent: Array<Record<string, unknown>> = [];

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "extdev-app-store-name-"));
    fs.writeFileSync(path.join(root, "STORE.md"), LEON.replace("- App Store name: Leon: Blur Faces", ""));
    sent = [];
  });

  const routes = (config: unknown) => {
    platform.routes[`GET ${PROJECT_ROUTE}/stores/config`] = () => ({ body: config });
    platform.routes[`POST ${PROJECT_ROUTE}/stores/safari/submissions/preflight`] = () => ({ body: { checks: [] } });

    platform.routes[`PUT ${PROJECT_ROUTE}/stores/safari/listing`] = (call) => {
      sent.push(call.body.listing);

      return { body: { ok: true, store: "safari", changes: [{ field: "title", line: 'title: "" -> "Leon: Blur Faces"', derived: false }] } };
    };
  };

  const sync = () => submit({ action: "sync-listing", browsers: ["safari"], projectPath: root, api: API });

  it("sends the app record's name as the title when STORE.md has no App Store name line, and says the sync was a plain act", async () => {
    if (process.platform === "win32") return;

    platform.login();
    routes({ safari: { bundleId: "com.cezaraugusto.leon", appRecord: { id: "6826486337", name: "Leon: Blur Faces", bundleId: "com.cezaraugusto.leon" } } });

    const answer = JSON.parse(await sync());

    expect(answer.status).toBe("listing-synced");
    expect(sent[0]).toMatchObject({ title: "Leon: Blur Faces" });
    expect(answer.value.stores.safari).not.toHaveProperty("skipped");
    expect(answer.value.sayToPerson).toContain(PLAIN_LISTING_SENTENCE);
  });

  it("sends no title over 30 characters when no record name is known", async () => {
    if (process.platform === "win32") return;

    platform.login();
    routes({ safari: { bundleId: "com.cezaraugusto.leon", appRecord: null } });

    const answer = JSON.parse(await sync());

    expect(sent[0]).not.toHaveProperty("title");
    expect(answer.value.stores.safari.skipped[0]).toContain("over the 30 the App Store takes");
  });
});
