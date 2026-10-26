import { describe, expect, it } from "vitest";

import { EDGE_FIRST_SUBMISSION_STATE, firstSubmissionFromRefusal, publishRefusedMessage } from "../lib/edge-first-submission";
import { handler as submit } from "../tools/submit";
import { API, PROJECT_ROUTE, useProjectRoutes } from "./fixtures/project-routes";

const PRODUCT = "903d21e4-0e5b-4507-95f2-4620fcf06f1c";
const PRODUCT_URL = `https://partner.microsoft.com/dashboard/microsoftedge/${PRODUCT}/packages/dashboard`;
const PREFLIGHT = `POST ${PROJECT_ROUTE}/stores/edge/submissions/preflight`;
const PUBLISH = `${PROJECT_ROUTE}/stores/edge/publish`;
const STEPS = [
  "Open the product in Partner Center and complete its Store listings and Properties pages.",
  "Submit the draft version Partner Center holds (the hand-uploaded package) once; Partner Center certifies it.",
  "Turn on \"Submitted once in Partner Center\" on the project's Edge store settings, or let the platform read the first publish it records; every later version is then sent to review from here.",
];
const MICROSOFT =
  "Edge did not take product 903d21e4-0e5b-4507-95f2-4620fcf06f1c into review: the publish operation ended Failed (CreateNotAllowed: Can't create new extension.). Nothing is in certification review.";
const ROW = {
  id: "edge.first_submission",
  label: "First submission through Partner Center",
  required: true,
  decideOnce: true,
  format: "Partner Center requires a product's first submission through its dashboard; after that first publish the platform publishes through the API.",
  satisfiedBy: "console-only",
  how: `Open the product at ${PRODUCT_URL}, complete its listing there and submit the hand-uploaded package once.`,
  docs: "https://learn.microsoft.com/en-us/microsoft-edge/extensions/publish/api/using-addons-api",
  status: "missing",
  dashboardUrl: PRODUCT_URL,
};

function report(blocksSubmit: boolean) {
  return {
    store: "edge",
    summary: { pass: 8, warn: 0, fail: 0, canSubmit: true },
    checks: [],
    connection: { kind: "apiKey", connectedAs: PRODUCT, healthy: true, itemId: PRODUCT, itemLinked: true },
    storeConfig: { storeId: PRODUCT, submissionMode: { id: blocksSubmit ? "review" : "draft", label: blocksSubmit ? "Publish draft" : "Draft only", description: "" } },
    submissionMode: { id: blocksSubmit ? "review" : "draft", label: blocksSubmit ? "Publish draft" : "Draft only", description: "" },
    edgeFirstSubmission: { state: EDGE_FIRST_SUBMISSION_STATE, productId: PRODUCT, partnerCenterUrl: PRODUCT_URL, blocksSubmit, steps: STEPS },
  };
}

describe("a never-submitted Edge product is named before any approval", () => {
  const platform = useProjectRoutes("extdev-edge-first-");

  it("preflight answers first-submission-in-partner-center with the product page and the steps when the saved mode would publish", async () => {
    if (process.platform === "win32") return;

    platform.login();
    platform.routes[PREFLIGHT] = () => ({ body: report(true) });

    const out = JSON.parse(await submit({ action: "preflight", browsers: ["edge"], api: API }));

    expect(out.status).toBe(EDGE_FIRST_SUBMISSION_STATE);
    expect(out.value.partnerCenterUrl).toBe(PRODUCT_URL);
    expect(out.value.steps).toEqual(STEPS);
    expect(out.value.nextStep).toMatchObject({ kind: "dashboard", url: PRODUCT_URL });
    expect(out.value.nextStep.say).toContain("Partner Center requires the first submission of a new product through its dashboard: open the product, submit the draft there once; later versions publish from here.");
    expect(out.value.trackUrl).toMatch(/^https?:\/\//);
    expect(out.hint).toContain("Submitted once in Partner Center");
    expect(JSON.stringify(out)).not.toMatch(/STORE_EDGE_/);
  });

  it("preflight keeps a draft upload open and says the state beside the store when the saved mode stops at a draft", async () => {
    if (process.platform === "win32") return;

    platform.login();
    platform.routes[PREFLIGHT] = () => ({ body: report(false) });

    const out = JSON.parse(await submit({ action: "preflight", browsers: ["edge"], api: API }));

    expect(out.status).toBe("preflight-read");
    expect(out.value.stores.edge.firstSubmission).toMatchObject({ state: EDGE_FIRST_SUBMISSION_STATE, partnerCenterUrl: PRODUCT_URL, blocksSubmit: false });
    expect(out.hint).toContain(`Open the product at ${PRODUCT_URL}.`);
    expect(out.value.nextStep?.kind).toBe("submit");
  });

  it("never calls a store green beside a list that is not ready for review: the first submission row missing answers the dashboard and names the write that records it", async () => {
    if (process.platform === "win32") return;

    platform.login();
    platform.routes[PREFLIGHT] = () => ({
      body: {
        ...report(false),
        summary: { pass: 12, warn: 0, fail: 0, blockingFailures: 0, canSubmit: true },
        requirements: { store: "edge", items: [ROW], missingRequired: 1, missingOptional: 0, readyForReview: false, reviewBlockers: [ROW.id] },
      },
    });

    const out = JSON.parse(await submit({ action: "preflight", browsers: ["edge"], api: API }));

    expect(out.status).toBe("preflight-read");
    expect(out.value.stores.edge.readyForReview).toBe(false);
    expect(out.value.nextStep).toMatchObject({ kind: "dashboard", url: PRODUCT_URL });
    expect(out.value.nextStep.say).toContain('extension_submit action:"configure-store" store:"edge" storeSettings:{firstSubmitted:true}');
    expect(out.value.trackUrl).toMatch(/\/acme\/widget\/submissions$/);
    expect(out.hint).toContain("not ready for review");
    expect(JSON.stringify(out.value.nextStep)).not.toMatch(/Every check for/);
    expect(out.hint).not.toMatch(/Every store read here is ready to submit/);
    expect(JSON.stringify(out)).not.toMatch(/extension-user-land|\/actions\/runs\//);
  });

  it("names the missing inputs on the store settings page when the list is short of something other than the first submission", async () => {
    if (process.platform === "win32") return;

    platform.login();
    platform.routes[PREFLIGHT] = () => ({
      body: {
        ...report(false),
        edgeFirstSubmission: { state: "have", productId: PRODUCT, partnerCenterUrl: PRODUCT_URL, blocksSubmit: false, steps: [] },
        requirements: {
          store: "edge",
          items: [{ ...ROW, status: "have" }, { id: "edge.category", label: "Category", required: true, satisfiedBy: "store-md: Category", status: "missing" }],
          missingRequired: 1,
          missingOptional: 0,
          readyForReview: false,
          reviewBlockers: ["edge.category"],
        },
      },
    });

    const out = JSON.parse(await submit({ action: "preflight", browsers: ["edge"], api: API }));

    expect(out.value.nextStep.kind).toBe("configure");
    expect(out.value.nextStep.url).toMatch(/\/acme\/widget\/submissions$/);
    expect(out.value.nextStep.say).toContain("edge is not ready for review yet.");
  });

  it("a dry-run submit under the review mode answers the state as its verdict with the dashboard as the next step", async () => {
    if (process.platform === "win32") return;

    platform.login();
    platform.routes[PREFLIGHT] = () => ({ body: report(true) });
    platform.routes["POST /api/cli/stores/submit"] = () => ({ body: { ok: true, dryRun: true, buildId: "6d9e10c", message: "" } });

    const out = JSON.parse(await submit({ action: "submit", browsers: ["edge"], buildSha: "6d9e10c", api: API }));

    expect(out.value.verdict).toBe(EDGE_FIRST_SUBMISSION_STATE);
    expect(out.value.nextStep).toMatchObject({ kind: "dashboard", url: PRODUCT_URL });
    expect(out.value.preflight[0]).toMatchObject({ browser: "edge", ok: false, state: EDGE_FIRST_SUBMISSION_STATE, itemLinked: true });
  });

  it("publish relays the platform's refusal as the same state, never as a listing to sync, with no approval spent", async () => {
    if (process.platform === "win32") return;

    platform.login();
    let publishCalls = 0;

    platform.routes[`POST ${PUBLISH}`] = () => {
      publishCalls += 1;

      return {
        status: 409,
        body: {
          ok: false,
          code: "LISTING_INCOMPLETE",
          message: "Edge Add-ons asks for 1 more input before this can go to review: First submission through Partner Center. Nothing was sent and no approval was spent.",
          store: "edge",
          readyForReview: false,
          missingRequired: 1,
          rows: [ROW],
          state: EDGE_FIRST_SUBMISSION_STATE,
          partnerCenterUrl: PRODUCT_URL,
          steps: STEPS,
          refusedBeforeApproval: true,
        },
      };
    };

    const out = JSON.parse(await submit({ action: "publish", browsers: ["edge"], api: API }));

    expect(publishCalls).toBe(1);
    expect(out.ok).toBe(false);
    expect(out.status).toBe(EDGE_FIRST_SUBMISSION_STATE);
    expect(out.error).toMatchObject({ code: "E_PLATFORM", name: "FirstSubmissionInPartnerCenter", platformCode: "LISTING_INCOMPLETE" });
    expect(out.value.refusedBeforeApproval).toBe(true);
    expect(out.value.partnerCenterUrl).toBe(PRODUCT_URL);
    expect(out.value.steps).toEqual(STEPS);
    expect(out.value.nextStep).toMatchObject({ kind: "dashboard", url: PRODUCT_URL });
    expect(out.value.trackUrl).toBe("http://console.extension.localhost/acme/widget/submissions/edge");
    expect(JSON.stringify(out)).not.toMatch(/sync-listing|in review|on its way/);
  });

  it("reads the state from the row alone on an older refusal body", () => {
    expect(firstSubmissionFromRefusal({ code: "LISTING_INCOMPLETE" }, [ROW])).toEqual({ partnerCenterUrl: PRODUCT_URL, steps: [] });
    expect(firstSubmissionFromRefusal({ code: "LISTING_INCOMPLETE" }, [{ id: "edge.name" }])).toBeNull();
  });

  it("publish-failed maps Microsoft's CreateNotAllowed onto the first-submission advice with the product page", async () => {
    if (process.platform === "win32") return;

    platform.login();
    platform.routes[`POST ${PUBLISH}`] = () => ({
      body: { ok: true, dispatched: true, status: "publishing", store: "edge", submissionId: "d042b1f6", version: "0.2.0.7", buildId: "6d9e10c", itemId: PRODUCT, trackUrl: "https://console.extension.dev/acme/widget/submissions/edge/d042b1f6", dispatchedAt: "2026-10-26T18:17:10.000Z" },
    });

    platform.routes["GET /api/cli/stores/submissions"] = () => ({
      body: {
        submissions: [
          {
            id: "d042b1f6",
            store: "edge",
            status: "draft",
            storeReview: { state: "INPROGRESS", checkedAt: "2026-10-26T18:18:46.000Z", source: "publish-answer" },
            publish: { act: "publish", status: "failed", storeMessage: MICROSOFT, at: "2026-10-26T19:04:00.000Z" },
          },
        ],
      },
    });

    const out = JSON.parse(await submit({ action: "publish", browsers: ["edge"], approvalId: "apr_p", api: API }));

    expect(out.ok).toBe(false);
    expect(out.status).toBe("publish-failed");
    expect(out.error.name).toBe("FirstSubmissionInPartnerCenter");
    expect(out.error.message).toContain("Partner Center requires the first submission of a new product through its dashboard: open the product, submit the draft there once; later versions publish from here.");
    expect(out.error.message).toContain(`Open the product at ${PRODUCT_URL}.`);
    expect(out.error.message).toContain("CreateNotAllowed: Can't create new extension.");
    expect(out.value.partnerCenterUrl).toBe(PRODUCT_URL);
    expect(out.value.nextStep).toMatchObject({ kind: "dashboard", url: PRODUCT_URL });
    expect(out.hint).toContain("Submitted once in Partner Center");
    expect(JSON.stringify(out)).not.toMatch(/on its way/);
  });

  it("leaves any other refusal in the store's own words", () => {
    expect(publishRefusedMessage("the publish operation ended Failed (NoDraftPackage)", PRODUCT_URL)).toBe("the publish operation ended Failed (NoDraftPackage)");
  });
});
