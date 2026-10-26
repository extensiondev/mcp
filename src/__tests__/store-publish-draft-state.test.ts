import { describe, expect, it } from "vitest";

import { handler as submit } from "../tools/submit";
import { API, PROJECT_ROUTE, useProjectRoutes } from "./fixtures/project-routes";

const PUBLISH = `${PROJECT_ROUTE}/stores/chrome/publish`;
const ITEM_URL = "https://chrome.google.com/webstore/devconsole/pub-1/abcdefghijklmnopabcdefghijklmnop/edit";
const TRACK_URL = "https://console.extension.dev/acme/widget/submissions/chrome/sub_2";

const dispatched = () => ({
  body: { ok: true, dispatched: true, status: "in-review", store: "chrome", submissionId: "sub_2", version: "1.0.1", buildId: "b418732", itemUrl: ITEM_URL, trackUrl: TRACK_URL, dispatchedAt: "2026-10-20T12:37:00.000Z" },
});

describe("extension_submit publish answers the draft's own state, read after the act", () => {
  const platform = useProjectRoutes("extdev-store-publish-state-");

  it("never answers in-review from a review line checked before the act, and names the live item's state beside the draft's", async () => {
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
              ? { id: "sub_2", store: "chrome", status: "draft", storeReview: { state: "PUBLISHED", checkedAt: "2026-10-20T12:00:31.000Z", source: "poll", liveState: "PUBLISHED" } }
              : { id: "sub_2", store: "chrome", status: "submitted", storeReview: { state: "PENDING_REVIEW", checkedAt: "2026-10-20T12:38:00.000Z", source: "publish-answer", liveState: "PUBLISHED" } },
          ],
        },
      };
    };

    const out = JSON.parse(await submit({ action: "publish", browsers: ["chrome"], approvalId: "apr_p", api: API }));

    expect(reads).toBe(2);
    expect(out.status).toBe("in-review");
    expect(out.value.outcome).toMatchObject({ recorded: true, status: "in-review", storeState: "PENDING_REVIEW", liveState: "PUBLISHED", waitedSeconds: 5 });
    expect(out.hint).toContain("carries Chrome's own state for the draft, PENDING_REVIEW, so the draft is in Chrome's review; the item already live stays PUBLISHED until Chrome approves the draft.");
  });

  it("keeps answering publish-dispatched while the store holds nothing in review for the draft", async () => {
    if (process.platform === "win32") return;

    platform.login();
    platform.routes[`POST ${PUBLISH}`] = dispatched;
    platform.routes["GET /api/cli/stores/submissions"] = () => ({
      body: { submissions: [{ id: "sub_2", store: "chrome", status: "submitted", storeReview: { state: "NO_ACTIVE_SUBMISSION", checkedAt: "2026-10-20T12:38:00.000Z", source: "poll", liveState: "PUBLISHED" } }] },
    });

    const out = JSON.parse(await submit({ action: "publish", browsers: ["chrome"], approvalId: "apr_p", waitSeconds: 0, api: API }));

    expect(out.status).toBe("publish-dispatched");
    expect(out.value.outcome).toMatchObject({ recorded: false, storeState: null });
    expect(out.hint).not.toMatch(/\bin review\b|\bin-review\b/);
  });

  it("answers publish-failed with the store's own refusal when the draft's state after the act is a rejection", async () => {
    if (process.platform === "win32") return;

    platform.login();
    platform.routes[`POST ${PUBLISH}`] = dispatched;
    platform.routes["GET /api/cli/stores/submissions"] = () => ({
      body: { submissions: [{ id: "sub_2", store: "chrome", status: "submitted", storeReview: { state: "REJECTED", checkedAt: "2026-10-20T12:38:00.000Z", source: "poll", liveState: "PUBLISHED" } }] },
    });

    const out = JSON.parse(await submit({ action: "publish", browsers: ["chrome"], approvalId: "apr_p", waitSeconds: 0, api: API }));

    expect(out.ok).toBe(false);
    expect(out.status).toBe("publish-failed");
    expect(out.value.outcome).toMatchObject({ recorded: true, status: "rejected", storeState: "REJECTED", liveState: "PUBLISHED" });
  });
});
