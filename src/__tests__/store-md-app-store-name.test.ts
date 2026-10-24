import { describe, expect, it } from "vitest";

import { listingDigest } from "../lib/store-listing-media";
import { storeMdFieldRows } from "../lib/store-md-fields";
import { LISTING_TEXT_FIELDS, listingForStore, parseStoreMdListing } from "../lib/store-md-listing";

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
  it("is read from ## Safari into the App Store listing only, beside the shared Name", () => {
    const parsed = parseStoreMdListing(LEON);

    expect(listingForStore(parsed, "safari").listing).toMatchObject({
      title: "Leon: Blur Faces in Every Photo!!",
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
