// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { describe, expect, it } from "vitest";

import { withChromeVisibility } from "../lib/chrome-visibility";
import { listingDigest } from "../lib/store-listing-media";
import { listingForStore, parseStoreMdListing } from "../lib/store-md-listing";
import { chromeDashboardSentence, requirementsView } from "../lib/store-requirements";

const STORE_MD = `# Leon

## Listing

- Name: Leon
- Support URL: https://example.com/support

## Chrome Web Store

- Visibility: Private (trusted testers)

### Single purpose

Blur faces.
`;

describe("the Chrome visibility line and the dashboard sentence", () => {
  it("reads `- Visibility:` under the Chrome section as one of the dashboard's three values and hashes it as the platform does", () => {
    const read = withChromeVisibility(listingForStore(parseStoreMdListing(STORE_MD), "chrome"));

    expect(read.listing.visibility).toBe("private");
    expect(
      listingDigest({ listing: { title: "Leon", supportUrl: "https://example.com/support", visibility: "private" } }),
    ).toBe("2dc46cedc664f43e7eb0154c7acec81755960e182e2eafd1b03fdbc52c7c68ec");

    const odd = withChromeVisibility(listingForStore(parseStoreMdListing(STORE_MD.replace("Private (trusted testers)", "everyone")), "chrome"), "Visibility");

    expect(odd.listing.visibility).toBeUndefined();
    expect(odd.unread.visibility).toEqual({ line: "- Visibility:", reason: expect.stringContaining("is not public, unlisted or private") });
    expect(odd.skipped).toContain("visibility in STORE.md is not public, unlisted or private, the three visibilities the Chrome Web Store dashboard offers, so it was left out");
    expect(listingForStore(parseStoreMdListing(STORE_MD), "firefox").listing.visibility).toBeUndefined();
  });

  it("says which required Chrome inputs only the dashboard holds, by tab, with the address and the visibility intent", () => {
    const view = requirementsView({
      store: "chrome",
      items: [
        { id: "chrome.title", label: "Title", required: true, status: "have", satisfiedBy: "listing" },
        { id: "chrome.description", label: "Description", required: true, status: "unknown", satisfiedBy: "store-dashboard", dashboardTab: "Store listing", dashboardUrl: "https://chrome.google.com/webstore/devconsole/pub/item/edit" },
        { id: "chrome.remote_code", label: "Remote code", required: true, status: "unknown", satisfiedBy: "store-dashboard", dashboardTab: "Privacy" },
        { id: "chrome.visibility", label: "Visibility", required: true, status: "unknown", satisfiedBy: "store-dashboard", dashboardTab: "Distribution", actual: "a new item starts Public on the Distribution tab; the project's intent is Unlisted" },
        { id: "chrome.promo_video", label: "Promo video", required: false, status: "unknown", satisfiedBy: "store-dashboard", dashboardTab: "Store listing" },
      ],
      missingRequired: 0,
      missingOptional: 0,
    });

    expect(chromeDashboardSentence(view)).toBe(
      "The Chrome Web Store dashboard alone holds 3 required inputs Google's API cannot read, so they are unknown, not on file: Store listing (description); Privacy (remote code); Distribution (visibility). Confirm each on its tab at https://chrome.google.com/webstore/devconsole/pub/item/edit. Visibility: a new item starts Public on the Distribution tab; the project's intent is Unlisted.",
    );
  });
});
