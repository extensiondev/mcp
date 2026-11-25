import { describe, expect, it } from "vitest";

import { edgeListingUrlOf, repairEdgeStoreUrl } from "../lib/edge-listing";
import { historyEntry, storeConfigView } from "../lib/platform-store-records";

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

  it("1196: a Safari key the store holds needs no signing secret, because the submit mints them; a missing key is still named", () => {
    const signing = ["STORE_SAFARI_APP_CERT_P12_BASE64", "STORE_SAFARI_APP_CERT_PASSWORD", "STORE_SAFARI_PROVISIONING_PROFILE_BASE64"];

    expect(storeConfigView({ configured: true, credentialsConfigured: false, missingSecrets: signing }, "safari")).toMatchObject({ credentialsConfigured: true, missingCredentials: [] });
    expect(storeConfigView({ configured: true, credentialsConfigured: false, missingSecrets: ["STORE_SAFARI_ASC_KEY_ID", ...signing] }, "safari")).toMatchObject({
      credentialsConfigured: false,
      missingCredentials: ["STORE_SAFARI_ASC_KEY_ID", ...signing],
    });

    expect(storeConfigView({ credentialsConfigured: false, missingSecrets: ["STORE_EDGE_API_KEY"] }, "edge")).toMatchObject({ credentialsConfigured: false, missingCredentials: ["STORE_EDGE_API_KEY"] });
  });

  it("859: a submission read by id says whether its upload was signed, a boolean and the record's sentence, nothing else under that name", () => {
    const sentence = "This upload was signed with the project's Verified uploads key.";
    const row = { id: "c3151505", status: "draft", version: "0.1.0" };

    expect(historyEntry({ ...row, uploadSigned: true, uploadSignedSentence: sentence })).toMatchObject({ uploadSigned: true, uploadSignedSentence: sentence });
    expect(historyEntry({ ...row, uploadSigned: false, uploadSignedSentence: sentence })).toEqual({ ...row, uploadSigned: false });
    expect(historyEntry({ ...row, uploadSigned: "a-key", uploadSignedSentence: sentence })).toEqual(row);
  });
});
