// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { describe, expect, it } from "vitest";

import { listingForStore, parseStoreMdListing } from "../lib/store-md-listing";

const STORES = ["chrome", "edge", "firefox", "safari"] as const;

describe("the License line belongs to Firefox alone", () => {
  it("reads `- License:` under `## Firefox Add-ons` into the Firefox listing and into no other store", () => {
    const parsed = parseStoreMdListing(["# Widget", "", "## Listing", "", "- Name: Widget", "", "## Firefox Add-ons", "", "- License: MPL-2.0", ""].join("\n"));

    expect(listingForStore(parsed, "firefox").listing.license).toBe("MPL-2.0");

    for (const store of STORES.filter((name) => name !== "firefox")) {
      expect(listingForStore(parsed, store).listing).not.toHaveProperty("license");
    }
  });

  it("still reads an older file that keeps the line under `## Listing`, and the Firefox section wins when both carry one", () => {
    const older = parseStoreMdListing(["# Widget", "", "## Listing", "", "- License: MIT", ""].join("\n"));
    const both = parseStoreMdListing(["# Widget", "", "## Listing", "", "- License: MIT", "", "## Firefox Add-ons", "", "- License: ISC", ""].join("\n"));

    expect(listingForStore(older, "firefox").listing.license).toBe("MIT");
    expect(listingForStore(both, "firefox").listing.license).toBe("ISC");
    expect(listingForStore(older, "chrome").listing).not.toHaveProperty("license");
  });
});
