import { describe, expect, it } from "vitest";

import { edgeListingUrlOf, repairEdgeStoreUrl } from "../lib/edge-listing";
import { storeConfigView } from "../lib/platform-store-records";

const CRX = "beinobilkpkoinfeiljeplnjollkgmbp";
const LISTING = `https://microsoftedge.microsoft.com/addons/detail/${CRX}`;
const DEAD = "https://microsoftedge.microsoft.com/addons/detail/903d21e4-0e5b-4507-95f2-4620fcf06f1c";

describe("Edge listing links", () => {
  it("keys the listing by the crx id, with or without the slug, and never by the product id", () => {
    expect(edgeListingUrlOf(CRX)).toBe(LISTING);
    expect(edgeListingUrlOf(`https://microsoftedge.microsoft.com/addons/detail/rebeccat/${CRX}`)).toBe(LISTING);
    expect(edgeListingUrlOf(DEAD)).toBe("");
    expect(repairEdgeStoreUrl(DEAD, LISTING)).toBe(LISTING);
    expect(repairEdgeStoreUrl(DEAD)).toBe("");
  });

  it("drops a dead Edge listing from the store configuration and repairs it from the crx id", () => {
    expect(storeConfigView({ storeUrl: DEAD, storeId: "903d21e4" }, "edge")?.storeUrl).toBeUndefined();
    expect(storeConfigView({ storeUrl: DEAD, crxId: CRX }, "edge")?.storeUrl).toBe(LISTING);
    expect(storeConfigView({ storeUrl: "https://chromewebstore.google.com/detail/x" }, "chrome")?.storeUrl).toBe(
      "https://chromewebstore.google.com/detail/x",
    );
  });
});
