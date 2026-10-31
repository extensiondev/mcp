import { describe, expect, it } from "vitest";

import { bringListOf, bringListSentences, screenshotDoor } from "../lib/store-bring-list";
import { requirementsView } from "../lib/store-requirements";

const row = (over: Record<string, unknown>) => ({
  id: "firefox.name",
  label: "Name",
  required: true,
  format: "Up to 50 characters.",
  docs: "https://extensionworkshop.com/documentation/publish/submitting-an-add-on/",
  satisfiedBy: "store-md: Name",
  how: "Set `- Name:` under `## Listing` in STORE.md.",
  status: "have",
  ...over,
});

const FIREFOX = requirementsView({
  store: "firefox",
  items: [
    row({}),
    row({ id: "firefox.add_on_id", label: "Add-on ID", required: false, format: "browser_specific_settings.gecko.id in the manifest.", satisfiedBy: "file: manifest.json", status: "missing" }),
    row({ id: "firefox.data_collection_permissions", label: "Data collection declaration", format: "gecko.data_collection_permissions in the manifest.", satisfiedBy: "file: manifest.json", status: "missing" }),
    row({ id: "firefox.icon", label: "Add-on icon", format: "Square PNG, at least 128x128 px.", satisfiedBy: "file: dist/firefox (the 128 px icon the manifest names)", status: "have" }),
    row({ id: "firefox.screenshots", label: "Screenshots", required: false, format: "PNG or JPEG; 1280x800 px reads best.", satisfiedBy: "store-md: Screenshots", status: "missing" }),
    row({ id: "firefox.source_archive", label: "Source code archive", format: "A zip of the sources.", satisfiedBy: "store-config: sourceArchive", status: "missing" }),
    row({ id: "firefox.api_credentials", label: "AMO API credentials", format: "JWT issuer and secret.", satisfiedBy: "console-only", status: "missing" }),
  ],
});

describe("the bring list reads the platform's rows with the supply word, the decide-once mark and the door that clears each", () => {
  it("splits from-your-build from you-supply, marks decide-once and never-prefilled rows, and names the door per row", () => {
    const list = bringListOf("firefox", FIREFOX);
    if (!list) throw new Error("no list");

    const byId = (id: string) => list.rows.find((r) => r.id === id);

    expect(list.readyForReview).toBe(false);
    expect(byId("firefox.name")).toMatchObject({ supply: "you supply", status: "have", clearedBy: "the Name line in STORE.md; sync-listing sends it", docs: expect.stringContaining("https://") });
    expect(byId("firefox.add_on_id")).toMatchObject({ supply: "you supply", decideOnce: true, clearedBy: "manifest.json in the build" });
    expect(byId("firefox.data_collection_permissions")).toMatchObject({ supply: "you supply", neverPrefilled: true, clearedBy: expect.stringContaining("never proposes a privacy or data answer") });
    expect(byId("firefox.icon")).toMatchObject({ supply: "from your build" });
    expect(byId("firefox.screenshots")).toMatchObject({ supply: "from your build", clearedBy: screenshotDoor("firefox") });
    expect(byId("firefox.source_archive")).toMatchObject({ supply: "from your build", clearedBy: expect.stringContaining("Source archive") });
    expect(byId("firefox.api_credentials")).toMatchObject({ supply: "you supply", clearedBy: "the console store settings" });
    expect(byId("firefox.name")).not.toHaveProperty("decideOnce");

    expect(list.say).toBe(
      "Before Firefox AMO reviews it, bring 3 required inputs. From your build: Source code archive (A zip of the sources.). You supply: Data collection declaration (gecko.data_collection_permissions in the manifest.; never prefilled); AMO API credentials (JWT issuer and secret.). Optional: add-on id, screenshots.",
    );

    expect(list.say).not.toMatch(/generat/i);
    expect(screenshotDoor("chrome")).toContain("1280x800 or 640x400 px as a 24-bit PNG");
  });

  it("counts only the missing rows and says an unknown row as not readable from here, with its Partner Center page (ledger 316)", () => {
    const product = "https://partner.microsoft.com/dashboard/microsoftedge/903d21e4-0e5b-4507-95f2-4620fcf06f1c/packages/dashboard";
    const view = requirementsView({
      store: "edge",
      items: [
        row({ id: "edge.name", label: "Extension name" }),
        row({ id: "edge.first_submission", label: "First submission through Partner Center", format: "Submitted once in Partner Center.", satisfiedBy: "console-only", status: "missing" }),
        row({ id: "edge.store_logo", label: "Store logo", format: "300x300 px PNG.", satisfiedBy: "store-dashboard", status: "unknown", dashboardTab: "Store listings", dashboardUrl: product }),
        row({ id: "edge.privacy_policy_requirements", label: "Privacy policy requirements and mature content", format: "Both answers on the Properties page.", satisfiedBy: "store-dashboard", status: "unknown", dashboardTab: "Properties", dashboardUrl: product }),
        row({ id: "edge.promo_video", label: "YouTube video URL", required: false, format: "A YouTube video URL.", satisfiedBy: "store-dashboard", status: "unknown", dashboardTab: "Store listings", dashboardUrl: product }),
      ],
      missingRequired: 1,
      missingOptional: 0,
    });
    const list = bringListOf("edge", view, false);
    if (!list) throw new Error("no list");

    expect(view?.missingRequired).toBe(1);
    expect(list.rows.find((r) => r.id === "edge.store_logo")).toMatchObject({ status: "unknown", dashboardTab: "Store listings", dashboardUrl: product });
    expect(list.rows.find((r) => r.id === "edge.promo_video")).toMatchObject({ clearedBy: `the Store listings page of the product in Partner Center at ${product}` });
    expect(list.say).toBe(
      `Before Edge Add-ons reviews it, bring 1 required input. You supply: First submission through Partner Center (Submitted once in Partner Center.). Not readable from here: Store logo (Store listings page); Privacy policy requirements and mature content (Properties page); the platform cannot read Partner Center's listing, so check each in Partner Center at ${product}.`,
    );

    expect(list.say).not.toContain("bring 3");
    expect(list.say).not.toContain("From your build: Store logo");
    expect(list.say).not.toContain("Optional");

    const read = requirementsView({ store: "edge", items: [row({ id: "edge.name" }), row({ id: "edge.store_logo", label: "Store logo", format: "300x300 px PNG.", satisfiedBy: "store-dashboard", status: "unknown" })], missingRequired: 0, missingOptional: 0 });

    expect(bringListOf("edge", read, false)?.say).toBe("Edge Add-ons has every required input this platform can read on file. Not readable from here: Store logo; the platform cannot read Partner Center's listing, so check each in Partner Center.");
  });

  it("reads ready when no required row is missing and the review stage can go, and never when the review stage refuses", () => {
    const ready = requirementsView({ store: "edge", items: [row({ id: "edge.name" }), row({ id: "edge.promo_video", label: "Promo video", required: false, status: "missing", satisfiedBy: "store-dashboard" })] });

    expect(bringListOf("edge", ready)?.readyForReview).toBe(true);
    expect(bringListOf("edge", ready)?.say).toBe("Edge Add-ons has every required input on file. Optional: promo video.");
    expect(bringListOf("edge", ready, false)?.readyForReview).toBe(false);
    expect(bringListOf("edge", null)).toBeNull();
    expect(bringListSentences({ edge: { bringList: bringListOf("edge", ready) }, chrome: {} })).toBe("Edge Add-ons has every required input on file. Optional: promo video.");
  });
});
