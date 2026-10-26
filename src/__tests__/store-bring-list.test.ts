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

  it("reads ready when no required row is missing and the review stage can go, and never when the review stage refuses", () => {
    const ready = requirementsView({ store: "edge", items: [row({ id: "edge.name" }), row({ id: "edge.promo_video", label: "Promo video", required: false, status: "missing", satisfiedBy: "store-dashboard" })] });

    expect(bringListOf("edge", ready)?.readyForReview).toBe(true);
    expect(bringListOf("edge", ready)?.say).toBe("Edge Add-ons has every required input on file. Optional: promo video.");
    expect(bringListOf("edge", ready, false)?.readyForReview).toBe(false);
    expect(bringListOf("edge", null)).toBeNull();
    expect(bringListSentences({ edge: { bringList: bringListOf("edge", ready) }, chrome: {} })).toBe("Edge Add-ons has every required input on file. Optional: promo video.");
  });
});
