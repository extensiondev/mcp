import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { writeCredentials } from "../lib/credentials";
import { readStores } from "../tools/store-status";
import { handler as submit } from "../tools/submit";

const API = "http://localhost:3100";
const PROJECT_ID = "prj_rebeccat";
const DISPATCHED_AT = "2026-10-30T17:22:50.000Z";
const LANDED_AT = "2026-10-30T17:23:17.475Z";
const BEFORE = "2026-10-30T16:14:31.000Z";

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    text: async () => JSON.stringify(body),
    json: async () => body,
  } as unknown as Response;
}

const safariRecord = (build: number, over: Record<string, unknown>): Record<string, unknown> => ({
  store: "safari",
  channel: "stable",
  storeVersion: { packaged: "0.2.0", displayed: "0.2.0", source: "repo", buildNumber: build },
  storeUrl: "https://apps.apple.com/app/id6826223107",
  ...over,
});

function platformRecords(readAt: string, statusRead = true): Array<Record<string, unknown>> {
  return [
    safariRecord(14, {
      id: "b40be3ae",
      version: "e679664",
      buildId: "e679664",
      status: "submitted",
      ...(statusRead ? { statusRead: { word: "submitted", readAt, source: "poll", storeWord: "WAITING_FOR_REVIEW" } } : {}),
      submittedAt: "2026-10-29T20:24:39Z",
      updatedAt: readAt,
      storeReview: { state: "WAITING_FOR_REVIEW", checkedAt: readAt, source: "poll" },
      publish: { act: "publish", status: "in-review", at: "2026-10-29T20:24:39Z", releaseType: "AFTER_APPROVAL" },
      run: null,
    }),
    safariRecord(13, {
      id: "52772ba0",
      version: "e679664",
      buildId: "e679664",
      status: "draft",
      statusRead: { word: "draft", readAt: "2026-10-29T20:25:16.512Z", source: "publish-answer", storeWord: "VALID" },
      submittedAt: "2026-10-27T19:40:39.597Z",
      run: null,
    }),
    safariRecord(11, {
      id: "c9fa9260",
      version: "6d9e10c",
      buildId: "6d9e10c",
      status: "withdrawn",
      statusRead: { word: "withdrawn", readAt: "2026-10-28T11:54:47Z", source: "publish-answer", storeWord: "DEVELOPER_REJECTED" },
      submittedAt: "2026-10-26T13:42:00.211Z",
      run: null,
    }),
  ];
}

function registryRow(readAt: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return safariRecord(14, {
    id: "sub-20261029203526",
    storeSubmissionId: "",
    version: "0.2.0",
    status: "submitted",
    rawStatus: "submitted",
    submittedAt: "2026-10-29T20:35:26.000Z",
    updatedAt: readAt,
    buildId: "e679664",
    storeReview: { state: "WAITING_FOR_REVIEW", checkedAt: readAt, source: "poll" },
    appStoreRelease: { type: "MANUAL", readAt },
    ...over,
  });
}

function statusDoc(pollAt: string): Record<string, unknown> {
  return {
    schemaVersion: 3,
    kind: "stores_status",
    updatedAt: pollAt,
    lastPoll: { timestamp: pollAt, perStore: {}, lanes: { safari: { ran: true, checked: 1, updated: 1, errors: 0 } }, updates: [] },
    reviews: {},
  };
}

const STORE_CONFIG = {
  chrome: { enabled: false, configured: false, credentialsConfigured: false, credentialsVerified: true, missingSecrets: [] },
  firefox: { enabled: false, configured: false, credentialsConfigured: false, credentialsVerified: true, missingSecrets: [] },
  edge: { enabled: false, configured: false, credentialsConfigured: false, credentialsVerified: true, missingSecrets: [] },
  safari: { enabled: true, configured: true, credentialsConfigured: true, credentialsVerified: true, missingSecrets: [] },
};

interface Served {
  registryRows: (readAt: string) => Array<Record<string, unknown>>;
  platform: (readAt: string) => Array<Record<string, unknown>>;
  at: (reads: number) => string;
}

const afterThreeReads = (reads: number): string => (reads >= 3 ? LANDED_AT : BEFORE);

function serve(served: Served): typeof fetch {
  let reads = 0;

  return (async (url: string, init?: RequestInit) => {
    const pathname = new URL(String(url)).pathname;
    const readAt = served.at(reads);

    if (pathname === `/api/projects/${PROJECT_ID}/stores/safari/poll` && init?.method === "POST") {
      return jsonResponse({ ok: true, dispatched: true, queued: false, dispatchedAt: DISPATCHED_AT, store: "safari" });
    }

    if (pathname === "/api/cli/whoami") return jsonResponse({ login: "cezaraugusto/rebeccat", live: true, projectId: PROJECT_ID });
    if (pathname === `/api/projects/${PROJECT_ID}/stores/config`) return jsonResponse(STORE_CONFIG);
    if (pathname === `/api/projects/${PROJECT_ID}/stores/safari/submissions`) return jsonResponse(served.platform(readAt));

    if (pathname === "/api/cli/stores/submissions") {
      reads += 1;

      return jsonResponse({ submissions: [...served.platform(served.at(reads))].reverse() });
    }

    if (pathname.endsWith("/stores/submissions")) return jsonResponse([]);

    if (pathname.endsWith("/_extension-dev/stores/health.json")) {
      return jsonResponse({ schemaVersion: 1, updatedAt: BEFORE, stores: { safari: { ok: true, message: "ok", checkedAt: BEFORE } } });
    }

    if (pathname.endsWith("/_extension-dev/stores/status.json")) return jsonResponse(statusDoc(readAt));

    if (pathname.endsWith("/_extension-dev/stores/submissions.json")) {
      return jsonResponse({ projectId: "cezaraugusto--rebeccat", updatedAt: readAt, submissions: served.registryRows(readAt) });
    }

    return jsonResponse({ message: "not found" }, 404);
  }) as unknown as typeof fetch;
}

function safariRow(out: { value: { stores: Array<Record<string, unknown>> } }): Record<string, unknown> {
  return out.value.stores.find((row) => row.store === "safari") ?? {};
}

describe("extension_submit status names the platform's record and its source once the store check lands", () => {
  let tmp: string;
  let prevXdg: string | undefined;
  let prevApi: string | undefined;
  let prevFetch: typeof fetch;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "extdev-status-landed-"));
    prevXdg = process.env.XDG_CONFIG_HOME;
    prevApi = process.env.EXTENSION_DEV_API_URL;
    delete process.env.EXTENSION_DEV_API_URL;
    process.env.XDG_CONFIG_HOME = tmp;
    prevFetch = global.fetch;
    writeCredentials({
      version: 1,
      token: "claims.sig",
      workspaceSlug: "cezaraugusto",
      projectSlug: "rebeccat",
      projectId: PROJECT_ID,
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

  it("answers the Rebeccat row with its submission id, the poll as source and watch as the next step", async () => {
    if (process.platform === "win32") return;

    global.fetch = serve({ registryRows: (at) => [registryRow(at)], platform: platformRecords, at: afterThreeReads });

    const out = JSON.parse(
      await submit({ action: "status", browsers: ["safari"], waitSeconds: 180, project: "cezaraugusto/rebeccat", api: API }),
    );

    expect(out.status).toBe("status-read");
    expect(out.value.refreshWait).toEqual({ landed: true, waitedSeconds: 20, stores: ["safari"] });
    expect(out.value.stores).toEqual([
      {
        store: "safari",
        submissionId: "b40be3ae",
        version: "0.2.0",
        buildNumber: 14,
        status: "submitted",
        state: "WAITING_FOR_REVIEW",
        readAt: LANDED_AT,
        source: "poll",
        releaseType: "MANUAL",
        nextStep: expect.objectContaining({ kind: "watch" }),
      },
    ]);

    expect(out.value.nextStep.kind).toBe("watch");
    expect(out.hint).toContain("landed within 20 s, so these are the states it read");
    expect(out.hint).toContain("safari 0.2.0 build 14: submitted, the store says WAITING_FOR_REVIEW (poll at 2026-10-30T17:23:17.475Z)");
    expect(out.hint).not.toContain("no store read behind it");
  });

  it("keeps the platform record as the store read's row and out of the earlier history", async () => {
    if (process.platform === "win32") return;

    global.fetch = serve({ registryRows: (at) => [registryRow(at)], platform: platformRecords, at: () => LANDED_AT });

    const row = safariRow(JSON.parse(await readStores({ project: "cezaraugusto/rebeccat", api: API })));
    const latest = row.lastSubmission as Record<string, unknown>;
    const history = row.submissionHistory as Array<{ id?: string }>;

    expect(latest).toMatchObject({
      id: "b40be3ae",
      version: "0.2.0",
      buildSha: "e679664",
      storeUrl: "https://apps.apple.com/app/id6826223107",
      statusRead: { word: "submitted", readAt: LANDED_AT, source: "poll", storeWord: "WAITING_FOR_REVIEW" },
      releaseType: "MANUAL",
    });

    expect(row.nextStep).toMatchObject({ kind: "watch" });
    expect(history.map((entry) => entry.id)).toEqual(["52772ba0", "c9fa9260"]);
  });

  it.each([
    ["another build of the same version", { id: "sub-20261030180000", buildId: "a1b2c3d", submittedAt: "2026-10-30T18:00:00.000Z" }],
    ["another build number of the same sha", { id: "sub-20261030180000", storeVersion: { packaged: "0.2.0", displayed: "0.2.0", source: "repo", buildNumber: 15 }, submittedAt: "2026-10-30T18:00:00.000Z" }],
  ])("lets a newer registry row of %s outrank the platform's older record", async (_label, over) => {
    if (process.platform === "win32") return;

    global.fetch = serve({
      registryRows: (at) => [registryRow(at, { status: "uploaded", storeReview: undefined, appStoreRelease: undefined, ...over })],
      platform: platformRecords,
      at: () => LANDED_AT,
    });

    const out = JSON.parse(await submit({ action: "status", browsers: ["safari"], project: "cezaraugusto/rebeccat", api: API }));

    expect(out.value.stores[0]).toMatchObject({ submissionId: null, status: "uploaded", state: null, source: null, nextStep: null });
    expect(out.hint).toContain("(no store read behind it)");
  });

  it("says the platform answered no source for a check that landed instead of calling it unread", async () => {
    if (process.platform === "win32") return;

    global.fetch = serve({ registryRows: (at) => [registryRow(at)], platform: (at) => platformRecords(at, false), at: afterThreeReads });

    const out = JSON.parse(
      await submit({ action: "status", browsers: ["safari"], waitSeconds: 180, project: "cezaraugusto/rebeccat", api: API }),
    );

    expect(out.value.refreshWait.landed).toBe(true);
    expect(out.value.stores[0]).toMatchObject({ submissionId: "b40be3ae", readAt: LANDED_AT, source: null, releaseType: "MANUAL", nextStep: null });
    expect(out.hint).toContain(
      `the store check this call asked for landed at ${LANDED_AT}, after its dispatch at ${DISPATCHED_AT}, but the platform answered no source for that read, so it grounds no next step`,
    );

    expect(out.hint).not.toContain("no store read behind it");
  });
});
