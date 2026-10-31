import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { requirementBlockersOf, summaryAgreeingWithRows } from "../lib/preflight-summary";
import { handler as submit } from "../tools/submit";
import { API, PROJECT_ROUTE, useProjectRoutes } from "./fixtures/project-routes";

const PREFLIGHT = `${PROJECT_ROUTE}/stores/firefox/submissions/preflight`;
const CHECK = "listing.firefox_categories_present";
const ROW = "firefox.categories";

const HEAD = `# Store metadata

## Listing

- Name: Hands-free
- Summary: Browse with your head and face.
- Description: Control web pages hands-free.
- License: MIT
- Support email: hello@extension.dev
`;

const FIREFOX_OTHER = `${HEAD}- Category: Accessibility

## Firefox Add-ons

- Category: Other (AMO has no Accessibility)
`;

const LISTING_TOOLS = `${HEAD}- Category: Tools
`;

const CATEGORY_HOW =
  "Set `- Category:` under `## Listing` in STORE.md to one of AMO's names, or put `- Category: <AMO category>` under `## Firefox Add-ons` when the shared category is one AMO lacks (Other is the closest); the listed upload writes it to the AMO add-on.";

function report(options: { buildSelected: boolean }) {
  return {
    store: "firefox",
    summary: {
      pass: 10,
      warn: 1,
      fail: options.buildSelected ? 1 : 2,
      blockingFailures: options.buildSelected ? 2 : 3,
      integration: { pass: 6, fail: options.buildSelected ? 1 : 2, blockingFailures: options.buildSelected ? 1 : 2, canQueue: false },
      review: { pass: 4, warn: 1, fail: 0, blockingFailures: 1, canSubmitForReview: false },
      canSubmit: false,
      requirementBlockers: [ROW],
    },
    checks: [
      { id: "store.enabled", label: "Store publishing is enabled", status: "fail", severity: "blocking", stage: "integration", message: "Turn on Firefox publishing in the console store settings." },
      {
        id: "submission.build_selected",
        label: "A build is selected",
        status: options.buildSelected ? "pass" : "fail",
        severity: "blocking",
        stage: "integration",
        message: "Name the build to submit.",
      },
      {
        id: CHECK,
        label: "At least one Firefox Add-ons category is selected",
        status: "warn",
        severity: "warning",
        stage: "review",
        expected: "At least 1 category from AMO's list",
        actual: "1 categories, none of them AMO's",
        message: "The category Accessibility of this project's Firefox listing is not a Firefox Add-ons category. An unlisted upload is signed for self distribution and sends no listing to AMO, so a category is only needed for a listed submission; before the channel goes listed, put `- Category: <AMO category>` under `## Firefox Add-ons` in STORE.md and run sync-listing for firefox.",
        fieldPath: "listing.categories",
      },
    ],
    prefill: { fields: [] },
    requirements: {
      store: "firefox",
      items: [
        { id: "firefox.name", label: "Name", required: true, format: "Up to 50 characters.", status: "have", satisfiedBy: "listing", how: "Set `- Name:` under `## Listing` in STORE.md." },
        {
          id: ROW,
          label: "Categories",
          required: true,
          format: "1 to 2 of AMO's own categories; AMO refuses the first listed version of an add-on with none.",
          status: "missing",
          satisfiedBy: "store-md: Category",
          how: CATEGORY_HOW,
          actual: "The category Accessibility of this project's Firefox listing is not a Firefox Add-ons category, and AMO refuses the first listed version of an add-on with no categories.",
        },
      ],
      missingRequired: 1,
      missingOptional: 0,
      readyForReview: false,
      reviewBlockers: [ROW],
    },
  };
}

function project(storeMd: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "extdev-firefox-category-"));
  fs.writeFileSync(path.join(root, "STORE.md"), storeMd);

  return root;
}

const byId = (rows: Array<Record<string, unknown>>, id: string) => rows.find((row) => row.id === id);

describe("the Firefox preflight answers one verdict on the category (ledger 321)", () => {
  const platform = useProjectRoutes("extdev-firefox-category-verdict-");

  it("drops the blocker the Firefox section's `- Category: Other` covers, and the review counts follow", async () => {
    if (process.platform === "win32") return;

    const root = project(FIREFOX_OTHER);
    platform.login();
    platform.routes[`POST ${PREFLIGHT}`] = () => ({ body: report({ buildSelected: false }) });

    const out = JSON.parse(await submit({ action: "preflight", browsers: ["firefox"], projectPath: root, detail: true, api: API }));
    const firefox = out.value.stores.firefox;

    expect(byId(firefox.requirements.items, ROW)).toMatchObject({
      status: "have",
      satisfiedBy: "store-md: - Category:",
      actual: "Other (from the Firefox Add-ons section) in STORE.md; sync-listing writes it",
    });

    expect(firefox.requirements.missingRequired).toBe(0);
    expect(firefox.summary.requirementBlockers).toBeUndefined();
    expect(firefox.summary.review).toMatchObject({ blockingFailures: 0, canSubmitForReview: true });
    expect(firefox.readyForReview).toBe(true);
    expect(firefox.summary.canSubmit).toBe(false);
    expect(byId(firefox.warnings, CHECK)?.message).toBe(
      "category Other (from the Firefox Add-ons section) found in STORE.md, not yet in the console listing; sync-listing writes it.",
    );

    expect(byId(firefox.warnings, CHECK)?.actual).toBe("1 categories, none of them AMO's");
    expect(JSON.stringify(firefox)).not.toContain("put `- Category: <AMO category>` under `## Firefox Add-ons` in STORE.md and run sync-listing");
  });

  it("keeps the blocker when STORE.md names a category AMO lacks, and names the line to add", async () => {
    if (process.platform === "win32") return;

    const root = project(LISTING_TOOLS);
    platform.login();
    platform.routes[`POST ${PREFLIGHT}`] = () => ({ body: report({ buildSelected: false }) });

    const out = JSON.parse(await submit({ action: "preflight", browsers: ["firefox"], projectPath: root, detail: true, api: API }));
    const firefox = out.value.stores.firefox;
    const unread = "the `- Category:` line in STORE.md names Tools, which Firefox Add-ons has no category for; put `- Category: <one of Alerts & Updates, Appearance, Bookmarks, Download Management, Feeds, News & Blogging, Games & Entertainment, Language Support, Photos, Music & Videos, Privacy & Security, Search Tools, Shopping, Social & Communication, Tabs, Web Development, Other>` under `## Firefox Add-ons`";

    expect(byId(firefox.requirements.items, ROW)).toMatchObject({ status: "missing", required: true, actual: unread });
    expect(firefox.requirements.missingRequired).toBe(1);
    expect(firefox.summary.requirementBlockers).toEqual([ROW]);
    expect(firefox.summary.review).toMatchObject({ blockingFailures: 1, canSubmitForReview: false });
    expect(firefox.readyForReview).toBe(false);
    expect(byId(firefox.warnings, CHECK)?.message).toBe(`${unread}.`);
  });

  it("counts a standing blocker again when the build-deferred recount dropped it, with no STORE.md to read", async () => {
    platform.login();
    platform.routes[`POST ${PREFLIGHT}`] = () => ({ body: report({ buildSelected: false }) });

    const out = JSON.parse(await submit({ action: "preflight", browsers: ["firefox"], detail: true, api: API }));
    const firefox = out.value.stores.firefox;

    expect(firefox.summary.namedBySubmit).toEqual(["submission.build_selected"]);
    expect(firefox.summary.requirementBlockers).toEqual([ROW]);
    expect(firefox.summary.review).toMatchObject({ blockingFailures: 1, canSubmitForReview: false });
    expect(firefox.summary.blockingFailures).toBe(2);
    expect(firefox.readyForReview).toBe(false);
  });

  it("subtracts a covered blocker from the platform's own counts when nothing was deferred", () => {
    const platformSummary = report({ buildSelected: true }).summary;
    const rows = [{ id: ROW, label: "Categories", required: true, format: "", status: "have" as const, satisfiedBy: "store-md: - Category:", how: "" }];
    const checks = report({ buildSelected: true }).checks as Array<Record<string, unknown>>;

    expect(requirementBlockersOf(platformSummary, rows)).toEqual([]);
    expect(requirementBlockersOf(platformSummary, null)).toEqual([ROW]);

    const summary = summaryAgreeingWithRows({ summary: platformSummary, platform: platformSummary, recounted: false, rows, checks, json: {}, store: "firefox" });

    expect(summary).toMatchObject({ blockingFailures: 1, canSubmit: false, review: { blockingFailures: 0, canSubmitForReview: true } });
    expect(summary).not.toHaveProperty("requirementBlockers");

    const forced = summaryAgreeingWithRows({ summary: platformSummary, platform: platformSummary, recounted: false, rows, checks, json: { firefoxPreflight: { blocking: ["firefox.version_increases"] } }, store: "firefox" });

    expect((forced.review as Record<string, unknown>).canSubmitForReview).toBe(false);
    expect(summaryAgreeingWithRows({ summary: platformSummary, platform: platformSummary, recounted: false, rows: null, checks, json: {}, store: "firefox" })).toBe(platformSummary);
  });
});
