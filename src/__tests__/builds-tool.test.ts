import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { handler as builds, schema } from "../tools/builds";
import { outcomeClock } from "../lib/act-outcome";
import { TOOL_POLICY } from "../lib/tool-policy";
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

const BUILD_ROW = {
  id: "603fc8a",
  buildId: "603fc8a",
  commit: "603fc8ab0ff0ac1dae1c598428ce49ad43081c98",
  shortSha: "603fc8a",
  status: "success",
  version: "0.1.0",
  buildEnv: "production",
  timestamp: "2026-10-11T16:45:37Z",
  startedAt: "2026-10-11T16:45:37Z",
  completedAt: "2026-10-11T16:45:37Z",
  branch: "main",
  message: "Start a tiny sandbox extension",
  duration: "1m 6s",
  browsers: ["chrome", "firefox"],
  channel: "preview",
  summaryStatus: "success",
  author: "someone",
};

const DETAIL = {
  id: "603fc8a",
  buildId: "603fc8a",
  status: "success",
  commit: BUILD_ROW.commit,
  message: BUILD_ROW.message,
  version: "0.1.0",
  browsers: [
    { name: "chrome", status: "success", duration: "1m 6s", size: "-" },
    { name: "firefox", status: "success", duration: "1m 6s", size: "-" },
  ],
  validation: { checks: [{ id: "manifest", name: "Manifest validity", status: "passed" }] },
  failureCause: null,
  branch: "main",
  runUrl: RUN_URL,
};

const ARTIFACTS = [
  {
    name: "chrome-extension.zip",
    browser: "chrome",
    size: "45.4 MB",
    type: "Extension package",
    downloadUrl: "https://registry.extension.land/acme/widget/builds/603fc8a/chrome.zip",
  },
];

const INTEGRITY_CHROME = {
  ok: false,
  browser: "chrome",
  checks: [
    { id: "download-package", ok: false, title: "Download package", detail: "HTTP 401 Unauthorized" },
    { id: "zip-structure", ok: true, title: "Zip structure", detail: "ok" },
  ],
};

const LOGS = {
  buildId: "603fc8a",
  runUrl: RUN_URL,
  runUrlAvailable: true,
  items: [
    {
      browser: "chrome",
      status: "failed",
      logs: Array.from({ length: 300 }, (_, i) => ({ level: "error", message: `line ${i}` })),
    },
    { browser: "firefox", status: "success", logs: [{ level: "info", message: "ok" }] },
  ],
};

describe("extension_builds reads the platform's builds with the project's own token", () => {
  let tmp: string;
  let prevXdg: string | undefined;
  let prevFetch: typeof fetch;
  let prevApi: string | undefined;
  let calls: Array<{ url: string; auth: string }>;
  let routes: Record<string, { body: unknown; status?: number }>;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "extdev-builds-"));
    prevXdg = process.env.XDG_CONFIG_HOME;
    prevApi = process.env.EXTENSION_DEV_API_URL;
    delete process.env.EXTENSION_DEV_API_URL;
    process.env.XDG_CONFIG_HOME = tmp;
    prevFetch = global.fetch;
    calls = [];
    routes = {
      "/api/cli/whoami": {
        body: { login: "acme/widget", live: true, projectId: PROJECT_ID, workspaceSlug: "acme", projectSlug: "widget" },
      },
      [`/api/projects/${PROJECT_ID}/builds`]: { body: { items: [BUILD_ROW], latest: BUILD_ROW } },
      [`/api/projects/${PROJECT_ID}/builds/603fc8a`]: { body: DETAIL },
      [`/api/projects/${PROJECT_ID}/builds/603fc8a/artifacts`]: { body: ARTIFACTS },
      [`/api/projects/${PROJECT_ID}/builds/603fc8a/integrity/chrome`]: { body: INTEGRITY_CHROME },
      [`/api/projects/${PROJECT_ID}/builds/603fc8a/integrity/firefox`]: {
        body: { ok: true, browser: "firefox", checks: [{ id: "zip-structure", ok: true }] },
      },
      [`/api/projects/${PROJECT_ID}/builds/603fc8a/usage`]: { body: { markdown: null, updatedAt: null } },
      [`/api/projects/${PROJECT_ID}/builds/603fc8a/logs`]: { body: LOGS },
    };

    global.fetch = (async (url: string, init?: RequestInit) => {
      const target = String(url);
      const headers = (init?.headers ?? {}) as Record<string, string>;
      calls.push({ url: target, auth: String(headers.authorization ?? "") });
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

  it("ledger 541: the waitSeconds input says get waits for a build's verdict, a rebuild before a push, never a push alone", () => {
    const description = String(schema.inputSchema.properties.waitSeconds.description);

    expect(description).toContain("get waits for a build's verdict (a rebuild or a push)");
    expect(description).not.toContain("push's verdict");
  });

  it("fences its answer as untrusted CI output, and its reads ship nothing", () => {
    expect(TOOL_POLICY.extension_builds).toMatchObject({ group: "platform", untrusted: true });
    expect(TOOL_POLICY.extension_builds.ships).toBeUndefined();
  });

  it("lists recent builds by default, from the server the call's api names", async () => {
    if (process.platform === "win32") return;

    login();

    const out = JSON.parse(await builds({ api: API }));

    expect(out.ok).toBe(true);
    expect(out.status).toBe("listed");
    expect(out.value.builds[0]).toMatchObject({
      buildId: "603fc8a",
      sha: BUILD_ROW.commit,
      status: "success",
      env: "production",
      browsers: ["chrome", "firefox"],
      timestamp: "2026-10-11T16:45:37Z",
      duration: "1m 6s",
      conclusion: "success",
    });

    expect(out.value.builds[0].createdAt).toBeUndefined();
    expect(out.value.builds[0]).not.toHaveProperty("channel");

    expect(out.value.builds[0].consoleUrl).toContain("/acme/widget/builds/603fc8a");
    expect(calls.every((call) => call.url.startsWith(API))).toBe(true);
    expect(calls.every((call) => call.auth === "Bearer claims.sig")).toBe(true);
    expect(calls.some((call) => call.url.startsWith(`${API}/api/projects/${PROJECT_ID}/builds?limit=`))).toBe(true);
  });

  it("leads with a branch head the platform has not built and passes the last push through", async () => {
    if (process.platform === "win32") return;

    login();
    const lastPush = {
      commit: "4478aff",
      ref: "main",
      receivedAt: "2026-10-24T23:50:33.000Z",
      outcome: "PUSH_BUILDS_EXHAUSTED",
      dispatched: false,
    };
    const headLag = {
      branch: "main",
      headCommit: "4478aff",
      lastBuildId: "603fc8a",
      lastBuildAt: "2026-10-11T16:45:37.000Z",
      reason: "push_refused",
      pushCode: "PUSH_BUILDS_EXHAUSTED",
      pushReceivedAt: "2026-10-24T23:50:33.000Z",
      restarting: false,
      message:
        "main is at 4478aff, last build 603fc8a, no build started for it. The push arrived and was not built (PUSH_BUILDS_EXHAUSTED). Build it from the builds page or with a rebuild if you want it.",
    };
    routes[`/api/projects/${PROJECT_ID}/builds`] = {
      body: { items: [BUILD_ROW], latest: BUILD_ROW, lastPush, headLag },
    };

    const out = JSON.parse(await builds({ api: API }));

    expect(out.value.lastPush).toEqual({ ...lastPush, receivedAt: "2026-10-24T23:50:33Z" });
    expect(out.value.headLag).toEqual({ ...headLag, lastBuildAt: "2026-10-11T16:45:37Z", pushReceivedAt: "2026-10-24T23:50:33Z" });
    expect(out.value.sayToPerson).toBe(headLag.message);
    expect(out.hint.startsWith(headLag.message)).toBe(true);
  });

  it("names a push to another branch the deployment branch filter skipped, in the platform's words, and says lastPush reads any branch", async () => {
    if (process.platform === "win32") return;

    login();
    const message =
      "Push to step4 skipped: this project builds pushes to main only. No push build was spent. Clear the deployment branch in project settings to build every branch, or click Build in the console to run this commit.";
    const lastPush = {
      commit: "5520dc1",
      ref: "step4",
      receivedAt: "2026-11-04T15:14:58.000Z",
      outcome: "BRANCH_FILTERED",
      dispatched: false,
      message,
    };
    routes[`/api/projects/${PROJECT_ID}/builds`] = {
      body: { items: [BUILD_ROW], latest: BUILD_ROW, lastPush, headLag: null },
    };

    const out = JSON.parse(await builds({ api: API }));

    expect(out.value.lastPush).toEqual({ ...lastPush, receivedAt: "2026-11-04T15:14:58Z" });
    expect(out.value.headLag).toBeUndefined();
    expect(out.hint).toContain(
      `The last push the platform received, 5520dc1 to step4 (received 2026-11-04T15:14:58Z), was skipped by the project's own settings (BRANCH_FILTERED) and no build row names it: ${message}`,
    );

    expect(out.hint.split("Push to step4 skipped").length).toBe(2);

    expect(String(schema.inputSchema.properties.action.description)).toContain("lastPush");
  });

  it("gets one build with its artifacts, an integrity summary per browser, and usage", async () => {
    if (process.platform === "win32") return;

    login();

    const out = JSON.parse(await builds({ action: "get", buildId: "603fc8a", api: API }));

    expect(out.ok).toBe(true);
    expect(out.status).toBe("read");
    expect(out.value.build).toMatchObject({ buildId: "603fc8a", status: "success" });
    expect(out.value.build.runUrl).toBe(out.value.build.consoleUrl);
    expect(out.value.artifacts[0]).toMatchObject({ browser: "chrome", type: "Extension package" });
    expect(out.value.artifacts[0].download).toEqual({ action: "download", buildId: "603fc8a", browser: "chrome" });
    expect(out.hint).toContain('action:"download"');
    expect(out.value.integrity.chrome).toEqual({
      ok: false,
      failed: [{ id: "download-package", title: "Download package", detail: "HTTP 401 Unauthorized" }],
      checks: 2,
    });

    expect(out.value.integrity.firefox).toMatchObject({ ok: true, failed: [] });
    expect(out.value.usage).toEqual({ recorded: false });
  });

  it("fills each browser's size from its package artifact and drops an unknown one instead of answering a dash", async () => {
    if (process.platform === "win32") return;

    login();

    const out = JSON.parse(await builds({ action: "get", buildId: "603fc8a", api: API }));
    const [chrome, firefox] = out.value.build.browsers;

    expect(chrome).toMatchObject({ name: "chrome", size: "45.4 MB" });
    expect(firefox.size).toBeUndefined();
    expect(firefox.sizeUnknown).toBeTruthy();
    expect(JSON.stringify(out.value.build.browsers)).not.toContain('"-"');
  });

  it("waits with waitSeconds until a building build settles and answers its verdict", async () => {
    if (process.platform === "win32") return;

    login();

    const route = `/api/projects/${PROJECT_ID}/builds/603fc8a`;
    routes[route] = { body: { ...DETAIL, status: "building" } };
    const sleep = outcomeClock.sleep;
    let slept = 0;

    outcomeClock.sleep = async () => {
      slept += 1;
      routes[route] = { body: DETAIL };
    };

    try {
      const out = JSON.parse(await builds({ action: "get", buildId: "603fc8a", waitSeconds: 300, api: API }));

      expect(slept).toBe(1);
      expect(out.value.build.status).toBe("success");
      expect(out.value.waited).toMatchObject({ settled: true });
    } finally {
      outcomeClock.sleep = sleep;
    }
  });

  it("reads a build once when waitSeconds is not given", async () => {
    if (process.platform === "win32") return;

    login();

    routes[`/api/projects/${PROJECT_ID}/builds/603fc8a`] = { body: { ...DETAIL, status: "building" } };
    const sleep = outcomeClock.sleep;
    let slept = 0;

    outcomeClock.sleep = async () => {
      slept += 1;
    };

    try {
      const out = JSON.parse(await builds({ action: "get", buildId: "603fc8a", api: API }));

      expect(slept).toBe(0);
      expect(out.value.build.status).toBe("building");
      expect(out.value.waited).toBeUndefined();
    } finally {
      outcomeClock.sleep = sleep;
    }
  });

  it("keeps waiting through a 404 while lastPush names the sha, then answers the verdict once the record appears", async () => {
    if (process.platform === "win32") return;

    login();

    const route = `/api/projects/${PROJECT_ID}/builds/603fc8a`;
    const listRoute = `/api/projects/${PROJECT_ID}/builds`;
    routes[route] = { body: { message: "Build not found" }, status: 404 };
    routes[listRoute] = { body: { items: [], lastPush: { commit: BUILD_ROW.commit, outcome: "DISPATCHED", dispatched: true } } };

    const sleep = outcomeClock.sleep;
    let slept = 0;

    outcomeClock.sleep = async () => {
      slept += 1;
      routes[route] = { body: slept === 1 ? { ...DETAIL, status: "building" } : DETAIL };
    };

    try {
      const out = JSON.parse(await builds({ action: "get", buildId: "603fc8a", waitSeconds: 240, api: API }));

      expect(slept).toBe(2);
      expect(out.value.build.status).toBe("success");
      expect(out.value.waited).toMatchObject({ settled: true });
      expect(calls.filter((call) => new URL(call.url).pathname === listRoute).length).toBeLessThanOrEqual(2);
    } finally {
      outcomeClock.sleep = sleep;
    }
  });

  it("answers not-recorded-yet naming the push when the wait bound ends before the record appears", async () => {
    if (process.platform === "win32") return;

    login();
    routes[`/api/projects/${PROJECT_ID}/builds/603fc8a`] = { body: { message: "Build not found" }, status: 404 };
    routes[`/api/projects/${PROJECT_ID}/builds`] = { body: { items: [], lastPush: { commit: BUILD_ROW.commit, outcome: "DISPATCHED", receivedAt: "2026-11-06T12:00:00Z" } } };

    const { sleep, now } = outcomeClock;
    let clock = 0;

    outcomeClock.now = () => clock;
    outcomeClock.sleep = async (ms: number) => void (clock += ms);

    try {
      const out = JSON.parse(await builds({ action: "get", buildId: "603fc8a", waitSeconds: 20, api: API }));

      expect(out.status).toBe("not-recorded-yet");
      expect(out.value.lastPush).toMatchObject({ commit: BUILD_ROW.commit, outcome: "DISPATCHED" });
      expect(out.value.waited).toEqual({ seconds: 20, settled: false });
      expect(out.hint).toContain("DISPATCHED");
    } finally {
      outcomeClock.sleep = sleep;
      outcomeClock.now = now;
    }
  });

  it("reads the logs of one browser, keeping the tail of a long log and saying it cut it", async () => {
    if (process.platform === "win32") return;

    login();

    const out = JSON.parse(
      await builds({ action: "logs", buildId: "603fc8a", browser: "chrome", api: API }),
    );

    expect(out.ok).toBe(true);
    expect(out.status).toBe("read");
    expect(out.value.items).toHaveLength(1);
    expect(out.value.items[0].browser).toBe("chrome");
    expect(out.value.items[0].logs).toHaveLength(200);
    expect(out.value.items[0].logs.at(-1).message).toBe("line 299");
    expect(out.value.items[0].omittedLines).toBe(100);
    expect(out.value.runUrl).toBeUndefined();
    expect(JSON.stringify(out)).not.toContain(RUN_URL);
  });

  it("refuses get and logs without a buildId before asking the platform", async () => {
    login();

    const out = JSON.parse(await builds({ action: "logs", api: API }));

    expect(out.ok).toBe(false);
    expect(out.error.code).toBe("E_BAD_REQUEST");
    expect(calls).toHaveLength(0);
  });

  it("ledger 507: get keeps waiting through a 404 of a sha this server dispatched, backing off, then answers the verdict", async () => {
    if (process.platform === "win32") return;

    login();
    routes[`/api/projects/${PROJECT_ID}/builds/dispatch`] = { body: { ok: true, commit: "4cec881", browsers: "chrome", branch: "main", dispatchedAt: "2026-11-11T16:52:04.000Z" } };
    routes[`/api/projects/${PROJECT_ID}/builds`] = { body: { items: [BUILD_ROW] } };
    const dispatched = JSON.parse(await builds({ action: "rebuild", buildId: "4cec881", waitSeconds: 0, api: API }));

    expect(dispatched.status).toBe("rebuild-dispatched");

    const route = `/api/projects/${PROJECT_ID}/builds/4cec881`;
    const { sleep } = outcomeClock;
    const slept: number[] = [];

    outcomeClock.sleep = async (ms: number) => {
      slept.push(ms);
      await sleep(ms);
      if (slept.length === 4) routes[route] = { body: { ...DETAIL, id: "4cec881", buildId: "4cec881", status: "success", browsers: [] } };
    };

    try {
      const out = JSON.parse(await builds({ action: "get", buildId: "4cec881", waitSeconds: 240, api: API }));

      expect(slept).toEqual([3000, 6000, 12000, 15000]);
      expect(out.status).toBe("read");
      expect(out.value.build.status).toBe("success");
      expect(out.value.waited).toEqual({ seconds: 36, settled: true });
    } finally {
      outcomeClock.sleep = sleep;
    }
  });

  it("ledger 507: get answers not-recorded-yet naming the dispatch time and the next get when the bound ends before the record appears", async () => {
    if (process.platform === "win32") return;

    login();
    routes[`/api/projects/${PROJECT_ID}/builds/dispatch`] = { body: { ok: true, commit: "7e1f0a2", browsers: "chrome", branch: "main", dispatchedAt: "2026-11-11T17:00:10.000Z" } };
    routes[`/api/projects/${PROJECT_ID}/builds`] = { body: { items: [BUILD_ROW] } };
    await builds({ action: "rebuild", buildId: "7e1f0a2", waitSeconds: 0, api: API });

    const out = JSON.parse(await builds({ action: "get", buildId: "7e1f0a2", waitSeconds: 40, api: API }));

    expect(out.ok).toBe(true);
    expect(out.status).toBe("not-recorded-yet");
    expect(out.value.dispatch).toEqual({ dispatchedAt: "2026-11-11T17:00:10Z" });
    expect(out.value.waited).toEqual({ seconds: 40, settled: false });
    expect(out.hint).toContain("this server dispatched a rebuild for it at 2026-11-11T17:00:10Z");
    expect(out.hint).toContain("The 40 s wait passed before the record appeared");
    expect(out.hint).toContain('extension_builds (action: "get", buildId: "7e1f0a2", waitSeconds:');
    expect(out.hint).not.toContain('action:"rebuild"');

    const once = JSON.parse(await builds({ action: "get", buildId: "7e1f0a2", api: API }));

    expect(once.status).toBe("not-recorded-yet");
    expect(once.value.waited).toBeUndefined();
  });

  it("says a build neither lastPush nor the list names is not found at once, even with waitSeconds", async () => {
    if (process.platform === "win32") return;

    login();
    routes[`/api/projects/${PROJECT_ID}/builds/deadbee`] = { body: { message: "Build not found" }, status: 404 };
    routes[`/api/projects/${PROJECT_ID}/builds`] = { body: { items: [BUILD_ROW], lastPush: { commit: BUILD_ROW.commit, outcome: "DISPATCHED" } } };

    const sleep = outcomeClock.sleep;
    let slept = 0;

    outcomeClock.sleep = async () => {
      slept += 1;
    };

    try {
      const out = JSON.parse(await builds({ action: "get", buildId: "deadbee", waitSeconds: 240, api: API }));

      expect(slept).toBe(0);
      expect(out.ok).toBe(false);
      expect(out.error.code).toBe("E_BUILD_NOT_FOUND");
    } finally {
      outcomeClock.sleep = sleep;
    }
  });

  it("answers the platform hold with the hold envelope, not a generic failure", async () => {
    if (process.platform === "win32") return;

    login();
    routes[`/api/projects/${PROJECT_ID}/builds`] = {
      body: { code: "PLATFORM_NOT_OPEN", message: "extension.dev is not open to the public yet." },
      status: 403,
    };

    const out = JSON.parse(await builds({ api: API }));

    expect(out.ok).toBe(false);
    expect(out.status).toBe("platform-held");
    expect(out.error.platformCode).toBe("PLATFORM_NOT_OPEN");
    expect(out.value.stillWorks).toContain("extension_build");
  });

  it("asks for a login and sends nothing when this server holds none", async () => {
    const out = JSON.parse(await builds({ api: API }));

    expect(out.ok).toBe(false);
    expect(out.status).toBe("auth-required");
    expect(out.error.code).toBe("E_AUTH_REQUIRED");
    expect(calls).toHaveLength(0);
  });
});
