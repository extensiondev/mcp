import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { reviewBesideSubmission, reviewSentence } from "../lib/review-beside-submission";
import { readStores as handler } from "../tools/store-status";

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    headers: { get: () => null },
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function fetchByFile(files: Record<string, unknown>): typeof fetch {
  return (async (url: string) => {
    for (const [suffix, body] of Object.entries(files)) {
      if (String(url).endsWith(suffix)) return jsonResponse(body);
    }

    return jsonResponse({ message: "not found" }, false, 404);
  }) as unknown as typeof fetch;
}

const HEALTH = {
  schemaVersion: 1,
  updatedAt: "2026-10-26T12:00:00.000Z",
  stores: { chrome: { ok: true, message: "Credentials verified.", checkedAt: "2026-10-26T12:00:00.000Z" } },
};

const CHROME_REVIEW = { buildId: "e4b8976", version: "0.1.0", status: "pending", checkedAt: "2026-10-26T12:00:31.000Z" };

const STATUS = {
  schemaVersion: 3,
  kind: "stores_status",
  updatedAt: "2026-10-26T12:00:31.000Z",
  lastPoll: { timestamp: "2026-10-26T12:00:31.000Z", perStore: {}, updates: [] },
  reviews: { chrome: CHROME_REVIEW },
};

const NEWER = {
  id: "22224c04",
  store: "chrome",
  channel: "stable",
  storeSubmissionId: "cws:x:6d9e10c:0.2.0",
  version: "0.2.0",
  status: "submitted",
  submittedAt: "2026-10-26T14:48:00.000Z",
  buildId: "6d9e10c",
};

describe("extension_release_status never shows the previous draft's review row beside a newer submission", () => {
  let tmp: string;
  let prevXdg: string | undefined;
  let prevFetch: typeof fetch;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "extdev-store-status-beside-"));
    prevXdg = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = tmp;
    prevFetch = global.fetch;
  });

  afterEach(() => {
    if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prevXdg;

    global.fetch = prevFetch;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("marks the row stale with the build it belongs to while the newer submission has no store answer", async () => {
    global.fetch = fetchByFile({
      "stores/health.json": HEALTH,
      "stores/status.json": STATUS,
      "stores/submissions.json": { updatedAt: NEWER.submittedAt, submissions: [NEWER] },
    });

    const out = JSON.parse(await handler({ workspace: "acme", project: "widget" }));
    const chrome = out.value.stores.find((r: { store: string }) => r.store === "chrome");

    expect(chrome.lastSubmission.buildSha).toBe("6d9e10c");
    expect(chrome.review).toEqual({
      ...CHROME_REVIEW,
      stale: true,
      staleReason: "this review line belongs to build e4b8976; the newer submission 6d9e10c has not been checked yet",
    });

    expect(out.hint).toContain(
      "review pending for build e4b8976 (checked 2026-10-26T12:00:31.000Z), stale: this review line belongs to build e4b8976; the newer submission 6d9e10c has not been checked yet",
    );
  });

  it("answers the newer submission's own store state, with the live item's beside it, once its record carries one", async () => {
    global.fetch = fetchByFile({
      "stores/health.json": HEALTH,
      "stores/status.json": STATUS,
      "stores/submissions.json": {
        updatedAt: NEWER.submittedAt,
        submissions: [{ ...NEWER, storeReview: { state: "PENDING_REVIEW", checkedAt: "2026-10-26T14:49:00.000Z", source: "publish-answer", liveState: "PUBLISHED" } }],
      },
    });

    const out = JSON.parse(await handler({ workspace: "acme", project: "widget" }));
    const chrome = out.value.stores.find((r: { store: string }) => r.store === "chrome");

    expect(chrome.review).toEqual({
      status: "pending",
      version: "0.2.0",
      buildId: "6d9e10c",
      checkedAt: "2026-10-26T14:49:00.000Z",
      storeState: "PENDING_REVIEW",
      liveState: "PUBLISHED",
      source: "publish-answer",
    });

    expect(out.hint).toContain("review pending (PENDING_REVIEW, live item PUBLISHED, checked 2026-10-26T14:49:00.000Z)");
  });

  it("keeps a row for the same build and reads the store's words into the poller's", () => {
    const review = { buildId: "0c7471e", status: "pending", checkedAt: "2026-07-22T18:00:00.000Z" };

    expect(reviewBesideSubmission(review, { buildSha: "0c7471e9f" })).toBe(review);
    expect(reviewBesideSubmission(review, undefined)).toBe(review);
    expect(reviewBesideSubmission(undefined, { buildSha: "6d9e10c" })).toBeUndefined();
    expect(reviewBesideSubmission(review, { buildSha: "6d9e10c", storeReview: { state: "PUBLISHED" } })).toMatchObject({ status: "approved", storeState: "PUBLISHED" });
    expect(reviewBesideSubmission(review, { buildSha: "6d9e10c", storeReview: { state: "REJECTED" } })).toMatchObject({ status: "rejected" });
    expect(reviewBesideSubmission(review, { buildSha: "6d9e10c", storeReview: { state: "NO_ACTIVE_SUBMISSION", liveState: "PUBLISHED" } })).toMatchObject({ status: "draft", liveState: "PUBLISHED" });
    expect(reviewBesideSubmission(review, { buildSha: "6d9e10c", storeReview: { state: "INPROGRESS" } })).toMatchObject({ status: "pending", storeState: "INPROGRESS" });
    expect(reviewSentence(review)).toBe("review pending (checked 2026-07-22T18:00:00.000Z)");
  });

  it("answers approved, never the poller's pending, once the same build's record is settled live", async () => {
    const pendingRow = { buildId: "6d9e10c", version: "0.2.0", status: "pending", checkedAt: "2026-10-27T16:51:00.000Z" };

    global.fetch = fetchByFile({
      "stores/health.json": HEALTH,
      "stores/status.json": { ...STATUS, reviews: { chrome: pendingRow } },
      "stores/submissions.json": {
        updatedAt: "2026-10-27T17:00:00.000Z",
        submissions: [
          {
            ...NEWER,
            status: "published",
            storeReview: { state: "PUBLISHED", checkedAt: "2026-10-27T17:00:00.000Z", source: "poll", liveState: "PUBLISHED" },
          },
        ],
      },
    });

    const out = JSON.parse(await handler({ workspace: "acme", project: "widget" }));
    const chrome = out.value.stores.find((r: { store: string }) => r.store === "chrome");

    expect(chrome.review).toEqual({
      status: "approved",
      version: "0.2.0",
      buildId: "6d9e10c",
      checkedAt: "2026-10-27T17:00:00.000Z",
      storeState: "PUBLISHED",
      liveState: "PUBLISHED",
      source: "poll",
    });

    expect(out.hint).toContain("review approved (PUBLISHED, live item PUBLISHED, checked 2026-10-27T17:00:00.000Z)");
    expect(out.hint).not.toContain("review pending");
  });

  it("answers a Firefox version AMO retired for a newer upload as superseded by that version, never rejected or pending", async () => {
    const pendingRow = { buildId: "e679664", version: "0.2.0", status: "pending", checkedAt: "2026-10-27T20:00:00.000Z" };

    global.fetch = fetchByFile({
      "stores/health.json": { ...HEALTH, stores: { firefox: { ok: true, message: "Credentials verified.", checkedAt: "2026-10-27T20:00:00.000Z" } } },
      "stores/status.json": { ...STATUS, reviews: { firefox: pendingRow } },
      "stores/submissions.json": {
        updatedAt: "2026-10-27T22:30:00.000Z",
        submissions: [
          {
            id: "e6796640",
            store: "firefox",
            channel: "stable",
            storeSubmissionId: "6100006",
            version: "0.2.0",
            status: "superseded",
            supersededBy: "0.2.0.7",
            submittedAt: "2026-10-27T19:00:00.000Z",
            buildId: "e679664",
            storeReview: { state: "DISABLED", checkedAt: "2026-10-27T22:30:00.000Z", source: "poll" },
          },
        ],
      },
    });

    const out = JSON.parse(await handler({ workspace: "acme", project: "widget" }));
    const firefox = out.value.stores.find((r: { store: string }) => r.store === "firefox");

    expect(firefox.lastSubmission).toMatchObject({ status: "superseded", supersededBy: "0.2.0.7" });
    expect(firefox.review).toMatchObject({ status: "superseded", storeState: "DISABLED", buildId: "e679664" });
    expect(out.hint).toContain("superseded at 2026-10-27T19:00:00.000Z (replaced by 0.2.0.7 before review, not rejected)");
    expect(out.hint).not.toMatch(/rejected at|review pending/);
  });

  it("lets the same build's own newer store answer win over the poller's row, and keeps the row when it is newer", () => {
    const row = { buildId: "6d9e10c", status: "pending", checkedAt: "2026-10-27T16:51:00.000Z" };
    const withdrawn = { state: "NO_ACTIVE_SUBMISSION", checkedAt: "2026-10-27T17:10:00.000Z", liveState: "PUBLISHED" };

    expect(reviewBesideSubmission(row, { buildSha: "6d9e10c", status: "submitted", storeReview: withdrawn })).toMatchObject({
      status: "draft",
      storeState: "NO_ACTIVE_SUBMISSION",
    });

    expect(reviewBesideSubmission(row, { buildSha: "6d9e10c", status: "submitted", storeReview: { ...withdrawn, checkedAt: "2026-10-27T16:00:00.000Z" } })).toBe(row);
    expect(reviewBesideSubmission(row, { buildSha: "6d9e10c", status: "rejected" })).toMatchObject({ status: "rejected", buildId: "6d9e10c" });
    expect(reviewBesideSubmission(row, { buildSha: "6d9e10c", status: "approved" })).toMatchObject({ status: "approved" });
  });
});
