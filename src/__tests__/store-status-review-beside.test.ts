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
});
