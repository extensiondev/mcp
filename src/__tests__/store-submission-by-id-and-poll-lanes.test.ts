import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { handler as releaseStatus } from "../tools/release-status";
import { writeCredentials } from "../lib/credentials";

const API = "http://localhost:3100";
const PROJECT_ID = "prj_rebeccat";

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    text: async () => JSON.stringify(body),
    json: async () => body,
  } as unknown as Response;
}

function safari(build: number, id: string, day: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    store: "safari",
    channel: "stable",
    version: "e4b8976",
    buildId: "e4b8976",
    status: "draft",
    statusRead: { word: "draft", readAt: `${day}T12:00:00Z`, source: "poll", storeWord: "BUILD_NOT_IN_VERSION" },
    storeVersion: { packaged: "0.2.0", displayed: "0.2.0", source: "repo", buildNumber: build },
    storeReview: { state: "BUILD_NOT_IN_VERSION", checkedAt: `${day}T12:00:00Z`, source: "poll" },
    submittedAt: `${day}T10:00:00Z`,
    ...over,
  };
}

const SAFARI_RECORDS = [
  safari(14, "b40be3ae-0000-0000-0000-000000000014", "2026-10-29", { status: "submitted" }),
  safari(13, "52772ba0-0000-0000-0000-000000000013", "2026-10-27"),
  safari(12, "8f4d0170-0000-0000-0000-000000000012", "2026-10-27", { status: "failed" }),
  safari(11, "c9fa9260-0000-0000-0000-000000000011", "2026-10-26", { status: "withdrawn" }),
  safari(10, "e3e0ad12-9943-444e-be07-296e8ed606dc", "2026-10-25"),
  safari(9, "4df83b3c-0000-0000-0000-000000000009", "2026-10-24"),
  safari(1, "5093f86c-0000-0000-0000-000000000001", "2026-10-23"),
];

const UNLISTED_FIREFOX = {
  id: "a4933143-0000-0000-0000-000000000008",
  store: "firefox",
  channel: "preview",
  version: "069d4b8",
  buildId: "069d4b8",
  status: "approved",
  statusRead: { word: "signed", readAt: "2026-10-30T02:00:00Z", source: "poll", storeWord: "PUBLIC" },
  storeVersion: { packaged: "0.2.0.8", displayed: "0.2.0", source: "platform" },
  storeReview: { state: "PUBLIC", checkedAt: "2026-10-30T02:00:00Z", source: "poll", visibility: "unlisted" },
  submittedAt: "2026-10-29T19:02:00Z",
};

const ENABLED = { enabled: true, configured: true, credentialsConfigured: true, credentialsVerified: true, missingSecrets: [] };
const OFF = { enabled: false, configured: false, credentialsConfigured: false, credentialsVerified: true, missingSecrets: [] };

function statusDoc(lanes: Record<string, unknown>) {
  return {
    schemaVersion: 3,
    kind: "stores_status",
    updatedAt: "2026-10-30T01:05:37Z",
    lastPoll: { timestamp: "2026-10-30T01:05:37Z", perStore: {}, lanes, updates: [] },
    reviews: {},
  };
}

describe("extension_release_status reads any recorded submission by id and says what the last poll did per store", () => {
  let tmp: string;
  let prevXdg: string | undefined;
  let prevApi: string | undefined;
  let prevFetch: typeof fetch;
  let routes: Record<string, unknown>;
  let status: unknown;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "extdev-submission-by-id-"));
    prevXdg = process.env.XDG_CONFIG_HOME;
    prevApi = process.env.EXTENSION_DEV_API_URL;
    delete process.env.EXTENSION_DEV_API_URL;
    process.env.XDG_CONFIG_HOME = tmp;
    prevFetch = global.fetch;
    status = statusDoc({});
    routes = {
      "/api/cli/whoami": { login: "cezaraugusto/rebeccat", live: true, projectId: PROJECT_ID },
      [`/api/projects/${PROJECT_ID}/stores/config`]: { chrome: OFF, edge: OFF, firefox: ENABLED, safari: ENABLED },
      [`/api/projects/${PROJECT_ID}/stores/chrome/submissions`]: [],
      [`/api/projects/${PROJECT_ID}/stores/firefox/submissions`]: [UNLISTED_FIREFOX],
      [`/api/projects/${PROJECT_ID}/stores/edge/submissions`]: [],
      [`/api/projects/${PROJECT_ID}/stores/safari/submissions`]: SAFARI_RECORDS,
      "/api/cli/stores/submissions": { submissions: [...SAFARI_RECORDS, UNLISTED_FIREFOX] },
    };

    global.fetch = (async (url: string) => {
      const pathname = new URL(String(url)).pathname;

      if (pathname.endsWith("/_extension-dev/stores/status.json")) return jsonResponse(status);

      return pathname in routes ? jsonResponse(routes[pathname]) : jsonResponse({ message: "not found" }, 404);
    }) as unknown as typeof fetch;

    writeCredentials({
      version: 1,
      token: "claims.sig",
      workspaceSlug: "cezaraugusto",
      projectSlug: "rebeccat",
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      api: API,
    });
  });

  afterEach(() => {
    if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prevXdg;
    if (prevApi === undefined) delete process.env.EXTENSION_DEV_API_URL;
    else process.env.EXTENSION_DEV_API_URL = prevApi;

    global.fetch = prevFetch;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("answers a record older than the history shows, named by its short id", async () => {
    if (process.platform === "win32") return;

    const out = JSON.parse(await releaseStatus({ include: ["stores"], submissionId: "4df83b3c", api: API }));
    const stores = out.value.stores;
    const safariRow = stores.value.stores.find((row: { store: string }) => row.store === "safari");

    expect(safariRow.submissionHistory.map((entry: { id: string }) => entry.id)).not.toContain(
      "4df83b3c-0000-0000-0000-000000000009",
    );

    expect(stores.value.submission).toMatchObject({
      found: true,
      store: "safari",
      submission: { id: "4df83b3c-0000-0000-0000-000000000009", status: "draft", storeVersion: { buildNumber: 9 } },
    });

    expect(safariRow.submissionCount).toBe(7);
    expect(stores.hint).toContain("Submission 4df83b3c-0000-0000-0000-000000000009 (safari 0.2.0 build 9) reads draft");
    expect(stores.hint).toContain("7 submissions recorded, the newest 6 shown; read any one with submissionId");
  });

  it("reads a full id the lists do not carry from the platform's own record route", async () => {
    if (process.platform === "win32") return;

    routes[`/api/projects/${PROJECT_ID}/stores/safari/submissions/0ld0ne00-1111-2222-3333-444444444444`] = safari(
      2,
      "0ld0ne00-1111-2222-3333-444444444444",
      "2026-10-20",
      { status: "withdrawn" },
    );

    const out = JSON.parse(
      await releaseStatus({ include: ["stores"], submissionId: "0ld0ne00-1111-2222-3333-444444444444", api: API }),
    );

    expect(out.value.stores.value.submission).toMatchObject({
      found: true,
      store: "safari",
      submission: { status: "withdrawn", storeVersion: { buildNumber: 2 } },
    });
  });

  it("says the Firefox lane did not run, with the poll's reason", async () => {
    if (process.platform === "win32") return;

    status = statusDoc({ firefox: { ran: false, reason: "this mirror holds no AMO API credentials" } });

    const out = JSON.parse(await releaseStatus({ include: ["stores"], api: API }));

    expect(out.value.stores.hint).toContain(
      "the last store check at 2026-10-30T01:05:37Z did not run the firefox lane: this mirror holds no AMO API credentials",
    );
  });

  it("says the Firefox lane ran and wrote nothing, and carries the AMO channel on the record", async () => {
    if (process.platform === "win32") return;

    status = statusDoc({ firefox: { ran: true, checked: 1, updated: 0, errors: 0, versionsRead: 9 } });

    const out = JSON.parse(await releaseStatus({ include: ["stores"], submissionId: "a4933143", api: API }));
    const stores = out.value.stores;

    expect(stores.hint).toContain(
      "the last store check at 2026-10-30T01:05:37Z checked 1 firefox record, read 9 AMO versions and wrote nothing",
    );

    expect(stores.value.submission.submission).toMatchObject({ amoChannel: "unlisted", statusWord: "signed" });
  });

  it("reads an unlisted version AMO signed as signed, and keeps the review line on the listed version in review", async () => {
    if (process.platform === "win32") return;

    const listed = {
      id: "def49314-0000-0000-0000-000000000007",
      store: "firefox",
      channel: "stable",
      version: "069d4b8",
      buildId: "069d4b8",
      status: "submitted",
      statusRead: { word: "submitted", readAt: "2026-10-30T02:00:00Z", source: "poll", storeWord: "UNREVIEWED" },
      storeVersion: { packaged: "0.2.0.7", displayed: "0.2.0", source: "platform" },
      storeReview: { state: "UNREVIEWED", checkedAt: "2026-10-30T02:00:00Z", source: "poll", visibility: "listed" },
      submittedAt: "2026-10-27T22:28:00Z",
    };
    const unlistedRecorded = { ...UNLISTED_FIREFOX, status: "approved" };

    routes[`/api/projects/${PROJECT_ID}/stores/firefox/submissions`] = [unlistedRecorded, listed];
    routes["/api/cli/stores/submissions"] = { submissions: [...SAFARI_RECORDS, listed, unlistedRecorded] };

    const out = JSON.parse(await releaseStatus({ include: ["stores"], api: API }));
    const hint = String(out.value.stores.hint);

    expect(hint).toContain("last submission v0.2.0.8 signed");
    expect(hint).toContain("review pending (UNREVIEWED");
    expect(hint).not.toContain("approved (PUBLIC");
  });
});
