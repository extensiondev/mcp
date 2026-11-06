import { describe, expect, it } from "vitest";

import { DERIVED_SUFFIXES, EDGE_STORE_LOGO_RECIPE, bringListOf, supplyOf } from "../lib/store-bring-list";
import { supplierOf } from "../lib/store-onboarding-suppliers";
import { requirementsView } from "../lib/store-requirements";

const row = (over: Record<string, unknown>) => ({
  id: "chrome.title",
  label: "Title",
  required: true,
  format: "Up to 75 characters.",
  satisfiedBy: "store-md: Name",
  how: "Set `- Name:` under `## Listing` in STORE.md.",
  status: "have",
  ...over,
});

const ITEM = "https://chrome.google.com/webstore/devconsole/abc/def/edit";

describe("409: a Chrome preflight with required inputs only the dashboard holds never says every required input is on file", () => {
  it("says every required input this platform can read is on file, and counts the dashboard-only ones", () => {
    const view = requirementsView({
      store: "chrome",
      items: [
        row({}),
        row({ id: "chrome.store_icon", label: "Store icon", format: "128x128 px PNG.", satisfiedBy: "store-dashboard", status: "unknown", dashboardTab: "Store listing", dashboardUrl: ITEM }),
        row({ id: "chrome.data_usage", label: "Data usage", format: "Privacy tab answers.", satisfiedBy: "store-dashboard", status: "unknown", dashboardTab: "Privacy", dashboardUrl: ITEM }),
      ],
      missingRequired: 0,
      missingOptional: 0,
    });
    const list = bringListOf("chrome", view);
    if (!list) throw new Error("no list");

    expect(list.readyForReview).toBe(true);
    expect(list.say).toBe(
      "The Chrome Web Store has every required input this platform can read on file; the 2 required inputs only the item's dashboard holds stay unknown from here, named above with their tab.",
    );

    expect(list.say).not.toContain("has every required input on file");
  });

  it("keeps the plain sentence when nothing is unknown, and the not-readable sentence for the other stores", () => {
    const clear = requirementsView({ store: "chrome", items: [row({})], missingRequired: 0, missingOptional: 0 });

    expect(bringListOf("chrome", clear)?.say).toBe("The Chrome Web Store has every required input on file.");

    const edge = requirementsView({
      store: "edge",
      items: [row({ id: "edge.name" }), row({ id: "edge.store_logo", label: "Store logo", format: "300x300 px PNG.", satisfiedBy: "store-dashboard", status: "unknown", dashboardTab: "Store listings" })],
      missingRequired: 0,
      missingOptional: 0,
    });

    expect(bringListOf("edge", edge)?.say).toBe(
      "Edge Add-ons has every required input this platform can read on file. Not readable from here: Store logo (Store listings page); the platform cannot read Partner Center's listing, so check each in Partner Center.",
    );
  });
});

describe("408: the Edge 300 px store logo is an input the owner supplies, never one the build provides", () => {
  const logo = row({ id: "edge.store_logo", label: "Store logo", format: "300x300 px PNG.", satisfiedBy: "store-dashboard", status: "missing", dashboardTab: "Store listings" });

  it("reads you supply with the resize recipe, and the onboarding counts it as the person's, not the build's", () => {
    expect(DERIVED_SUFFIXES).not.toContain("store_logo");
    expect(supplyOf({ id: "edge.store_logo" })).toBe("you supply");
    expect(supplierOf(logo)).toBe("person-decides");

    const view = requirementsView({ store: "edge", items: [row({ id: "edge.name" }), logo], missingRequired: 1, missingOptional: 0 });
    const list = bringListOf("edge", view);
    if (!list) throw new Error("no list");

    expect(list.rows.find((r) => r.id === "edge.store_logo")).toMatchObject({ supply: "you supply", clearedBy: EDGE_STORE_LOGO_RECIPE });
    expect(list.say).toBe("Before Edge Add-ons reviews it, bring 1 required input. You supply: Store logo (300x300 px PNG.).");
    expect(list.say).not.toContain("From your build");
    expect(EDGE_STORE_LOGO_RECIPE).toContain("the 128 px icon sync-listing sends is the package icon, not the store logo");
  });

  it("412: names the Edge subsection and the Chrome fallback as what clears the single purpose and the permission reasons", () => {
    const view = requirementsView({
      store: "edge",
      items: [
        row({ id: "edge.single_purpose", label: "Single purpose description", satisfiedBy: "store-md: Single purpose", status: "missing", dashboardTab: "Privacy" }),
        row({ id: "edge.permission_justifications", label: "Permission justification", satisfiedBy: "store-md: Permissions justification", status: "missing", dashboardTab: "Privacy" }),
      ],
      missingRequired: 2,
      missingOptional: 0,
    });
    const list = bringListOf("edge", view);
    if (!list) throw new Error("no list");

    expect(list.rows[0]!.clearedBy).toBe("the `### Single purpose` subsection under `## Edge Add-ons` in STORE.md, or the one under `## Chrome Web Store` when Edge has none; sync-listing sends it");
    expect(list.rows[1]!.clearedBy).toBe("the `### Permissions justification` subsection under `## Edge Add-ons` in STORE.md, or the one under `## Chrome Web Store` when Edge has none; sync-listing sends it");
  });
});
