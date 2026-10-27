import { describe, expect, it } from "vitest";

import { actionFingerprint } from "../lib/approval-gate";
import { TOOL_POLICY } from "../lib/tool-policy";
import { handler as status } from "../tools/release-status";
import { handler as submit, schema } from "../tools/submit";
import { API, PROJECT_ROUTE, useProjectRoutes } from "./fixtures/project-routes";

const SUBMISSION = "sub_7f3a";
const CANCEL = `${PROJECT_ROUTE}/stores/chrome/submissions/${SUBMISSION}/cancel`;
const ROLLOUT = `${PROJECT_ROUTE}/stores/chrome/rollout`;
const PREFLIGHT = (store: string) => `${PROJECT_ROUTE}/stores/${store}/submissions/preflight`;
const APPROVALS = "/api/cli/approvals";

function approvalRequired(action: string, scope: Record<string, string>) {
  return {
    status: 403,
    body: { code: "APPROVAL_REQUIRED", message: "Needs an owner's approval.", approvalRequest: { action, scope, fingerprint: actionFingerprint(action, scope) } },
  };
}

function report(store: string, canSubmit: boolean) {
  return {
    store,
    summary: { pass: 9, warn: 1, fail: canSubmit ? 0 : 1, blockingFailures: canSubmit ? 0 : 1, canSubmit },
    submissionMode: store === "chrome" ? { id: "draft-until-public", label: "Draft until published", description: "New versions upload as a draft and are not published, until the Chrome Web Store reports this item as published.", rollout: "safe" } : undefined,
    checks: [
      { id: "credentials", label: "Store credentials", status: canSubmit ? "pass" : "fail", severity: "blocking", stage: "integration", ownership: "user", message: canSubmit ? "" : "CHROME_CLIENT_SECRET is missing." },
      { id: "privacy", label: "Privacy policy URL", status: "warn", severity: "advisory", stage: "review", ownership: "user", message: "No privacy policy URL." },
      { id: "manifest", label: "Manifest", status: "pass", severity: "blocking", stage: "integration", ownership: "platform" },
    ],
    prefill: { fields: [{ key: "description", label: "Description", value: "A long user-written text" }] },
  };
}

describe("extension_submit withdraws a submission, raises a staged rollout and checks readiness", () => {
  const platform = useProjectRoutes("extdev-store-acts-");

  it("offers the store acts beside submit, and only the ones that change what users get count as shipping", () => {
    expect(schema.inputSchema.properties.action.enum).toEqual(["submit", "preflight", "sync-listing", "cancel", "rollout", "publish", "review", "configure-store"]);
    expect(schema.inputSchema.required).toEqual([]);

    const ships = TOOL_POLICY.extension_submit.ships as (args: Record<string, unknown>) => boolean;

    expect(ships({ action: "cancel" })).toBe(true);
    expect(ships({ action: "rollout" })).toBe(true);
    expect(ships({ action: "publish" })).toBe(true);
    expect(ships({ action: "review" })).toBe(true);
    expect(ships({ action: "preflight" })).toBe(false);
    expect(ships({ action: "submit", dryRun: false })).toBe(true);
    expect(ships({ browsers: ["chrome"], buildSha: "abc" })).toBe(false);
  });

  it("cancel needs a submission id and asks nothing without one", async () => {
    const out = JSON.parse(await submit({ action: "cancel", api: API }));

    expect(out.status).toBe("bad-request");
    expect(platform.calls).toHaveLength(0);
  });

  it("cancel of a submission the store is not reviewing says how to find one that is", async () => {
    if (process.platform === "win32") return;

    platform.login();
    platform.routes[`POST ${CANCEL}`] = () => ({
      status: 409,
      body: { code: "SUBMISSION_NOT_IN_REVIEW", message: "This submission is not in review.", refusedBeforeApproval: true },
    });

    const out = JSON.parse(await submit({ action: "cancel", submissionId: SUBMISSION, api: API }));

    expect(platform.sent("POST", APPROVALS)).toHaveLength(0);
    expect(out.status).toBe("cancel-refused");
    expect(out.error.platformCode).toBe("SUBMISSION_NOT_IN_REVIEW");
    expect(out.hint).toContain("extension_release_status");
  });

  it("cancel asks for an approval of withdrawing exactly this submission", async () => {
    if (process.platform === "win32") return;

    platform.login();
    const scope = { store: "chrome", submissionId: SUBMISSION };
    platform.routes[`POST ${CANCEL}`] = () => approvalRequired("extension_store.cancel", scope);
    platform.routes[`POST ${APPROVALS}`] = () => ({ status: 201, body: { approvalId: "apr_c", approvalUrl: `${API}/approve/apr_c`, description: "Withdraw Chrome Web Store submission sub_7f3a from review." } });

    const out = JSON.parse(await submit({ action: "cancel", submissionId: SUBMISSION, api: API }));

    expect(platform.sent("POST", APPROVALS)[0].body.scope).toEqual(scope);
    expect(out.status).toBe("approval-required");
    expect(out.value.approvalUrl).toBe(`${API}/approve/apr_c`);
  });

  it("cancel approved answers with the dispatch and says where to read the outcome", async () => {
    if (process.platform === "win32") return;

    platform.login();
    platform.routes[`POST ${CANCEL}`] = () => ({ body: { ok: true, dispatched: true, store: "chrome", submissionId: SUBMISSION, storeSubmissionId: "cws_1", dispatchId: "d-1" } });

    const out = JSON.parse(await submit({ action: "cancel", submissionId: SUBMISSION, approvalId: "apr_c", api: API }));

    expect(platform.sent("POST", CANCEL)[0].body).toEqual({ approvalId: "apr_c" });
    expect(out.status).toBe("cancel-dispatched");
    expect(out.value.dispatchId).toBe("d-1");
    expect(out.value.trackUrl).toBeTruthy();
    expect(out.hint).toContain("extension_release_status");
  });

  it("cancel whose run failed at the store answers cancel-failed with the store's reason and the refund, never the run", async () => {
    if (process.platform === "win32") return;

    const reason = "NOT_CANCELLABLE: Your item 'bdio' does not have an active submission that can be cancelled.";
    platform.login();
    platform.routes[`POST ${CANCEL}`] = () => ({
      body: {
        ok: true,
        dispatched: true,
        store: "chrome",
        submissionId: SUBMISSION,
        storeSubmissionId: "cws_1",
        dispatchId: "d-1",
        dispatchedAt: "2026-10-23T18:03:01.248Z",
        dispatch: { dispatchId: "d-1", dispatchedAt: "2026-10-23T18:03:01.248Z", action: "cancel", runState: "queued" },
      },
    });

    platform.routes["GET /api/cli/stores/submissions"] = () => ({
      body: {
        submissions: [
          {
            id: SUBMISSION,
            store: "chrome",
            status: "draft",
            rawStatus: "no-active-submission",
            buildId: "111d167",
            version: "0.1.0",
            storeReview: { state: "PUBLISHED", checkedAt: "2026-10-23T18:20:00.000Z", source: "poll", visibility: "unlisted" },
            cancel: { act: "cancel", status: "failed", storeMessage: reason, at: "2026-10-23T18:20:00.000Z" },
            dispatch: {
              dispatchId: "d-1",
              dispatchedAt: "2026-10-23T18:03:01.248Z",
              action: "cancel",
              runState: "failed",
              failedStep: "Run the Chrome store action",
              failedReason: reason,
              refundedAt: "2026-10-23T18:10:00.000Z",
              workflowRunUrl: "https://github.com/extension-land/1--prj/actions/runs/9",
            },
          },
        ],
      },
    });

    const out = JSON.parse(await submit({ action: "cancel", submissionId: SUBMISSION, approvalId: "apr_c", api: API }));

    expect(out.status).toBe("cancel-failed");
    expect(out.ok).toBe(false);
    expect(out.value.dispatch).toEqual({ runState: "failed", failedStep: "Run the Chrome store action", failedReason: reason, refunded: true });
    expect(out.value.sayToPerson).toBe(`The withdrawal failed at the store: ${reason}. The approval was refunded. Say status to read the store's current state.`);
    expect(out.value.trackUrl).toBeTruthy();
    expect(JSON.stringify(out)).not.toMatch(/workflowRun|actions\/runs|1--prj/);
  });

  it("cancel for safari asks for an approval of removing that version from App Review, on the Safari route", async () => {
    if (process.platform === "win32") return;

    const route = `${PROJECT_ROUTE}/stores/safari/submissions/sub_11/cancel`;
    const scope = { store: "safari", submissionId: "sub_11" };
    platform.login();
    platform.routes[`POST ${route}`] = () => approvalRequired("extension_store.cancel", scope);
    platform.routes[`POST ${APPROVALS}`] = () => ({ status: 201, body: { approvalId: "apr_s", approvalUrl: `${API}/approve/apr_s`, description: "This removes Safari 0.2.0 (build 11) from App Review in App Store Connect." } });

    const out = JSON.parse(await submit({ action: "cancel", store: "safari", submissionId: "sub_11", api: API }));

    const asked = platform.sent("POST", APPROVALS)[0].body;
    expect(asked.scope).toEqual(scope);
    expect(asked.description).toBe("Remove Safari submission sub_11 from App Review.");
    expect(out.status).toBe("approval-required");
  });

  it("cancel for safari answers canceled once the record reads draft, with Apple's version state and the build kept on TestFlight", async () => {
    if (process.platform === "win32") return;

    const route = `${PROJECT_ROUTE}/stores/safari/submissions/sub_11/cancel`;
    platform.login();
    platform.routes[`POST ${route}`] = () => ({
      body: { ok: true, dispatched: true, store: "safari", submissionId: "sub_11", storeSubmissionId: "e38dbd34", version: "0.2.0", dispatchId: "d-s", dispatchedAt: "2026-10-27T21:00:00.000Z" },
    });

    platform.routes["GET /api/cli/stores/submissions"] = () => ({
      body: {
        submissions: [
          {
            id: "sub_11",
            store: "safari",
            status: "draft",
            rawStatus: "developer_rejected",
            buildId: "6d9e10c",
            version: "0.2.0",
            storeReview: { state: "DEVELOPER_REJECTED", checkedAt: "2026-10-27T21:01:00.000Z", source: "publish-answer" },
          },
        ],
      },
    });

    const out = JSON.parse(await submit({ action: "cancel", store: "safari", submissionId: "sub_11", approvalId: "apr_s", api: API }));

    expect(out.status).toBe("canceled");
    expect(out.value.outcome).toMatchObject({ recorded: true, status: "draft", storeState: "DEVELOPER_REJECTED" });
    expect(out.hint).toContain("App Store Connect reads the version as DEVELOPER_REJECTED, so it is out of App Review; its build stays on TestFlight");
  });

  it("cancel of a review the store already ended answers the store's state and asks for no approval", async () => {
    if (process.platform === "win32") return;

    platform.login();
    platform.routes[`POST ${CANCEL}`] = () => ({
      status: 409,
      body: {
        code: "SUBMISSION_NOT_CANCELLABLE",
        message: "The Chrome Web Store says PUBLISHED (unlisted) for this item, read 2026-10-23T18:20:00.000Z, so there is no review to withdraw.",
        state: "PUBLISHED",
        checkedAt: "2026-10-23T18:20:00.000Z",
        visibility: "unlisted",
        recordStatus: "draft",
        refusedBeforeApproval: true,
      },
    });

    const out = JSON.parse(await submit({ action: "cancel", submissionId: SUBMISSION, api: API }));

    expect(platform.sent("POST", APPROVALS)).toHaveLength(0);
    expect(out.status).toBe("store-not-reviewing");
    expect(out.value).toMatchObject({ state: "PUBLISHED", checkedAt: "2026-10-23T18:20:00.000Z", visibility: "unlisted", recordStatus: "draft", refusedBeforeApproval: true });
    expect(out.value.sayToPerson).toContain("no review to withdraw and no approval was requested");
    expect(out.hint).toContain("extension_release_status");
  });

  it("rollout takes a whole percentage from 1 to 100 and refuses anything else before asking", async () => {
    for (const deployPercentage of [0, 101, 12.5, undefined]) {
      const out = JSON.parse(await submit({ action: "rollout", deployPercentage, api: API }));

      expect(out.status).toBe("bad-request");
    }

    expect(platform.calls).toHaveLength(0);
  });

  it("rollout of a project that does not stage its Chrome release says where staging is turned on", async () => {
    if (process.platform === "win32") return;

    platform.login();
    platform.routes[`POST ${ROLLOUT}`] = () => ({
      status: 409,
      body: { code: "ROLLOUT_NOT_STAGED", message: "This project does not publish Chrome as a staged rollout.", refusedBeforeApproval: true },
    });

    const out = JSON.parse(await submit({ action: "rollout", deployPercentage: 50, api: API }));

    expect(platform.sent("POST", ROLLOUT)[0].body).toEqual({ deployPercentage: 50 });
    expect(out.status).toBe("rollout-refused");
    expect(out.hint).toContain("Staged publish");
  });

  it("rollout asks for an approval and says Chrome will not take it back down", async () => {
    if (process.platform === "win32") return;

    platform.login();
    const scope = { store: "chrome", deployPercentage: "50" };
    platform.routes[`POST ${ROLLOUT}`] = () => approvalRequired("extension_store.rollout", scope);
    platform.routes[`POST ${APPROVALS}`] = () => ({ status: 201, body: { approvalId: "apr_r", approvalUrl: `${API}/approve/apr_r` } });

    const out = JSON.parse(await submit({ action: "rollout", deployPercentage: 50, api: API }));

    expect(platform.sent("POST", APPROVALS)[0].body.scope).toEqual(scope);
    expect(out.status).toBe("approval-required");
    expect(out.error.message).toContain("irreversible");
  });

  it("preflight reads each store's readiness, asks for no approval and writes nothing", async () => {
    if (process.platform === "win32") return;

    platform.login();
    platform.routes[`POST ${PREFLIGHT("chrome")}`] = () => ({ body: report("chrome", false) });
    platform.routes[`POST ${PREFLIGHT("firefox")}`] = () => ({ body: report("firefox", true) });

    const out = JSON.parse(await submit({ action: "preflight", browsers: ["chrome", "firefox"], buildSha: "603fc8a", channel: "stable", api: API }));

    expect(platform.sent("POST", PREFLIGHT("chrome"))[0].body).toEqual({ buildId: "603fc8a", channel: "stable" });
    expect(platform.sent("POST", APPROVALS)).toHaveLength(0);
    expect(out.ok).toBe(true);
    expect(out.status).toBe("preflight-read");
    expect(out.value.stores.chrome).toMatchObject({ canSubmit: false, failing: [{ id: "credentials", message: "A store credential is missing." }] });
    expect(JSON.stringify(out)).not.toContain("CHROME_CLIENT_SECRET");
    expect(out.value.stores.chrome.warnings).toEqual([{ id: "privacy", label: "Privacy policy URL", severity: "advisory", message: "No privacy policy URL." }]);
    expect(out.value.stores.firefox.canSubmit).toBe(true);
    expect(JSON.stringify(out)).not.toContain("A long user-written text");
    expect(out.hint).toContain("chrome");
    expect(out.value.stores.chrome.submissionMode).toMatchObject({ id: "draft-until-public", label: "Draft until published" });
    expect(out.value.stores.chrome.submissionMode.fromHere).toBe("An upload from here stops at the draft under this mode.");
  });

  it("preflight names the saved submission mode in the hint once every check is green", async () => {
    if (process.platform === "win32") return;

    platform.login();
    platform.routes[`POST ${PREFLIGHT("chrome")}`] = () => ({ body: report("chrome", true) });

    const out = JSON.parse(await submit({ action: "preflight", browsers: ["chrome"], buildSha: "603fc8a", api: API }));

    expect(out.hint).toContain("chrome submission mode: Draft until published (draft-until-public)");
    expect(out.hint).toContain("An upload from here stops at the draft under this mode.");
    expect(out.value.nextStep.say).toContain("I upload it as a store draft");
  });

  it("preflight and the approval say the upload goes on to review when the saved Chrome mode publishes", async () => {
    if (process.platform === "win32") return;

    platform.login();
    const broad = report("chrome", true);
    broad.submissionMode = { id: "public", label: "Public publish", description: "Chrome submissions will use the default publish target and can go public after approval.", rollout: "broad" };
    platform.routes[`POST ${PREFLIGHT("chrome")}`] = () => ({ body: broad });
    platform.routes[`POST ${APPROVALS}`] = () => ({
      status: 201,
      body: { approvalId: "apr_broad", approvalUrl: `${API}/approve/apr_broad`, expiresAt: "2026-10-22T10:00:00.000Z" },
    });

    const pre = JSON.parse(await submit({ action: "preflight", browsers: ["chrome"], buildSha: "603fc8a", api: API }));

    expect(pre.value.stores.chrome.submissionMode.fromHere).toContain("goes on to review under this mode");
    expect(pre.value.nextStep.say).toContain(`Under the Chrome Web Store's saved mode "public" this upload goes on to review`);
    expect(pre.value.nextStep.say).not.toContain("as a store draft");

    const out = JSON.parse(await submit({ browsers: ["chrome"], buildSha: "603fc8a", dryRun: false, api: API }));

    expect(out.status).toBe("approval-required");
    expect(platform.sent("POST", APPROVALS)[0].body.description).toContain('for store review: the saved chrome mode "public" sends the upload on to review');
    expect(out.hint).toContain(`Under the Chrome Web Store's saved mode "public" this upload goes on to review`);
    expect(out.hint).not.toContain("Nothing goes to review until you publish.");
    expect(out.value.reviewPromise).toContain("goes on to review");
  });

  it("the approval for a draft upload names the draft, never store review", async () => {
    if (process.platform === "win32") return;

    platform.login();
    platform.routes[`POST ${PREFLIGHT("chrome")}`] = () => ({ body: report("chrome", true) });
    platform.routes[`POST ${APPROVALS}`] = () => ({
      status: 201,
      body: { approvalId: "apr_draft", approvalUrl: `${API}/approve/apr_draft`, expiresAt: "2026-10-22T10:00:00.000Z" },
    });

    const out = JSON.parse(await submit({ browsers: ["chrome"], buildSha: "603fc8a", dryRun: false, api: API }));

    expect(out.status).toBe("approval-required");
    const description = platform.sent("POST", APPROVALS)[0].body.description;
    expect(description).toContain("as a store draft: not published and not sent to review under the saved submission mode");
    expect(description).not.toContain("for store review");
    expect(out.hint).toContain("Nothing goes to review until you publish.");
  });

  it("preflight keeps the submit step for a draft mode while Chrome reviews another build, naming the review", async () => {
    if (process.platform === "win32") return;

    platform.login();
    platform.routes[`POST ${PREFLIGHT("chrome")}`] = () => ({ body: report("chrome", true) });
    platform.routes["GET /api/cli/stores/submissions"] = () => ({
      body: {
        submissions: [
          { id: SUBMISSION, store: "chrome", status: "submitted", buildId: "111d167", version: "0.1.0", submittedAt: "2026-10-20T12:36:16.000Z", storeReview: { state: "PENDING_REVIEW", checkedAt: "2026-10-21T18:00:27.000Z", source: "poll" } },
        ],
      },
    });

    const out = JSON.parse(await submit({ action: "preflight", browsers: ["chrome"], buildSha: "603fc8a", api: API }));

    expect(out.status).toBe("preflight-read");
    expect(out.value.stores.chrome.canSubmit).toBe(true);
    expect(out.value.chromeReview).toMatchObject({ submissionId: SUBMISSION, storeState: "PENDING_REVIEW" });
    expect(out.value.nextStep.kind).toBe("submit");
    expect(out.hint).toContain("enters no review");
    expect(out.hint).not.toContain("already reviewing");
  });

  it("preflight blocks nothing when the store's own state says there is no active submission", async () => {
    if (process.platform === "win32") return;

    platform.login();
    platform.routes[`POST ${PREFLIGHT("chrome")}`] = () => ({ body: report("chrome", true) });
    platform.routes["GET /api/cli/stores/submissions"] = () => ({
      body: {
        submissions: [
          { id: SUBMISSION, store: "chrome", status: "draft", rawStatus: "no-active-submission", buildId: "111d167", version: "0.1.0", submittedAt: "2026-10-20T12:36:16.000Z", storeReview: { state: "PUBLISHED", checkedAt: "2026-10-23T18:20:00.000Z", source: "poll", visibility: "unlisted" } },
        ],
      },
    });

    const out = JSON.parse(await submit({ action: "preflight", browsers: ["chrome"], buildSha: "603fc8a", api: API }));

    expect(out.value.chromeReview).toBeUndefined();
    expect(out.value.nextStep.kind).toBe("submit");
  });

  it("preflight answers done, not submit, while the platform records a Chrome review in progress and the saved mode would enter one", async () => {
    if (process.platform === "win32") return;

    platform.login();
    platform.routes[`POST ${PREFLIGHT("chrome")}`] = () => ({
      body: { ...report("chrome", true), submissionMode: { id: "public", label: "Public", description: "Published to everyone after review.", rollout: "broad" } },
    });

    platform.routes["GET /api/cli/stores/submissions"] = () => ({
      body: {
        submissions: [
          { id: SUBMISSION, store: "chrome", status: "submitted", buildId: "111d167", version: "0.1.0", submittedAt: "2026-10-20T12:36:16.000Z", storeReview: { state: "PENDING_REVIEW", checkedAt: "2026-10-21T18:00:27.000Z", source: "poll" } },
        ],
      },
    });

    const out = JSON.parse(await submit({ action: "preflight", browsers: ["chrome"], buildSha: "603fc8a", api: API }));

    expect(out.status).toBe("preflight-read");
    expect(out.value.stores.chrome.canSubmit).toBe(true);
    expect(out.value.chromeReview).toMatchObject({ submissionId: SUBMISSION, storeState: "PENDING_REVIEW", version: "0.1.0", since: "2026-10-20T12:36:16.000Z" });
    expect(out.value.nextStep.kind).toBe("done");
    expect(out.value.nextStep.say).toContain("already reviewing");
    expect(out.value.nextStep.say).toContain("sync-listing");
    expect(out.value.nextStep.url).toContain("/submissions/chrome");
    expect(out.hint).toContain("already reviewing");
    expect(platform.sent("POST", APPROVALS)).toHaveLength(0);
  });

  it("preflight offers the submit step again once the recorded review is over", async () => {
    if (process.platform === "win32") return;

    platform.login();
    platform.routes[`POST ${PREFLIGHT("chrome")}`] = () => ({ body: report("chrome", true) });
    platform.routes["GET /api/cli/stores/submissions"] = () => ({
      body: { submissions: [{ id: SUBMISSION, store: "chrome", status: "submitted", buildId: "111d167", storeReview: { state: "PUBLISHED" } }] },
    });

    const out = JSON.parse(await submit({ action: "preflight", browsers: ["chrome"], buildSha: "603fc8a", api: API }));

    expect(out.value.chromeReview).toBeUndefined();
    expect(out.value.nextStep.kind).toBe("submit");
  });

  it("the stores read keeps the platform's id of the latest submission, which cancel takes", async () => {
    if (process.platform === "win32") return;

    platform.login();
    platform.routes["GET /api/cli/stores/submissions"] = () => ({
      body: { submissions: [{ id: SUBMISSION, store: "chrome", status: "submitted", buildId: "603fc8a", channel: "stable", submittedAt: "2026-10-11T18:37:59.602Z" }] },
    });

    const out = JSON.parse(await status({ include: ["stores"], api: API }));
    const chrome = out.value.stores.value.stores.find((row: { store: string }) => row.store === "chrome");

    expect(chrome.lastSubmission).toMatchObject({ id: SUBMISSION, status: "submitted" });
  });

  it("a real submit still needs browsers and a build", async () => {
    platform.login();
    const out = JSON.parse(await submit({ api: API }));

    expect(out.status).toBe("bad-request");
  });
});
