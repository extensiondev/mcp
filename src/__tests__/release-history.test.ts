import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { handler as releaseStatus } from "../tools/release-status";
import { writeCredentials } from "../lib/credentials";

const API = "http://localhost:3100";
const PROJECT_ID = "prj_probe";
const RUN_URL = "https://github.com/mirror/1--prj/actions/runs/7001";

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    text: async () => JSON.stringify(body),
    json: async () => body,
  } as unknown as Response;
}

const RELEASES = {
  summary: { activeReleases: 2, channels: 2 },
  items: [
    { id: "chrome-stable", browser: "chrome", channel: "stable", build: "603fc8a", version: "0.1.0", status: "live", createdAt: "2026-10-11T16:45:37Z", rollout: "100%" },
    { id: "chrome-preview", browser: "chrome", channel: "preview", build: "603fc8a", version: "0.1.0", status: "live", createdAt: "2026-10-11T16:45:37Z", rollout: "0%" },
  ],
};

const event = (n: number) => ({
  id: `run:${n}`,
  timestamp: `2026-10-11T18:0${n % 10}:00Z`,
  event: `Promoted chrome to stable (${n})`,
  status: "completed",
  type: "promotion",
  actor: "someone",
  runUrl: RUN_URL,
});

const CHROME_SUBMISSIONS = [
  { id: "sub_3", store: "chrome", status: "failed", version: "603fc8a", submittedAt: "2026-10-11T18:37:59.602Z", workflowRunUrl: RUN_URL, failureReason: "ended before any store step ran" },
  { id: "sub_2", store: "chrome", status: "published", version: "0.0.9", submittedAt: "2026-10-10T10:00:00Z" },
  { id: "sub_1", store: "chrome", status: "published", version: "0.0.8", submittedAt: "2026-10-09T10:00:00Z" },
];

const STORE_CONFIG = {
  chrome: {
    enabled: true,
    configured: true,
    credentialsConfigured: false,
    credentialsVerified: true,
    missingSecrets: ["STORE_CHROME_REFRESH_TOKEN"],
    storeUrl: "https://chromewebstore.google.com/detail/abc",
    storeId: "abc",
    clientSecret: "do-not-relay-this",
    sharedProjectData: { fields: [{ key: "project.description", value: "do-not-relay-this-either" }] },
    submissionMode: { id: "public", label: "Public publish" },
  },
  firefox: { enabled: false, configured: false, credentialsConfigured: false, credentialsVerified: true, missingSecrets: ["STORE_FIREFOX_API_KEY"] },
  edge: { enabled: false, configured: false, credentialsConfigured: false, credentialsVerified: true, missingSecrets: [] },
  safari: { enabled: false, configured: false, credentialsConfigured: false, credentialsVerified: true, missingSecrets: [] },
};

describe("extension_release_status reads release history and store records from the platform", () => {
  let tmp: string;
  let prevXdg: string | undefined;
  let prevApi: string | undefined;
  let prevFetch: typeof fetch;
  let calls: string[];
  let routes: Record<string, { body: unknown; status?: number }>;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "extdev-release-history-"));
    prevXdg = process.env.XDG_CONFIG_HOME;
    prevApi = process.env.EXTENSION_DEV_API_URL;
    delete process.env.EXTENSION_DEV_API_URL;
    process.env.XDG_CONFIG_HOME = tmp;
    prevFetch = global.fetch;
    calls = [];
    routes = {
      "/api/cli/whoami": { body: { login: "acme/widget", live: true, projectId: PROJECT_ID } },
      [`/api/projects/${PROJECT_ID}/releases`]: { body: RELEASES },
      [`/api/projects/${PROJECT_ID}/releases/chrome-stable`]: {
        body: { id: "stable", channel: "stable", build: "603fc8a", status: "live", version: "0.1.0" },
      },
      [`/api/projects/${PROJECT_ID}/releases/chrome-stable/events`]: {
        body: { items: [event(1), event(2), event(3)], total: 3, hasMore: false },
      },
      [`/api/projects/${PROJECT_ID}/releases/chrome-preview/events`]: {
        body: { items: [], total: 0, hasMore: false },
      },
      [`/api/projects/${PROJECT_ID}/releases/promote-ready`]: {
        body: { code: "OWNER_REQUIRED", message: "This is a workspace owner action." },
        status: 403,
      },
      [`/api/projects/${PROJECT_ID}/stores/config`]: { body: STORE_CONFIG },
      [`/api/projects/${PROJECT_ID}/stores/chrome/submissions`]: { body: CHROME_SUBMISSIONS },
      [`/api/projects/${PROJECT_ID}/stores/firefox/submissions`]: { body: [] },
      [`/api/projects/${PROJECT_ID}/stores/edge/submissions`]: { body: [] },
      [`/api/projects/${PROJECT_ID}/stores/safari/submissions`]: { body: [] },
      "/api/cli/stores/submissions": {
        body: {
          submissions: [
            { id: "sub_3", store: "chrome", status: "failed", version: "603fc8a", submittedAt: "2026-10-11T18:37:59.602Z" },
          ],
        },
      },
    };

    global.fetch = (async (url: string) => {
      const target = String(url);
      calls.push(target);
      const pathname = new URL(target).pathname;
      const route = routes[pathname];

      return route
        ? jsonResponse(route.body, route.status ?? 200)
        : jsonResponse({ message: "not found" }, 404);
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prevXdg;
    if (prevApi === undefined) delete process.env.EXTENSION_DEV_API_URL;
    else process.env.EXTENSION_DEV_API_URL = prevApi;

    global.fetch = prevFetch;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function login() {
    writeCredentials({
      version: 1,
      token: "claims.sig",
      workspaceSlug: "acme",
      projectSlug: "widget",
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      api: API,
    });
  }

  it("reads release history with each release's recent events, bounded", async () => {
    if (process.platform === "win32") return;

    login();

    const out = JSON.parse(await releaseStatus({ include: ["history"], api: API }));

    expect(out.ok).toBe(true);
    const history = out.value.history;
    expect(history.ok).toBe(true);
    expect(history.value.summary).toMatchObject({ activeReleases: 2 });
    const stable = history.value.releases.find((r: { id: string }) => r.id === "chrome-stable");
    expect(stable).toMatchObject({ browser: "chrome", channel: "stable", build: "603fc8a" });
    expect(stable.events).toHaveLength(3);
    expect(stable.events[0]).toMatchObject({ event: "Promoted chrome to stable (1)" });
    expect(stable.events[0].runUrl).toBeUndefined();
    expect(calls.some((url) => url.includes("/events?limit=5"))).toBe(true);
  });

  it("says the promote-ready read needs an owner instead of failing the section", async () => {
    if (process.platform === "win32") return;

    login();

    const out = JSON.parse(await releaseStatus({ include: ["history"], api: API }));

    expect(out.value.history.value.promoteReady).toMatchObject({ read: false, needsOwner: true });
    expect(out.value.history.warnings.join(" ")).toContain("needs a token minted by a workspace owner");
  });

  it("reads one release and its events when releaseId is passed", async () => {
    if (process.platform === "win32") return;

    login();

    const out = JSON.parse(await releaseStatus({ releaseId: "chrome-stable", api: API }));

    expect(out.ok).toBe(true);
    expect(out.value.release.value.release).toMatchObject({ channel: "stable", build: "603fc8a" });
    expect(out.value.release.value.events).toHaveLength(3);
    expect(out.value.releases).toBeUndefined();
  });

  it("adds store configuration presence and submission history, never a credential value", async () => {
    if (process.platform === "win32") return;

    login();

    const raw = await releaseStatus({ include: ["stores"], api: API });
    const out = JSON.parse(raw);

    expect(raw).not.toContain("do-not-relay-this");
    const chrome = out.value.stores.value.stores.find((row: { store: string }) => row.store === "chrome");
    expect(chrome.config).toEqual({
      enabled: true,
      configured: true,
      credentialsConfigured: false,
      missingCredentials: ["STORE_CHROME_REFRESH_TOKEN"],
      storeUrl: "https://chromewebstore.google.com/detail/abc",
      storeId: "abc",
      submissionMode: "public",
    });

    expect(chrome.lastSubmission).toMatchObject({ status: "failed", version: "603fc8a" });
    expect(chrome.submissionHistory.map((s: { version: string }) => s.version)).toEqual(["0.0.9", "0.0.8"]);
    const firefox = out.value.stores.value.stores.find((row: { store: string }) => row.store === "firefox");
    expect(firefox.config.configured).toBe(false);
    expect(firefox.submissionHistory).toBeUndefined();
  });

  it("never calls credentials healthy when no health check was read and the platform says they are not set", async () => {
    if (process.platform === "win32") return;

    login();

    const out = JSON.parse(await releaseStatus({ include: ["stores"], api: API }));
    const hint = out.value.stores.hint as string;

    expect(hint).toContain("chrome: configured, no credential health check recorded; credentials not set: STORE_CHROME_REFRESH_TOKEN");
    expect(hint).not.toContain("credentials healthy");
  });

  it("knows a configured store has no submissions from the platform when the registry file is missing", async () => {
    if (process.platform === "win32") return;

    login();
    routes[`/api/projects/${PROJECT_ID}/stores/config`] = {
      body: { ...STORE_CONFIG, firefox: { ...STORE_CONFIG.firefox, configured: true } },
    };

    const out = JSON.parse(await releaseStatus({ include: ["stores"], api: API }));
    const hint = out.value.stores.hint as string;

    expect(hint).toContain("firefox: configured, no credential health check recorded; credentials not set: STORE_FIREFOX_API_KEY; no submissions recorded");
    expect(hint).not.toContain("submissions unknown");
  });

  it("maps a held platform to the hold envelope for the history section", async () => {
    if (process.platform === "win32") return;

    login();
    routes[`/api/projects/${PROJECT_ID}/releases`] = {
      body: { code: "PLATFORM_NOT_OPEN", message: "extension.dev is not open to the public yet." },
      status: 403,
    };

    const out = JSON.parse(await releaseStatus({ include: ["history"], api: API }));

    expect(out.ok).toBe(false);
    expect(out.value.history.status).toBe("platform-held");
    expect(out.value.history.error.platformCode).toBe("PLATFORM_NOT_OPEN");
  });
});
