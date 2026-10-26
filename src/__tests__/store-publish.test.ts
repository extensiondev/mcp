import { describe, expect, it } from "vitest";

import { actionFingerprint } from "../lib/approval-gate";
import { attachTrack } from "../lib/track-url";
import { handler as submit } from "../tools/submit";
import { API, PROJECT_ROUTE, useProjectRoutes } from "./fixtures/project-routes";

const PUBLISH = `${PROJECT_ROUTE}/stores/chrome/publish`;
const APPROVALS = "/api/cli/approvals";
const ITEM_URL = "https://chrome.google.com/webstore/devconsole/pub-1/abcdefghijklmnopabcdefghijklmnop/edit";
const TRACK_URL = "https://console.extension.dev/acme/widget/submissions/chrome/sub_2";
const SCOPE = { store: "chrome", submissionId: "sub_2" };

function approvalRequired() {
  return {
    status: 403,
    body: {
      code: "APPROVAL_REQUIRED",
      message: "Needs an owner's approval.",
      approvalRequest: { action: "extension_store.publish", scope: SCOPE, fingerprint: actionFingerprint("extension_store.publish", SCOPE) },
    },
  };
}

describe("extension_submit publish sends a Chrome draft to review after one approval", () => {
  const platform = useProjectRoutes("extdev-store-publish-");

  it("asks for an approval with its expiry and says what approving does", async () => {
    if (process.platform === "win32") return;

    platform.login();
    platform.routes[`POST ${PUBLISH}`] = () => approvalRequired();
    platform.routes[`POST ${APPROVALS}`] = () => ({
      status: 201,
      body: { approvalId: "apr_p", approvalUrl: `${API}/approve/apr_p`, expiresAt: "2026-10-19T18:15:00.000Z" },
    });

    const out = JSON.parse(await submit({ action: "publish", browsers: ["chrome"], api: API }));

    expect(platform.sent("POST", PUBLISH)[0].body).toEqual({});
    expect(platform.sent("POST", APPROVALS)[0].body).toMatchObject({ action: "extension_store.publish", scope: SCOPE });
    expect(out.status).toBe("approval-required");
    expect(out.value.expiresAt).toBe("2026-10-19T18:15:00.000Z");
    expect(out.value.approvalUrl).toBe(`${API}/approve/apr_p`);
    expect(out.error.message).toContain("This sends the item to Chrome's review.");
    expect(out.value.nextStep).toEqual({
      kind: "approve",
      say: `Approve it at ${API}/approve/apr_p before 2026-10-19T18:15:00.000Z. This sends the item to Chrome's review.`,
      url: `${API}/approve/apr_p`,
    });

    expect(out.hint).toContain("approvalId apr_p");
  });

  it("names the extension, version and build in the approval step when the platform minted a subject", async () => {
    if (process.platform === "win32") return;

    platform.login();
    platform.routes[`POST ${PUBLISH}`] = () => approvalRequired();
    platform.routes[`POST ${APPROVALS}`] = () => ({
      status: 201,
      body: {
        approvalId: "apr_p",
        approvalUrl: `${API}/approve/apr_p`,
        expiresAt: "2026-10-21T06:15:00.000Z",
        subject: { extension: "PII Shield", version: "0.1.0", storeVersion: "0.1.0.3", buildSha: "111d167", store: "chrome" },
      },
    });

    const out = JSON.parse(await submit({ action: "publish", browsers: ["chrome"], api: API }));

    expect(out.status).toBe("approval-required");
    expect(out.value.subject).toEqual({ extension: "PII Shield", version: "0.1.0", storeVersion: "0.1.0.3", buildSha: "111d167", store: "chrome" });
    expect(out.value.nextStep.say).toBe(
      `Approve sending PII Shield 0.1.0, build 111d167 to Chrome's review at ${API}/approve/apr_p before 2026-10-21T06:15:00.000Z. This sends the item to Chrome's review.`,
    );
  });

  it("keeps the approval and says try again when the platform refused the dispatch and gave the grant back", async () => {
    if (process.platform === "win32") return;

    platform.login();
    platform.routes[`POST ${PUBLISH}`] = () => ({
      status: 502,
      body: {
        code: "PUBLISH_DISPATCH_FAILED",
        message: "The platform could not start the Chrome review run, so nothing was sent to review: API rate limit exceeded. Nothing ran and your approval still stands; call again with the same approvalId.",
        approvalRefunded: true,
      },
    });

    const out = JSON.parse(await submit({ action: "publish", browsers: ["chrome"], approvalId: "apr_p", api: API }));

    expect(out.ok).toBe(false);
    expect(out.status).toBe("publish-refused");
    expect(out.value).toMatchObject({ approvalId: "apr_p", approvalRefunded: true, nextStep: { kind: "retry", url: null } });
    expect(out.value.nextStep.say).toContain("your approval still stands");
    expect(out.hint).toContain("call again with the same arguments and approvalId apr_p");
    expect(JSON.stringify(out.warnings ?? [])).not.toContain("may have spent");
    expect(platform.sent("POST", APPROVALS)).toHaveLength(0);
  });

  it("still warns that the grant may be spent when the platform could not prove nothing ran", async () => {
    if (process.platform === "win32") return;

    platform.login();
    platform.routes[`POST ${PUBLISH}`] = () => ({
      status: 502,
      body: { code: "PUBLISH_DISPATCH_FAILED", message: "The platform could not start the Chrome review run: socket hang up.", approvalRefunded: false },
    });

    const out = JSON.parse(await submit({ action: "publish", browsers: ["chrome"], approvalId: "apr_p", api: API }));

    expect(out.status).toBe("publish-refused");
    expect(out.value.approvalRefunded).toBeUndefined();
    expect(out.value.nextStep).toBeUndefined();
    expect(String(out.warnings?.[0] ?? "")).toContain("may have spent");
  });

  const dispatched = () => ({
    body: { ok: true, dispatched: true, status: "in-review", store: "chrome", submissionId: "sub_2", version: "1.0.1", buildId: "b418732", itemUrl: ITEM_URL, trackUrl: TRACK_URL, dispatchedAt: "2026-10-20T12:37:00.000Z" },
  });

  it("resumed with the approval id, answers publish-dispatched while the record carries no Chrome state, polling the record until the bound", async () => {
    if (process.platform === "win32") return;

    platform.login();
    platform.routes[`POST ${PUBLISH}`] = dispatched;
    platform.routes["GET /api/cli/stores/submissions"] = () => ({
      body: { submissions: [{ id: "sub_2", store: "chrome", status: "submitted", run: { status: "completed", conclusion: "success" } }] },
    });

    const out = JSON.parse(await submit({ action: "publish", browsers: ["chrome"], approvalId: "apr_p", waitSeconds: 10, api: API }));

    expect(platform.sent("POST", PUBLISH)[0].body).toEqual({ approvalId: "apr_p" });
    expect(platform.sent("POST", APPROVALS)).toHaveLength(0);
    expect(platform.sent("GET", "/api/cli/stores/submissions")).toHaveLength(3);
    expect(platform.sent("GET", "/api/cli/stores/submissions")[0].url).toContain("submissionId=sub_2");
    expect(out.ok).toBe(true);
    expect(out.status).toBe("publish-dispatched");
    expect(out.value).toMatchObject({ action: "publish", store: "chrome", submissionId: "sub_2", itemUrl: ITEM_URL, trackUrl: TRACK_URL });
    expect(out.value.outcome).toMatchObject({ recorded: false, status: "submitted", storeState: null, source: "platform-record", waitedSeconds: 10 });
    expect(out.value.links).toEqual([
      { kind: "submission", url: TRACK_URL, audience: "workspace members", expiresAt: null, made: false },
      { kind: "item", url: ITEM_URL, audience: "you", expiresAt: null, made: false },
    ]);

    expect(out.hint).toContain(`The platform accepted the act at 2026-10-20T12:37:00.000Z; its record has not confirmed the result yet. Watch ${TRACK_URL}; call extension_release_status (include: ["stores"]) to read it.`);
    expect(out.hint).toContain("Made: no new links.");
    expect(out.hint).not.toMatch(/\bin review\b|\bin-review\b/);
    expect(out.value.nextStep.kind).toBe("done");
    expect(out.value.nextStep.say).toContain("Nothing changes for current users until Chrome approves it.");
  });

  it("answers in-review with Chrome's own state once the record carries storeReview", async () => {
    if (process.platform === "win32") return;

    platform.login();
    platform.routes[`POST ${PUBLISH}`] = dispatched;
    let reads = 0;

    platform.routes["GET /api/cli/stores/submissions"] = () => {
      reads += 1;

      return {
        body: {
          submissions: [
            reads < 2
              ? { id: "sub_2", store: "chrome", status: "submitted" }
              : { id: "sub_2", store: "chrome", status: "submitted", storeReview: { state: "PENDING_REVIEW", checkedAt: "2026-10-20T12:38:00.000Z", source: "publish-answer" } },
          ],
        },
      };
    };

    const out = JSON.parse(await submit({ action: "publish", browsers: ["chrome"], approvalId: "apr_p", api: API }));

    expect(reads).toBe(2);
    expect(out.ok).toBe(true);
    expect(out.status).toBe("in-review");
    expect(out.value.outcome).toMatchObject({ recorded: true, status: "in-review", storeState: "PENDING_REVIEW", source: "platform-record", waitedSeconds: 5 });
    expect(out.hint).toContain("carries Chrome's own state, PENDING_REVIEW");
    expect(out.hint).toContain("Made: no new links.");
    expect(out.value.nextStep.kind).toBe("done");
  });

  it("answers publish-failed when the record reads failed", async () => {
    if (process.platform === "win32") return;

    platform.login();
    platform.routes[`POST ${PUBLISH}`] = dispatched;
    platform.routes["GET /api/cli/stores/submissions"] = () => ({
      body: { submissions: [{ id: "sub_2", store: "chrome", status: "failed", failureReason: "Chrome refused the package: version 1.0.1 already exists." }] },
    });

    const out = JSON.parse(await submit({ action: "publish", browsers: ["chrome"], approvalId: "apr_p", api: API }));

    expect(out.ok).toBe(false);
    expect(out.status).toBe("publish-failed");
    expect(out.value.outcome).toMatchObject({ recorded: true, status: "failed" });
    expect(out.error.message).toContain("version 1.0.1 already exists");
  });

  it("takes review as an alias for publish", async () => {
    if (process.platform === "win32") return;

    platform.login();
    platform.routes[`POST ${PUBLISH}`] = () => ({
      body: { ok: true, status: "in-review", submissionId: "sub_2", itemUrl: ITEM_URL, trackUrl: TRACK_URL },
    });

    const out = JSON.parse(await submit({ action: "review", browsers: ["chrome"], approvalId: "apr_p", waitSeconds: 0, api: API }));

    expect(platform.sent("POST", PUBLISH)).toHaveLength(1);
    expect(out.status).toBe("publish-dispatched");
    expect(out.value.outcome.readProblem).toContain("answered 404");
  });

  it("says a publish already on its way was not sent again, and never asks for an approval", async () => {
    if (process.platform === "win32") return;

    platform.login();
    platform.routes[`POST ${PUBLISH}`] = () => ({
      status: 409,
      body: {
        code: "PUBLISH_IN_FLIGHT",
        message: "A publish of this draft was dispatched at 2026-10-20T12:30:00.000Z and the record has not confirmed the store's answer yet, so it was not dispatched again. Read the submission page before trying again.",
        refusedBeforeApproval: true,
      },
    });

    const out = JSON.parse(await submit({ action: "publish", browsers: ["chrome"], api: API }));

    expect(out.ok).toBe(false);
    expect(out.status).toBe("publish-refused");
    expect(out.error.platformCode).toBe("PUBLISH_IN_FLIGHT");
    expect(out.error.message).toContain("Nothing ran and no approval was requested.");
    expect(out.hint).toContain("already on its way");
    expect(platform.sent("POST", APPROVALS)).toHaveLength(0);
  });

  it("answers upload-running with the build and the submissions page while the draft's upload run is still going", async () => {
    if (process.platform === "win32") return;

    platform.login();
    platform.routes[`POST ${PUBLISH}`] = () => ({
      status: 409,
      body: {
        code: "SUBMISSION_NOT_JOINABLE",
        message: "This Chrome Web Store draft (build 2bda5b2) has no store submission id yet because the upload is still running; publish when it lands. Nothing was sent to review.",
        uploadRunState: "running",
        submissionId: "sub_fresh",
        buildId: "2bda5b2",
        refusedBeforeApproval: true,
      },
    });

    const out = JSON.parse(await submit({ action: "publish", browsers: ["chrome"], api: API }));

    expect(out.ok).toBe(false);
    expect(out.status).toBe("upload-running");
    expect(out.error.platformCode).toBe("SUBMISSION_NOT_JOINABLE");
    expect(out.value.uploadRunState).toBe("running");
    expect(out.value.buildId).toBe("2bda5b2");
    expect(out.value.submissionId).toBe("sub_fresh");
    expect(out.value.sayToPerson).toBe("The upload for build 2bda5b2 is still running; say publish again when the status reads landed.");
    expect(out.value.trackUrl).toContain("/acme/widget/submissions/chrome");
    expect(out.value.nextStep.kind).toBe("publish");
    expect(out.hint).toContain("no approval was requested");
    expect(platform.sent("POST", APPROVALS)).toHaveLength(0);
  });

  it("keeps publish-refused for a draft the platform cannot join when no upload run is named", async () => {
    if (process.platform === "win32") return;

    platform.login();
    platform.routes[`POST ${PROJECT_ROUTE}/stores/edge/publish`] = () => ({
      status: 409,
      body: {
        code: "SUBMISSION_NOT_JOINABLE",
        message: "This Edge Add-ons draft carries no store submission id, so the result of sending it to review could not be recorded against it.",
        refusedBeforeApproval: true,
      },
    });

    const out = JSON.parse(await submit({ action: "publish", browsers: ["edge"], api: API }));

    expect(out.status).toBe("publish-refused");
    expect(out.value.uploadRunState).toBeUndefined();
    expect(out.hint).toContain("cannot tie this submission");
  });

  it("refuses an item that is not linked before anyone is asked, and says how to link it", async () => {
    if (process.platform === "win32") return;

    platform.login();
    platform.routes[`POST ${PUBLISH}`] = () => ({
      status: 409,
      body: { code: "STORE_ITEM_NOT_LINKED", message: "The Chrome Web Store item is not linked yet.", refusedBeforeApproval: true },
    });

    const out = JSON.parse(await submit({ action: "publish", browsers: ["chrome"], api: API }));

    expect(platform.sent("POST", APPROVALS)).toHaveLength(0);
    expect(out.ok).toBe(false);
    expect(out.status).toBe("store-item-not-linked");
    expect(out.error.platformCode).toBe("STORE_ITEM_NOT_LINKED");
    expect(out.value.nextStep.kind).toBe("link-item");
    expect(out.value.trackUrl).toContain("/acme/widget/");
  });

  it("refuses a project with no Chrome account connected before anyone is asked", async () => {
    if (process.platform === "win32") return;

    platform.login();
    platform.routes[`POST ${PUBLISH}`] = () => ({
      status: 409,
      body: { code: "STORE_NOT_CONNECTED", message: "This project is not connected to the Chrome Web Store yet.", refusedBeforeApproval: true },
    });

    const out = JSON.parse(await submit({ action: "publish", browsers: ["chrome"], api: API }));

    expect(platform.sent("POST", APPROVALS)).toHaveLength(0);
    expect(out.status).toBe("store-not-connected");
    expect(out.value.nextStep.kind).toBe("connect");
    expect(out.value.connectUrl).toContain("connect=chrome");
  });

  it("says how to get a draft when there is none to send", async () => {
    if (process.platform === "win32") return;

    platform.login();
    platform.routes[`POST ${PUBLISH}`] = () => ({
      status: 409,
      body: { code: "NO_CHROME_DRAFT", message: "There is no Chrome draft to send to review.", refusedBeforeApproval: true },
    });

    const out = JSON.parse(await submit({ action: "publish", browsers: ["chrome"], api: API }));

    expect(out.status).toBe("publish-refused");
    expect(out.hint).toContain("lands as a draft");
  });

  it("sends an Edge draft to certification review on the edge lane with Edge's words", async () => {
    if (process.platform === "win32") return;

    platform.login();
    const EDGE_PUBLISH = `${PROJECT_ROUTE}/stores/edge/publish`;
    platform.routes[`POST ${EDGE_PUBLISH}`] = () => ({
      body: { ok: true, dispatched: true, status: "in-review", store: "edge", submissionId: "sub_e1", version: "1.0.1", buildId: "b418732", itemUrl: "https://microsoftedge.microsoft.com/addons/detail/66666666-7777-8888-9999-000000000000", trackUrl: `${TRACK_URL.replace("chrome", "edge").replace("sub_2", "sub_e1")}`, dispatchedAt: "2026-10-20T18:00:00.000Z" },
    });

    platform.routes["GET /api/cli/stores/submissions"] = () => ({
      body: { submissions: [{ id: "sub_e1", store: "edge", status: "submitted", storeReview: { state: "INPROGRESS", checkedAt: "2026-10-20T18:00:05.000Z", source: "publish-answer" } }] },
    });

    const out = JSON.parse(await submit({ action: "publish", browsers: ["edge"], approvalId: "apr_e", waitSeconds: 0, api: API }));

    expect(platform.sent("POST", EDGE_PUBLISH)[0].body).toEqual({ approvalId: "apr_e" });
    expect(out.status).toBe("in-review");
    expect(out.value.store).toBe("edge");
    expect(out.value.outcome).toMatchObject({ recorded: true, storeState: "INPROGRESS" });
    expect(out.value.sayToPerson).toContain("Edge's certification review");
    expect(out.hint).not.toContain("Chrome");
  });

  it("asks for an Edge approval in Edge's words", async () => {
    if (process.platform === "win32") return;

    platform.login();
    const EDGE_PUBLISH = `${PROJECT_ROUTE}/stores/edge/publish`;
    const EDGE_SCOPE = { store: "edge", submissionId: "sub_e1" };
    platform.routes[`POST ${EDGE_PUBLISH}`] = () => ({
      status: 403,
      body: { code: "APPROVAL_REQUIRED", message: "Needs an owner's approval.", approvalRequest: { action: "extension_store.publish", scope: EDGE_SCOPE, fingerprint: actionFingerprint("extension_store.publish", EDGE_SCOPE) } },
    });

    platform.routes[`POST ${APPROVALS}`] = () => ({ status: 201, body: { approvalId: "apr_e", approvalUrl: `${API}/approve/apr_e`, expiresAt: "2026-10-21T06:15:00.000Z" } });

    const out = JSON.parse(await submit({ action: "publish", browsers: ["edge"], submissionId: "sub_e1", api: API }));

    expect(out.status).toBe("approval-required");
    expect(out.value.nextStep.say).toBe(`Approve it at ${API}/approve/apr_e before 2026-10-21T06:15:00.000Z. This sends the product to Edge's certification review.`);
    expect(platform.sent("POST", APPROVALS)[0].body).toMatchObject({ action: "extension_store.publish", scope: EDGE_SCOPE });
  });

  it("refuses firefox without calling the platform, since Firefox enters review when it is submitted", async () => {
    const out = JSON.parse(await submit({ action: "publish", browsers: ["firefox"], api: API }));

    expect(out.status).toBe("bad-request");
    expect(out.error.message).toContain('["safari"]');
    expect(platform.calls).toHaveLength(0);
  });

  const SAFARI_PUBLISH = `${PROJECT_ROUTE}/stores/safari/publish`;
  const ASC_URL = "https://appstoreconnect.apple.com/apps/6740000001/distribution";
  const SAFARI_TRACK = "https://console.extension.dev/acme/widget/submissions/safari/sub_s1";

  it("sends the App Store version holding the TestFlight build to App Review on the safari lane with Apple's words", async () => {
    if (process.platform === "win32") return;

    platform.login();
    platform.routes[`POST ${SAFARI_PUBLISH}`] = () => ({
      body: { ok: true, dispatched: true, status: "in-review", store: "safari", submissionId: "sub_s1", version: "0.2.0", buildId: "2bda5b2", itemUrl: ASC_URL, trackUrl: SAFARI_TRACK, dispatchedAt: "2026-10-26T12:00:00.000Z" },
    });

    platform.routes["GET /api/cli/stores/submissions"] = () => ({
      body: { submissions: [{ id: "sub_s1", store: "safari", status: "submitted", storeReview: { state: "WAITING_FOR_REVIEW", checkedAt: "2026-10-26T12:00:30.000Z", source: "publish-answer" } }] },
    });

    const out = JSON.parse(await submit({ action: "publish", browsers: ["safari"], approvalId: "apr_s", waitSeconds: 0, api: API }));

    expect(platform.sent("POST", SAFARI_PUBLISH)[0].body).toEqual({ approvalId: "apr_s" });
    expect(out.status).toBe("in-review");
    expect(out.value).toMatchObject({ store: "safari", submissionId: "sub_s1", trackUrl: SAFARI_TRACK, itemUrl: ASC_URL });
    expect(out.value.outcome).toMatchObject({ recorded: true, storeState: "WAITING_FOR_REVIEW" });
    expect(out.value.links).toEqual([
      { kind: "submission", url: SAFARI_TRACK, audience: "workspace members", expiresAt: null, made: false },
      { kind: "item", url: ASC_URL, audience: "you", expiresAt: null, made: false },
    ]);

    expect(out.value.sayToPerson).toContain("Apple's App Review");
    expect(out.hint).toContain("carries Apple's own state, WAITING_FOR_REVIEW");
    expect(out.hint).not.toContain("Chrome");
  });

  it("answers publish-dispatched for safari until the record carries Apple's state", async () => {
    if (process.platform === "win32") return;

    platform.login();
    platform.routes[`POST ${SAFARI_PUBLISH}`] = () => ({
      body: { ok: true, dispatched: true, status: "in-review", store: "safari", submissionId: "sub_s1", trackUrl: SAFARI_TRACK, dispatchedAt: "2026-10-26T12:00:00.000Z" },
    });

    platform.routes["GET /api/cli/stores/submissions"] = () => ({
      body: { submissions: [{ id: "sub_s1", store: "safari", status: "draft" }] },
    });

    const out = JSON.parse(await submit({ action: "publish", browsers: ["safari"], approvalId: "apr_s", waitSeconds: 0, api: API }));

    expect(out.status).toBe("publish-dispatched");
    expect(out.value.outcome).toMatchObject({ recorded: false, storeState: null });
    expect(out.hint).not.toMatch(/\bin review\b|\bin-review\b/);
    expect(out.hint).toContain(SAFARI_TRACK);
  });

  it("answers publish-failed with Apple's own refusal when the record reads failed", async () => {
    if (process.platform === "win32") return;

    platform.login();
    platform.routes[`POST ${SAFARI_PUBLISH}`] = () => ({
      body: { ok: true, dispatched: true, status: "in-review", store: "safari", submissionId: "sub_s1", trackUrl: SAFARI_TRACK },
    });

    platform.routes["GET /api/cli/stores/submissions"] = () => ({
      body: { submissions: [{ id: "sub_s1", store: "safari", status: "failed", failureReason: "App Store Connect refused to submit version 0.2.0 for review: appPrivacy: STATE_ERROR.ENTITY_STATE_INVALID: App Privacy must be answered before submitting." }] },
    });

    const out = JSON.parse(await submit({ action: "publish", browsers: ["safari"], approvalId: "apr_s", api: API }));

    expect(out.status).toBe("publish-failed");
    expect(out.error.message).toContain("Apple's App Review");
    expect(out.error.message).toContain("App Privacy must be answered");
  });

  it("asks for a Safari approval in Apple's words and keeps the release mode out of the act", async () => {
    if (process.platform === "win32") return;

    platform.login();
    const SAFARI_SCOPE = { store: "safari", submissionId: "sub_s1" };
    platform.routes[`POST ${SAFARI_PUBLISH}`] = () => ({
      status: 403,
      body: { code: "APPROVAL_REQUIRED", message: "Needs an owner's approval.", approvalRequest: { action: "extension_store.publish", scope: SAFARI_SCOPE, fingerprint: actionFingerprint("extension_store.publish", SAFARI_SCOPE) } },
    });

    platform.routes[`POST ${APPROVALS}`] = () => ({ status: 201, body: { approvalId: "apr_s", approvalUrl: `${API}/approve/apr_s`, expiresAt: "2026-10-27T06:15:00.000Z" } });

    const out = JSON.parse(await submit({ action: "publish", browsers: ["safari"], submissionId: "sub_s1", api: API }));

    expect(out.status).toBe("approval-required");
    expect(out.value.nextStep.say).toBe(
      `Approve it at ${API}/approve/apr_s before 2026-10-27T06:15:00.000Z. This sends the App Store version holding the TestFlight build to Apple's App Review; the release mode set in App Store Connect stays as it is.`,
    );

    expect(platform.sent("POST", APPROVALS)[0].body).toMatchObject({ action: "extension_store.publish", scope: SAFARI_SCOPE, description: "Send the App Store TestFlight build to review." });
  });
});

describe("the approval-required publish answer names the page to check for the store it acts on", () => {
  const platform = useProjectRoutes("extdev-store-publish-check-");

  for (const store of ["chrome", "edge", "safari"] as const) {
    it(`${store}: checkUrl is that store's submissions page, never another store's`, async () => {
      if (process.platform === "win32") return;

      platform.login();
      const scope = { store, submissionId: `sub_${store}` };
      platform.routes[`POST ${PROJECT_ROUTE}/stores/${store}/publish`] = () => ({
        status: 403,
        body: { code: "APPROVAL_REQUIRED", message: "Needs an owner's approval.", approvalRequest: { action: "extension_store.publish", scope, fingerprint: actionFingerprint("extension_store.publish", scope) } },
      });

      platform.routes[`POST ${APPROVALS}`] = () => ({ status: 201, body: { approvalId: `apr_${store}`, approvalUrl: `${API}/approve/apr_${store}`, expiresAt: "2026-10-27T06:15:00.000Z" } });

      const args = { action: "publish", browsers: [store], api: API };
      const out = JSON.parse(attachTrack("extension_submit", args, await submit(args)));

      expect(out.status).toBe("approval-required");
      expect(out.value.trackUrl).toBe(`${API}/approve/apr_${store}`);
      expect(out.value.checkUrl).toMatch(new RegExp(`/acme/widget/submissions/${store}$`));

      for (const other of ["chrome", "edge", "safari"].filter((name) => name !== store)) {
        expect(out.value.checkUrl).not.toContain(`/submissions/${other}`);
      }

      expect(out.hint).toContain(out.value.checkUrl);
    });
  }
});
