import { describe, expect, it } from "vitest";

import { actionFingerprint } from "../lib/approval-gate";
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

  it("refuses any store but chrome without calling the platform", async () => {
    const out = JSON.parse(await submit({ action: "publish", browsers: ["firefox"], api: API }));

    expect(out.status).toBe("bad-request");
    expect(platform.calls).toHaveLength(0);
  });
});
