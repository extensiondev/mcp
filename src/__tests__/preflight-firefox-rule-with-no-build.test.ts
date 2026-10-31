import { describe, expect, it } from "vitest";

import { summaryAgreeingWithRows } from "../lib/preflight-summary";
import { handler as submit } from "../tools/submit";
import { API, PROJECT_ROUTE, useProjectRoutes } from "./fixtures/project-routes";

const PREFLIGHT = `${PROJECT_ROUTE}/stores/firefox/submissions/preflight`;
const RULE = "firefox.manifest_version_format";

const RULE_CHECK = {
  id: RULE,
  label: "Manifest version is a version string AMO accepts",
  status: "fail",
  severity: "blocking",
  message:
    'The manifest version "0.1.0.1-beta" is not a version string AMO accepts: 1 to 4 dot-separated numbers of up to nine digits, no leading zeros. Firefox 108 and later warn on install, and AMO refuses the upload.',
};

function report(options: { rule: boolean }) {
  const ruleCount = options.rule ? 1 : 0;

  return {
    store: "firefox",
    summary: {
      pass: 9,
      warn: 0,
      fail: 1,
      blockingFailures: 1 + ruleCount,
      integration: { pass: 5, fail: 1, blockingFailures: 1 + ruleCount, canQueue: false },
      review: { pass: 4, warn: 0, fail: 0, blockingFailures: 0, canSubmitForReview: !options.rule },
      canSubmit: false,
    },
    checks: [
      { id: "store.enabled", label: "Store publishing is enabled", status: "pass", severity: "blocking", stage: "integration" },
      { id: "store.credentials", label: "AMO API credentials are configured", status: "pass", severity: "blocking", stage: "integration" },
      {
        id: "submission.build_selected",
        label: "A build is selected",
        status: "fail",
        severity: "blocking",
        stage: "integration",
        message: "Name the build to submit.",
      },
      { id: "listing.firefox_summary_present", label: "Summary is present", status: "pass", severity: "blocking", stage: "review" },
    ],
    prefill: { fields: [] },
    requirements: {
      store: "firefox",
      items: [{ id: "firefox.name", label: "Name", required: true, format: "Up to 50 characters.", status: "have", satisfiedBy: "listing", how: "Set `- Name:` under `## Listing` in STORE.md." }],
      missingRequired: 0,
      missingOptional: 0,
      readyForReview: true,
      reviewBlockers: [],
    },
    ...(options.rule
      ? {
          firefoxPreflight: {
            act: "upload",
            channel: "unlisted",
            checks: [RULE_CHECK],
            blocking: [RULE],
            warnings: [],
            lock: null,
            inFlight: null,
            approval: "Upload sends the build to AMO's unlisted channel, where Mozilla signs it for self distribution without a review; nothing of this add-on is awaiting review.",
            nextVersion: null,
          },
        }
      : {}),
  };
}

describe("a blocking Firefox rule holds canSubmit when no build is named (Hands-free, ledger 321)", () => {
  const platform = useProjectRoutes("extdev-firefox-rule-no-build-");

  it("answers canSubmit false and counts the rule in the recounted integration summary", async () => {
    platform.login();
    platform.routes[`POST ${PREFLIGHT}`] = () => ({ body: report({ rule: true }) });

    const out = JSON.parse(await submit({ action: "preflight", browsers: ["firefox"], detail: true, api: API }));
    const firefox = out.value.stores.firefox;

    expect(firefox.summary.namedBySubmit).toEqual(["submission.build_selected"]);
    expect(firefox.canSubmit).toBe(false);
    expect(firefox.summary.canSubmit).toBe(false);
    expect(firefox.summary.integration).toMatchObject({ blockingFailures: 1, canQueue: false });
    expect(firefox.summary.blockingFailures).toBe(1);
    expect(firefox.summary.review).toMatchObject({ blockingFailures: 0, canSubmitForReview: false });
    expect(out.value.storePreflight.firefox.blocking).toEqual([RULE]);
    expect(out.hint).toContain("firefox cannot be submitted yet");
  });

  it("answers canSubmit true for the same report without the rule, since only the build is deferred to submit", async () => {
    platform.login();
    platform.routes[`POST ${PREFLIGHT}`] = () => ({ body: report({ rule: false }) });

    const out = JSON.parse(await submit({ action: "preflight", browsers: ["firefox"], detail: true, api: API }));
    const firefox = out.value.stores.firefox;

    expect(firefox.summary.namedBySubmit).toEqual(["submission.build_selected"]);
    expect(firefox.canSubmit).toBe(true);
    expect(firefox.summary).toMatchObject({ canSubmit: true, blockingFailures: 0, integration: { blockingFailures: 0, canQueue: true } });
    expect(out.hint).toContain("Every store read here is ready to submit.");
  });

  it("folds the rule into the recounted summary the way the platform folds it into its own", () => {
    const recounted = { pass: 3, warn: 0, fail: 0, blockingFailures: 0, integration: { pass: 2, fail: 0, blockingFailures: 0, canQueue: true }, review: { pass: 1, fail: 0, blockingFailures: 0, canSubmitForReview: true }, canSubmit: true };
    const json = report({ rule: true });
    const checks = json.checks.filter((check) => check.id !== "submission.build_selected") as Array<Record<string, unknown>>;

    const folded = summaryAgreeingWithRows({ summary: recounted, platform: json.summary, recounted: true, rows: null, checks, json, store: "firefox" });

    expect(folded).toMatchObject({
      canSubmit: false,
      blockingFailures: 1,
      integration: { blockingFailures: 1, canQueue: false },
      review: { blockingFailures: 0, canSubmitForReview: false },
    });

    const platformOwn = summaryAgreeingWithRows({ summary: json.summary, platform: json.summary, recounted: false, rows: null, checks, json, store: "firefox" });

    expect(platformOwn).toBe(json.summary);
  });
});
