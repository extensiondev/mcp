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

const SAFARI = (
  build: number,
  over: Record<string, unknown>,
): Record<string, unknown> => ({
  store: "safari",
  channel: "stable",
  storeVersion: { packaged: "0.2.0", displayed: "0.2.0", source: "repo", buildNumber: build },
  storeUrl: "https://apps.apple.com/app/id6826223107",
  ...over,
});

const SAFARI_RECORDS = [
  SAFARI(14, {
    id: "b40be3ae",
    version: "e679664",
    buildId: "e679664",
    status: "submitted",
    statusRead: { word: "submitted", readAt: "2026-10-29T20:35:26.327Z", source: "poll", storeWord: "WAITING_FOR_REVIEW" },
    submittedAt: "2026-10-29T20:24:39Z",
    updatedAt: "2026-10-29T20:35:51Z",
    storeReview: { state: "WAITING_FOR_REVIEW", checkedAt: "2026-10-29T20:35:26.327Z", source: "poll" },
    publish: {
      act: "publish",
      status: "in-review",
      at: "2026-10-29T20:24:39Z",
      releaseType: "AFTER_APPROVAL",
      storeMessage: "App Store Connect took version 0.2.0 (build 14) into App Review.",
    },
  }),
  SAFARI(13, {
    id: "52772ba0",
    version: "e679664",
    buildId: "e679664",
    status: "draft",
    statusRead: { word: "draft", readAt: "2026-10-29T20:25:16.512Z", source: "publish-answer", storeWord: "VALID" },
    submittedAt: "2026-10-27T19:40:39.597Z",
    updatedAt: "2026-10-29T20:25:50Z",
  }),
  SAFARI(11, {
    id: "c9fa9260",
    version: "6d9e10c",
    buildId: "6d9e10c",
    status: "withdrawn",
    statusRead: { word: "withdrawn", readAt: "2026-10-28T11:54:47Z", source: "publish-answer", storeWord: "DEVELOPER_REJECTED" },
    submittedAt: "2026-10-26T13:42:00.211Z",
    updatedAt: "2026-10-29T20:35:47Z",
  }),
];

const STORE_CONFIG = {
  chrome: { enabled: false, configured: false, credentialsConfigured: false, credentialsVerified: true, missingSecrets: [] },
  firefox: { enabled: false, configured: false, credentialsConfigured: false, credentialsVerified: true, missingSecrets: [] },
  edge: { enabled: false, configured: false, credentialsConfigured: false, credentialsVerified: true, missingSecrets: [] },
  safari: { enabled: true, configured: true, credentialsConfigured: true, credentialsVerified: true, missingSecrets: [] },
};

describe("extension_release_status keeps the latest Safari withdrawal beside the new review", () => {
  let tmp: string;
  let prevXdg: string | undefined;
  let prevApi: string | undefined;
  let prevFetch: typeof fetch;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "extdev-safari-withdrawal-"));
    prevXdg = process.env.XDG_CONFIG_HOME;
    prevApi = process.env.EXTENSION_DEV_API_URL;
    delete process.env.EXTENSION_DEV_API_URL;
    process.env.XDG_CONFIG_HOME = tmp;
    prevFetch = global.fetch;
    const routes: Record<string, unknown> = {
      "/api/cli/whoami": { login: "cezaraugusto/rebeccat", live: true, projectId: PROJECT_ID },
      [`/api/projects/${PROJECT_ID}/stores/config`]: STORE_CONFIG,
      [`/api/projects/${PROJECT_ID}/stores/chrome/submissions`]: [],
      [`/api/projects/${PROJECT_ID}/stores/firefox/submissions`]: [],
      [`/api/projects/${PROJECT_ID}/stores/edge/submissions`]: [],
      [`/api/projects/${PROJECT_ID}/stores/safari/submissions`]: SAFARI_RECORDS,
      "/api/cli/stores/submissions": { submissions: [...SAFARI_RECORDS].reverse() },
    };

    global.fetch = (async (url: string) => {
      const pathname = new URL(String(url)).pathname;

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

  it("names build 11's withdrawal and build 14's review, and how 0.2.0 goes on sale", async () => {
    if (process.platform === "win32") return;

    const out = JSON.parse(await releaseStatus({ include: ["stores"], api: API }));
    const hint = String(out.value.stores.hint);

    expect(hint).toContain("0.2.0: build 11 withdrawn Oct 28; build 14 waiting for review");
    expect(hint).toContain("0.2.0 is set to release automatically after approval");
  });
});
