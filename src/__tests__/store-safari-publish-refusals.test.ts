import { describe, expect, it } from "vitest";

import { shipRefusalHint } from "../lib/ship-act";
import { handler as submit } from "../tools/submit";
import { API, PROJECT_ROUTE, useProjectRoutes } from "./fixtures/project-routes";

const SAFARI_PUBLISH = `${PROJECT_ROUTE}/stores/safari/publish`;
const APPROVALS = "/api/cli/approvals";

describe("the draft refusal hints name the store of the call", () => {
  it("says a Safari draft, an Edge draft and a Chrome draft, never Chrome for every store", () => {
    expect(shipRefusalHint("SUBMISSION_NOT_DRAFT", undefined, "safari")).toMatch(/^Only a Safari draft can be sent to review\./);
    expect(shipRefusalHint("SUBMISSION_NOT_DRAFT", undefined, "edge")).toMatch(/^Only an Edge draft can be sent to review\./);
    expect(shipRefusalHint("SUBMISSION_NOT_DRAFT", undefined, "chrome")).toMatch(/^Only a Chrome draft can be sent to review\./);
    expect(shipRefusalHint("SUBMISSION_NOT_DRAFT")).toMatch(/^Only a Chrome draft/);
    expect(shipRefusalHint("NO_CHROME_DRAFT", undefined, "safari")).toContain('There is no Safari draft to send yet. Submit a build with extension_submit (browsers: ["safari"]');
  });
});

describe("extension_submit publish for Safari", () => {
  const platform = useProjectRoutes("extdev-safari-publish-refusals-");

  it("answers Rebeccat's failed 52772ba0 with the Safari hint and the platform's App Store message", async () => {
    if (process.platform === "win32") return;

    platform.login();
    platform.routes[`POST ${SAFARI_PUBLISH}`] = () => ({
      status: 409,
      body: {
        code: "SUBMISSION_NOT_DRAFT",
        message: "This submission reads failed, and only an App Store draft can be sent to review.",
        refusedBeforeApproval: true,
      },
    });

    const out = JSON.parse(await submit({ action: "publish", browsers: ["safari"], submissionId: "52772ba0-1e3c-4b64-9924-cbe59c3cc755", api: API }));

    expect(platform.sent("POST", APPROVALS)).toHaveLength(0);
    expect(out.status).toBe("publish-refused");
    expect(out.hint).toContain("Only a Safari draft can be sent to review.");
    expect(out.hint).not.toContain("Chrome");
    expect(out.error.message).toContain("only an App Store draft");
  });

  it("answers a newer unread build with its submission and number, and asks for no approval", async () => {
    if (process.platform === "win32") return;

    platform.login();
    platform.routes[`POST ${SAFARI_PUBLISH}`] = () => ({
      status: 409,
      body: {
        code: "SAFARI_NEWER_BUILD_UNREAD",
        message: "Build 13 of 0.2.0 (submission 52772ba0) is newer than build 11 of 0.2.0.",
        submissionId: "c9fa9260",
        newerSubmissionId: "52772ba0",
        newerBuildNumber: 13,
        refreshRequested: true,
        refusedBeforeApproval: true,
      },
    });

    const out = JSON.parse(await submit({ action: "publish", browsers: ["safari"], api: API }));

    expect(platform.sent("POST", APPROVALS)).toHaveLength(0);
    expect(out.status).toBe("publish-refused");
    expect(out.value).toMatchObject({ refusedBeforeApproval: true, newerSubmissionId: "52772ba0", newerBuildNumber: 13, refreshRequested: true });
    expect(out.hint).toContain("store poller to read that build back from App Store Connect");
  });
});

describe("extension_submit publish for Safari with the TestFlight build named", () => {
  const platform = useProjectRoutes("extdev-safari-publish-build-number-");

  it("sends buildNumber to the platform in place of a submission id and carries it in the answer", async () => {
    if (process.platform === "win32") return;

    platform.login();
    platform.routes[`POST ${SAFARI_PUBLISH}`] = () => ({
      status: 409,
      body: { code: "SAFARI_NEWER_BUILD", message: "Build 13 of 0.2.0 (submission 52772ba0) is a newer TestFlight draft than build 11 of 0.2.0.", submissionId: "c9fa9260", newerSubmissionId: "52772ba0", newerBuildNumber: 13, refusedBeforeApproval: true },
    });

    const out = JSON.parse(await submit({ action: "publish", browsers: ["safari"], buildNumber: 11, api: API }));

    expect(platform.sent("POST", SAFARI_PUBLISH)[0].body).toEqual({ buildNumber: 11 });
    expect(platform.sent("POST", APPROVALS)).toHaveLength(0);
    expect(out.status).toBe("publish-refused");
    expect(out.value).toMatchObject({ store: "safari", buildNumber: 11, newerBuildNumber: 13 });
  });

  it("answers a number no submission carries with the builds on record and no approval", async () => {
    if (process.platform === "win32") return;

    platform.login();
    platform.routes[`POST ${SAFARI_PUBLISH}`] = () => ({
      status: 409,
      body: { code: "SAFARI_BUILD_NOT_FOUND", message: "No Safari submission of this project carries TestFlight build 99.", buildNumber: 99, knownBuildNumbers: [13, 11], refusedBeforeApproval: true },
    });

    const out = JSON.parse(await submit({ action: "publish", browsers: ["safari"], buildNumber: 99, api: API }));

    expect(platform.sent("POST", APPROVALS)).toHaveLength(0);
    expect(out.status).toBe("publish-refused");
    expect(out.value).toMatchObject({ knownBuildNumbers: [13, 11], refusedBeforeApproval: true });
    expect(out.hint).toContain("value.knownBuildNumbers lists the builds on record");
  });

  it("refuses a build number for a Chrome or Edge publish, and a number that is not Apple's, before any request", async () => {
    if (process.platform === "win32") return;

    platform.login();

    const chrome = JSON.parse(await submit({ action: "publish", browsers: ["chrome"], buildNumber: 13, api: API }));
    const bad = JSON.parse(await submit({ action: "publish", browsers: ["safari"], buildNumber: "thirteen", api: API }));

    expect(chrome.ok).toBe(false);
    expect(chrome.error.message).toContain('buildNumber names a Safari TestFlight build and takes browsers ["safari"]');
    expect(bad.ok).toBe(false);
    expect(bad.error.message).toContain("a whole number above zero");
    expect(platform.sent("POST", `${PROJECT_ROUTE}/stores/chrome/publish`)).toHaveLength(0);
    expect(platform.sent("POST", SAFARI_PUBLISH)).toHaveLength(0);
  });

  it("names the withdrawal that clears a version Apple holds in review", () => {
    expect(shipRefusalHint("SAFARI_VERSION_IN_REVIEW", undefined, "safari")).toContain('extension_submit {action: "cancel", store: "safari", submissionId: value.heldSubmissionId}');
  });
});

describe("extension_submit cancel for Safari", () => {
  const platform = useProjectRoutes("extdev-safari-withdraw-states-");
  const route = `${PROJECT_ROUTE}/stores/safari/submissions/c9fa9260/cancel`;

  function withdrawn(storeReview: Record<string, unknown>) {
    platform.login();
    platform.routes[`POST ${route}`] = () => ({
      body: { ok: true, dispatched: true, store: "safari", submissionId: "c9fa9260", dispatchId: "d-w", dispatchedAt: "2026-10-28T11:54:10.945Z" },
    });

    platform.routes["GET /api/cli/stores/submissions"] = () => ({
      body: { submissions: [{ id: "c9fa9260", store: "safari", status: "draft", rawStatus: "complete", buildId: "6d9e10c", version: "6d9e10c", storeReview }] },
    });
  }

  it("names the version's DEVELOPER_REJECTED next to the review submission's COMPLETE", async () => {
    if (process.platform === "win32") return;

    withdrawn({ state: "DEVELOPER_REJECTED", checkedAt: "2026-10-28T11:55:00.000Z", source: "publish-answer", versionState: "DEVELOPER_REJECTED", reviewSubmissionState: "COMPLETE" });

    const out = JSON.parse(await submit({ action: "cancel", store: "safari", submissionId: "c9fa9260", approvalId: "apr_w", api: API }));

    expect(out.status).toBe("canceled");
    expect(out.value).toMatchObject({ versionState: "DEVELOPER_REJECTED", reviewSubmissionState: "COMPLETE" });
    expect(out.hint).toContain("App Store Connect reads the version as DEVELOPER_REJECTED and its App Review submission as COMPLETE");
  });

  it("never calls the review submission's COMPLETE the version's state", async () => {
    if (process.platform === "win32") return;

    withdrawn({ state: "COMPLETE", checkedAt: "2026-10-28T11:55:00.000Z", source: "publish-answer" });

    const out = JSON.parse(await submit({ action: "cancel", store: "safari", submissionId: "c9fa9260", approvalId: "apr_w", api: API }));

    expect(out.status).toBe("canceled");
    expect(out.hint).not.toContain("reads the version as COMPLETE");
    expect(out.hint).toContain("App Store Connect reads its App Review submission as COMPLETE; the version's own state is not recorded yet");
    expect(out.value.reviewSubmissionState).toBe("COMPLETE");
    expect(out.value.versionState).toBeUndefined();
  });
});
