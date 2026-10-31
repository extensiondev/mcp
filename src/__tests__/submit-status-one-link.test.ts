import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { writeCredentials } from "../lib/credentials";
import { attachTrack } from "../lib/track-url";
import { readStores } from "../tools/store-status";
import { handler as submit } from "../tools/submit";

const API = "http://localhost:3100";
const PROJECT_ID = "prj_rebeccat";
const READ_AT = "2026-10-31T01:01:29.054Z";
const SAFARI_PAGE = /\/cezaraugusto\/rebeccat\/submissions\/safari$/;
const SUBMISSIONS_PAGE = /\/cezaraugusto\/rebeccat\/submissions$/;

type Row = Record<string, unknown>;

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    text: async () => JSON.stringify(body),
    json: async () => body,
  } as unknown as Response;
}

const SAFARI_RECORD: Row = {
  id: "b40be3ae",
  store: "safari",
  channel: "stable",
  version: "e679664",
  buildId: "e679664",
  status: "submitted",
  storeVersion: { packaged: "0.2.0", displayed: "0.2.0", source: "repo", buildNumber: 14 },
  storeUrl: "https://apps.apple.com/app/id6826223107",
  statusRead: { word: "submitted", readAt: READ_AT, source: "poll", storeWord: "WAITING_FOR_REVIEW" },
  submittedAt: "2026-10-29T20:24:39Z",
  updatedAt: READ_AT,
  storeReview: { state: "WAITING_FOR_REVIEW", checkedAt: READ_AT, source: "poll" },
  publish: { act: "publish", status: "in-review", at: "2026-10-29T20:24:39Z", releaseType: "MANUAL" },
  run: null,
};

const STORE_CONFIG = {
  chrome: { enabled: false, configured: false, credentialsConfigured: false, credentialsVerified: true, missingSecrets: [] },
  firefox: { enabled: false, configured: false, credentialsConfigured: false, credentialsVerified: true, missingSecrets: [] },
  edge: { enabled: false, configured: false, credentialsConfigured: false, credentialsVerified: true, missingSecrets: [] },
  safari: { enabled: true, configured: true, credentialsConfigured: true, credentialsVerified: true, missingSecrets: [] },
};

function serve(): typeof fetch {
  return (async (url: string) => {
    const pathname = new URL(String(url)).pathname;

    if (pathname === "/api/cli/whoami") return jsonResponse({ login: "cezaraugusto/rebeccat", live: true, projectId: PROJECT_ID });
    if (pathname === `/api/projects/${PROJECT_ID}/stores/config`) return jsonResponse(STORE_CONFIG);
    if (pathname === `/api/projects/${PROJECT_ID}/stores/safari/submissions`) return jsonResponse([SAFARI_RECORD]);
    if (pathname === "/api/cli/stores/submissions") return jsonResponse({ submissions: [SAFARI_RECORD] });
    if (pathname.endsWith("/stores/submissions")) return jsonResponse([]);

    if (pathname.endsWith("/_extension-dev/stores/health.json")) {
      return jsonResponse({ schemaVersion: 1, updatedAt: READ_AT, stores: { safari: { ok: true, message: "ok", checkedAt: READ_AT } } });
    }

    return jsonResponse({ message: "not found" }, 404);
  }) as unknown as typeof fetch;
}

function consoleUrls(out: { value: Row }): string[] {
  const stores = Array.isArray(out.value.stores) ? (out.value.stores as Array<{ nextStep?: { url?: string } }>) : [];
  const step = out.value.nextStep as { url?: string } | null;

  return [...new Set([out.value.trackUrl, step?.url, ...stores.map((row) => row.nextStep?.url)].filter((url): url is string => typeof url === "string"))];
}

describe("extension_submit status about one store answers one console link, the store's own page", () => {
  let tmp: string;
  let prevXdg: string | undefined;
  let prevApi: string | undefined;
  let prevFetch: typeof fetch;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "extdev-status-one-link-"));
    prevXdg = process.env.XDG_CONFIG_HOME;
    prevApi = process.env.EXTENSION_DEV_API_URL;
    delete process.env.EXTENSION_DEV_API_URL;
    process.env.XDG_CONFIG_HOME = tmp;
    prevFetch = global.fetch;
    global.fetch = serve();
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

  it("a Safari-only status has one distinct console URL across trackUrl, nextStep.url and stores[0].nextStep.url, before and after the track fields", async () => {
    if (process.platform === "win32") return;

    const args = { action: "status", browsers: ["safari"], project: "cezaraugusto/rebeccat", api: API };
    const raw = await submit(args);
    const own = JSON.parse(raw);
    const tracked = JSON.parse(attachTrack("extension_submit", args, raw));

    expect(own.value.stores[0].nextStep.kind).toBe("watch");
    expect(consoleUrls(own)).toHaveLength(1);
    expect(consoleUrls(own)[0]).toMatch(SAFARI_PAGE);
    expect(consoleUrls(tracked)).toHaveLength(1);
    expect(consoleUrls(tracked)[0]).toMatch(SAFARI_PAGE);
  });

  it("a status with no store named that answers one store names that store's page too", async () => {
    if (process.platform === "win32") return;

    const args = { action: "status", project: "cezaraugusto/rebeccat", api: API };
    const raw = await submit(args);
    const tracked = JSON.parse(attachTrack("extension_submit", args, raw));

    expect(tracked.value.stores.map((row: Row) => row.store)).toEqual(["safari"]);
    expect(consoleUrls(tracked)).toHaveLength(1);
    expect(consoleUrls(tracked)[0]).toMatch(SAFARI_PAGE);
  });

  it("the full store read keeps the Submissions page for the whole picture and the Safari page on the Safari step", async () => {
    if (process.platform === "win32") return;

    const out = JSON.parse(await readStores({ project: "cezaraugusto/rebeccat", api: API }));
    const safari = out.value.stores.find((row: Row) => row.store === "safari");

    expect(out.value.consoleStoresUrl).toMatch(SUBMISSIONS_PAGE);
    expect(safari.nextStep.url).toMatch(SAFARI_PAGE);
  });
});
