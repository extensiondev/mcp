import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { writeCredentials } from "../lib/credentials";
import { storeReleaseSentence, storeReleaseView } from "../lib/platform-store-releases";
import { readStores as handler, safariReleaseStepSentence } from "../tools/store-status";

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

const READ_AT = "2026-10-30T11:00:00.000Z";

const HEALTH = {
  schemaVersion: 1,
  updatedAt: READ_AT,
  stores: { safari: { ok: true, message: "Credentials verified.", checkedAt: READ_AT } },
};

const APPROVED = { word: "approved", readAt: READ_AT, source: "poll", storeWord: "PENDING_DEVELOPER_RELEASE" };

const RECORD = {
  id: "sub_safari_14",
  store: "safari",
  channel: "stable",
  buildId: "e679664",
  version: "0.2.0",
  status: "approved",
  submittedAt: "2026-10-29T20:24:00.000Z",
  storeUrl: null,
  run: null,
  storeVersion: { packaged: "0.2.0", displayed: "0.2.0", source: "repo", buildNumber: 14 },
  storeReview: { state: "PENDING_DEVELOPER_RELEASE", checkedAt: READ_AT, source: "poll" },
  statusRead: APPROVED,
};

const ROW = {
  id: "safari:0.2.0",
  store: "safari",
  browser: "safari",
  version: "0.2.0",
  buildSha: "e679664",
  state: "approved",
  storeWord: "PENDING_DEVELOPER_RELEASE",
  readAt: READ_AT,
  source: "poll",
  storeVersion: { packaged: "0.2.0", displayed: "0.2.0", source: "repo", buildNumber: 14 },
  submissionId: "sub_safari_14",
  submittedAt: "2026-10-29T20:24:00.000Z",
  updatedAt: READ_AT,
  releaseType: "MANUAL",
  releaseTypeReadAt: READ_AT,
};

describe("a Safari version Apple approved for manual release names the Release act", () => {
  let tmp: string;
  let prevXdg: string | undefined;
  let prevFetch: typeof fetch;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "extdev-store-safari-approved-"));
    prevXdg = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = tmp;
    prevFetch = global.fetch;
    writeCredentials({
      version: 1,
      token: "claims.sig",
      workspaceSlug: "acme",
      projectSlug: "widget",
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      api: "https://www.extension.dev",
    });
  });

  afterEach(() => {
    if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prevXdg;

    global.fetch = prevFetch;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("reads the version approved, not in review, and says to release it", async () => {
    if (process.platform === "win32") return;

    global.fetch = fetchByFile({
      "stores/health.json": HEALTH,
      "/api/cli/stores/submissions": { ok: true, projectId: "prj_1", submissions: [RECORD] },
    });

    const out = JSON.parse(await handler({ workspace: "acme", project: "widget" }));

    expect(out.hint).toContain("last submission v0.2.0 approved (read from a store check");
    expect(out.hint).toContain(
      'Apple approved 0.2.0 (build 14) and holds it for your release (PENDING_DEVELOPER_RELEASE); to put it on sale, call extension_submit {action: "release", browsers: ["safari"]}',
    );

    expect(out.hint).not.toContain("v0.2.0 submitted");
  });

  it("grounds no release step on a word the platform inferred or on a version still in review", () => {
    const view = {
      version: "0.2.0",
      status: "approved",
      storeVersion: { packaged: "0.2.0", displayed: "0.2.0", source: "repo", buildNumber: 14 },
      storeReview: { state: "PENDING_DEVELOPER_RELEASE", checkedAt: READ_AT, source: "poll" as const },
    };

    expect(safariReleaseStepSentence({ ...view, statusRead: { ...APPROVED, source: "poll" } })).toContain(
      'extension_submit {action: "release", browsers: ["safari"]}',
    );

    expect(safariReleaseStepSentence({ ...view, statusRead: { ...APPROVED, source: "inferred" } })).toBe("");
    expect(safariReleaseStepSentence(view)).toBe("");
    expect(
      safariReleaseStepSentence({
        ...view,
        statusRead: { word: "submitted", readAt: READ_AT, source: "poll", storeWord: "WAITING_FOR_REVIEW" },
        storeReview: { state: "WAITING_FOR_REVIEW", checkedAt: READ_AT, source: "poll" },
      }),
    ).toBe("");
  });

  it("keeps an approved store release row and names the Release act beside it", () => {
    const row = storeReleaseView(ROW);

    expect(row?.state).toBe("approved");
    expect(storeReleaseSentence(row!)).toContain(
      'safari 0.2.0 (build 14) approved, set to manual release as App Store Connect answered 2026-10-30T11:00:00.000Z: approval holds it until you release it, waiting for your release with extension_submit {action: "release", browsers: ["safari"]}',
    );

    expect(storeReleaseSentence({ ...row!, source: "inferred" })).not.toContain("waiting for your release");
  });
});
