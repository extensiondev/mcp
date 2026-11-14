import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { schema, handler as releaseStatus } from "../tools/release-status";
import { writeCredentials } from "../lib/credentials";

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
  updatedAt: "2026-07-22T17:05:43.522Z",
  stores: {
    chrome: {
      ok: true,
      message: "Credentials verified.",
      checkedAt: "2026-07-22T17:05:43.522Z",
    },
    edge: {
      ok: false,
      message: "Unauthorized. The Edge API key may be expired.",
      checkedAt: "2026-07-22T17:05:43.522Z",
    },
    firefox: {
      ok: true,
      message: "Credentials verified.",
      checkedAt: "2026-07-22T17:05:43.522Z",
    },
  },
};

const EDGE_REFUSAL =
  "Edge did not take product 903d21e4 into review: the publish operation ended Failed (CreateNotAllowed: Can't create new extension.). Nothing is in certification review.";

const SUBMISSIONS = {
  updatedAt: "2026-07-22T17:25:05.000Z",
  submissions: [
    {
      id: "sub-old",
      store: "firefox",
      channel: "stable",
      storeSubmissionId: "111",
      version: "1.0.1",
      status: "approved",
      submittedAt: "2026-07-10T00:00:00.000Z",
      storeUrl: "https://addons.mozilla.org/firefox/addon/old",
    },
    {
      id: "sub-new",
      store: "firefox",
      channel: "stable",
      storeSubmissionId: "6369599",
      version: "1.0.2",
      status: "submitted",
      submittedAt: "2026-07-22T17:25:05.000Z",
      buildId: "0c7471e",
      storeUrl: "https://addons.mozilla.org/firefox/addon/probe",
    },
  ],
};

const SUBMISSIONS_WITH_REFUSED_EDGE = {
  ...SUBMISSIONS,
  submissions: [
    {
      id: "sub-edge",
      store: "edge",
      channel: "stable",
      storeSubmissionId: "op-63e9",
      version: "0.2.0",
      status: "draft",
      rawStatus: "draft",
      submittedAt: "2026-07-21T00:00:00.000Z",
      storeVersion: { packaged: "0.2.0.7", displayed: "0.2.0", source: "platform", buildNumber: 7 },
      storeReview: { state: "FAILED", checkedAt: "2026-07-21T00:05:00.000Z", source: "poll" },
      publish: { act: "publish", status: "failed", storeMessage: EDGE_REFUSAL, at: "2026-07-21T00:05:00.000Z" },
    },
    ...SUBMISSIONS.submissions,
  ],
};

const STATUS_V3 = {
  schemaVersion: 3,
  kind: "stores_status",
  updatedAt: "2026-07-22T18:00:00.000Z",
  lastSubmission: {
    store: "firefox",
    channel: "stable",
    buildSha: "0c7471e",
    version: "1.0.2",
    status: "submitted",
    storeUrl: "https://addons.mozilla.org/firefox/addon/probe",
    storeSubmissionId: "6369599",
    timestamp: "2026-07-22T17:25:08.746Z",
  },
  lastPoll: {
    timestamp: "2026-07-22T18:00:00.000Z",
    perStore: {},
    updates: [],
  },
  reviews: {
    firefox: {
      buildId: "0c7471e",
      version: "1.0.2",
      status: "pending",
      checkedAt: "2026-07-22T18:00:00.000Z",
    },
  },
};

describe("extension_release_status: registration + schema", () => {
  it("mirrors release_list's project override contract", () => {

    const props = Object.keys(
      (schema.inputSchema as { properties: Record<string, unknown> })
        .properties,
    );
    expect(props.sort()).toEqual(["api", "include", "project", "projectPath", "refresh", "releaseId", "since", "store", "submissionId", "waitSeconds", "workspace"]);
    expect((schema.inputSchema as { required: string[] }).required).toEqual([]);
  });

  it("describes itself as read-only", () => {
    expect(schema.description).toMatch(/read-only/i);
  });
});
