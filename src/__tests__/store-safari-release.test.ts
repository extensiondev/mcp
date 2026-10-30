import { describe, expect, it } from "vitest";

import { actionFingerprint } from "../lib/approval-gate";
import { handler as submit } from "../tools/submit";
import { API, PROJECT_ROUTE, useProjectRoutes } from "./fixtures/project-routes";

const RELEASE = `${PROJECT_ROUTE}/stores/safari/release`;
const APPROVALS = "/api/cli/approvals";
const SUBMISSIONS = "GET /api/cli/stores/submissions";
const SCOPE = { store: "safari", submissionId: "sub_14" };
const SENTENCE =
  "Release App Store version 0.2.0 (build 14) of Rebeccat, which Apple approved for manual release. App Store Connect last read it as PENDING_DEVELOPER_RELEASE on 2026-10-30. This puts the version on sale in the App Store now; it cannot be pulled back by the platform.";
const DISPATCHED_AT = "2026-10-30T12:00:00.000Z";

const accepted = {
  ok: true,
  dispatched: true,
  status: "releasing",
  store: "safari",
  submissionId: "sub_14",
  storeSubmissionId: "apple-build-14",
  version: "0.2.0",
  buildNumber: 14,
  trackUrl: `${API}/acme/rebeccat/submissions/safari/sub_14`,
  itemUrl: "https://appstoreconnect.apple.com/apps/6826223107/distribution",
  dispatchId: "d-release",
  dispatchedAt: DISPATCHED_AT,
  dispatch: { dispatchId: "d-release", dispatchedAt: DISPATCHED_AT, action: "release", runState: "queued" },
};

function record(extra: Record<string, unknown>) {
  return {
    body: {
      submissions: [
        {
          id: "sub_14",
          store: "safari",
          status: "approved",
          buildId: "6d9e10c",
          version: "0.2.0",
          storeVersion: { packaged: "0.2.0", displayed: "0.2.0", source: "repo", buildNumber: 14 },
          storeReview: { state: "PENDING_DEVELOPER_RELEASE", checkedAt: "2026-10-30T11:00:00.000Z", source: "poll" },
          ...extra,
        },
      ],
    },
  };
}

describe("extension_submit releases a Safari version Apple approved under manual release", () => {
  const platform = useProjectRoutes("extdev-store-release-");

  it("asks for an approval with the platform's own sentence and runs nothing", async () => {
    if (process.platform === "win32") return;

    platform.login();
    platform.routes[`POST ${RELEASE}`] = () => ({
      status: 403,
      body: {
        code: "APPROVAL_REQUIRED",
        message: "Needs an owner's approval.",
        approvalRequest: { action: "extension_store.release", scope: SCOPE, fingerprint: actionFingerprint("extension_store.release", SCOPE) },
      },
    });

    platform.routes[`POST ${APPROVALS}`] = () => ({
      status: 201,
      body: { approvalId: "apr_r", approvalUrl: `${API}/device/approve/apr_r`, description: SENTENCE },
    });

    const out = JSON.parse(await submit({ action: "release", browsers: ["safari"], api: API }));

    expect(platform.sent("POST", RELEASE)[0].body).toEqual({});
    expect(platform.sent("POST", APPROVALS)[0].body).toMatchObject({ action: "extension_store.release", scope: SCOPE });
    expect(out.status).toBe("approval-required");
    expect(JSON.stringify(out.value)).toContain(SENTENCE);
  });

  it("answers release-dispatched with the track URL while the record has not confirmed", async () => {
    if (process.platform === "win32") return;

    platform.login();
    platform.routes[`POST ${RELEASE}`] = () => ({ body: accepted });
    platform.routes[SUBMISSIONS] = () => record({});

    const out = JSON.parse(
      await submit({ action: "release", store: "safari", approvalId: "apr_r", waitSeconds: 0, api: API }),
    );

    expect(platform.sent("POST", RELEASE)[0].body).toEqual({ approvalId: "apr_r" });
    expect(out.status).toBe("release-dispatched");
    expect(out.value.outcome).toMatchObject({ recorded: false, source: "platform-record" });
    expect(out.value.trackUrl).toBe(accepted.trackUrl);
    expect(out.value.links.map((link: { kind: string }) => link.kind)).toEqual(["submission", "item"]);
    expect(JSON.stringify(out)).not.toMatch(/\breleased\b/);
  });

  it("answers released once the record carries Apple's READY_FOR_SALE read after the act", async () => {
    if (process.platform === "win32") return;

    platform.login();
    platform.routes[`POST ${RELEASE}`] = () => ({ body: accepted });
    platform.routes[SUBMISSIONS] = () =>
      record({
        storeReview: { state: "READY_FOR_SALE", checkedAt: "2026-10-30T12:00:20.000Z", source: "publish-answer" },
        publish: { act: "release", status: "released", storeMessage: "App Store Connect released version 0.2.0.", at: "2026-10-30T12:00:20Z" },
      });

    const out = JSON.parse(await submit({ action: "release", browsers: ["safari"], approvalId: "apr_r", api: API }));

    expect(out.status).toBe("released");
    expect(out.value.outcome).toMatchObject({
      recorded: true,
      status: "released",
      storeState: "READY_FOR_SALE",
      source: "platform-record",
    });

    expect(out.value.outcome.checkedAt).toBeTruthy();
    expect(out.value.trackUrl).toBe(accepted.trackUrl);
    expect(out.hint).toContain("on sale in the App Store");
  });

  it("answers released with Apple's in-between state when the lane recorded Apple's acceptance before the sale", async () => {
    if (process.platform === "win32") return;

    platform.login();
    platform.routes[`POST ${RELEASE}`] = () => ({ body: accepted });
    platform.routes[SUBMISSIONS] = () =>
      record({
        storeReview: { state: "PROCESSING_FOR_DISTRIBUTION", checkedAt: "2026-10-30T12:00:20.000Z", source: "publish-answer" },
        publish: { act: "release", status: "released", storeMessage: "App Store Connect took the release of version 0.2.0.", at: "2026-10-30T12:00:20Z" },
      });

    const out = JSON.parse(await submit({ action: "release", store: "safari", approvalId: "apr_r", api: API }));

    expect(out.status).toBe("released");
    expect(out.value.outcome).toMatchObject({ recorded: true, storeState: "PROCESSING_FOR_DISTRIBUTION" });
    expect(out.hint).toContain("the next store poll records when it reads READY_FOR_SALE");
  });

  it("never reads a sale recorded before the act as this release", async () => {
    if (process.platform === "win32") return;

    platform.login();
    platform.routes[`POST ${RELEASE}`] = () => ({ body: accepted });
    platform.routes[SUBMISSIONS] = () =>
      record({ storeReview: { state: "READY_FOR_SALE", checkedAt: "2026-10-30T11:59:00.000Z", source: "poll" } });

    const out = JSON.parse(
      await submit({ action: "release", store: "safari", approvalId: "apr_r", waitSeconds: 0, api: API }),
    );

    expect(out.status).toBe("release-dispatched");
  });

  it("answers release-failed in Apple's words when the lane recorded a refusal", async () => {
    if (process.platform === "win32") return;

    platform.login();
    platform.routes[`POST ${RELEASE}`] = () => ({ body: accepted });
    platform.routes[SUBMISSIONS] = () =>
      record({
        publish: {
          act: "release",
          status: "not-pending",
          storeMessage: "App Store Connect reads version 0.2.0 as READY_FOR_SALE, not waiting for a developer release, so nothing was released.",
          at: "2026-10-30T12:00:20Z",
        },
      });

    const out = JSON.parse(await submit({ action: "release", store: "safari", approvalId: "apr_r", api: API }));

    expect(out.status).toBe("release-failed");
    expect(out.ok).toBe(false);
    expect(out.error.message).toContain("not waiting for a developer release");
  });

  it("refuses before any approval, naming Apple's state, when no version waits for a developer release", async () => {
    if (process.platform === "win32") return;

    platform.login();
    platform.routes[`POST ${RELEASE}`] = () => ({
      status: 409,
      body: {
        code: "SAFARI_NOT_PENDING_RELEASE",
        message: "Safari 0.2.0 (build 14) was last read by App Store Connect as WAITING_FOR_REVIEW (2026-10-30), not PENDING_DEVELOPER_RELEASE, so Apple holds nothing to release.",
        state: "WAITING_FOR_REVIEW",
        checkedAt: "2026-10-30T11:00:00.000Z",
        version: "0.2.0",
        buildNumber: 14,
        refusedBeforeApproval: true,
      },
    });

    const out = JSON.parse(await submit({ action: "release", browsers: ["safari"], api: API }));

    expect(platform.sent("POST", APPROVALS)).toHaveLength(0);
    expect(out.status).toBe("release-refused");
    expect(out.error.platformCode).toBe("SAFARI_NOT_PENDING_RELEASE");
    expect(out.error.message).toContain("WAITING_FOR_REVIEW");
    expect(out.value).toMatchObject({ state: "WAITING_FOR_REVIEW", version: "0.2.0", buildNumber: 14, refusedBeforeApproval: true });
  });

  it("refuses before any approval when the App Store account is not connected", async () => {
    if (process.platform === "win32") return;

    platform.login();
    platform.routes[`POST ${RELEASE}`] = () => ({
      status: 409,
      body: {
        code: "STORE_NOT_CONNECTED",
        message: "This project is not connected to App Store Connect yet.",
        connectUrl: `${API}/acme/rebeccat/settings/stores?connect=safari`,
        refusedBeforeApproval: true,
      },
    });

    const out = JSON.parse(await submit({ action: "release", store: "safari", api: API }));

    expect(platform.sent("POST", APPROVALS)).toHaveLength(0);
    expect(out.error.platformCode).toBe("STORE_NOT_CONNECTED");
    expect(out.value.connectUrl).toContain("connect=safari");
  });

  it("refuses a store with no manual release before it calls the platform", async () => {
    const out = JSON.parse(await submit({ action: "release", browsers: ["chrome"], api: API }));

    expect(out.status).toBe("bad-request");
    expect(platform.calls).toHaveLength(0);
  });

  it("passes the build number the agent named and refuses one that is not a whole number before calling", async () => {
    if (process.platform === "win32") return;

    const bad = JSON.parse(await submit({ action: "release", browsers: ["safari"], buildNumber: "fourteen", api: API }));

    expect(bad.status).toBe("bad-request");
    expect(platform.calls).toHaveLength(0);

    platform.login();
    platform.routes[`POST ${RELEASE}`] = () => ({ body: accepted });
    platform.routes[SUBMISSIONS] = () => record({});

    await submit({ action: "release", browsers: ["safari"], buildNumber: 14, approvalId: "apr_r", waitSeconds: 0, api: API });

    expect(platform.sent("POST", RELEASE)[0].body).toEqual({ buildNumber: 14, approvalId: "apr_r" });
  });
});
