import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { handler as builds } from "../tools/builds";
import { writeCredentials } from "../lib/credentials";

const API = "http://localhost:3100";
const PROJECT_ID = "prj_probe";
const SHA = "b418732";
const RECHECK_ROUTE = `/api/projects/${PROJECT_ID}/builds/${SHA}/integrity/recheck`;

type Reply = { body: unknown; status?: number };

const platform = vi.hoisted(() => ({
  reply: { body: null, status: 200 } as { body: unknown; status?: number },
  posts: [] as Array<{ path: string; body: unknown }>,
}));

function json({ body, status = 200 }: Reply): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const PASSED = (browser: string) => ({
  browser,
  ok: true,
  checkedAt: "2026-10-19T16:40:00Z",
  run: 39281000000,
  checks: [{ id: "zip-structure", ok: true }],
});

describe("extension_builds recheck reruns a build's integrity checks on its stored artifacts", () => {
  let tmp: string;
  let prevXdg: string | undefined;
  let prevApi: string | undefined;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "extdev-builds-recheck-"));
    prevXdg = process.env.XDG_CONFIG_HOME;
    prevApi = process.env.EXTENSION_DEV_API_URL;
    delete process.env.EXTENSION_DEV_API_URL;
    process.env.XDG_CONFIG_HOME = tmp;
    platform.posts = [];
    platform.reply = { body: null, status: 200 };

    writeCredentials({
      version: 1,
      token: "claims.sig",
      workspaceSlug: "acme",
      projectSlug: "widget",
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      api: API,
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(input instanceof Request ? input.url : input));

        if (url.pathname === "/api/cli/whoami") {
          return json({ body: { login: "acme/widget", live: true, projectId: PROJECT_ID, workspaceSlug: "acme", projectSlug: "widget" } });
        }

        if (url.pathname === RECHECK_ROUTE && String(init?.method).toUpperCase() === "POST") {
          platform.posts.push({ path: url.pathname, body: init?.body ? JSON.parse(String(init.body)) : undefined });

          return json(platform.reply);
        }

        throw new Error(`builds-recheck cells never reach the network (${url.pathname})`);
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prevXdg;
    if (prevApi === undefined) delete process.env.EXTENSION_DEV_API_URL;
    else process.env.EXTENSION_DEV_API_URL = prevApi;

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("answers every browser passed, says publish is now possible, and links the build page", async () => {
    if (process.platform === "win32") return;

    platform.reply = {
      body: { buildId: SHA, checkedAt: "2026-10-19T16:40:00Z", browsers: ["chrome", "edge", "firefox"].map(PASSED) },
    };

    const out = JSON.parse(await builds({ action: "recheck", buildId: SHA, api: API }));

    expect(out.ok).toBe(true);
    expect(out.status).toBe("rechecked");
    expect(platform.posts).toEqual([{ path: RECHECK_ROUTE, body: {} }]);
    expect(out.value).toMatchObject({ action: "recheck", buildId: SHA, good: ["chrome", "edge", "firefox"], failed: [], publishable: true });
    expect(out.value.browsers.chrome).toMatchObject({ integrity: "passed", checkedAt: "2026-10-19T16:40:00Z", checkedRun: "39281000000" });
    expect(out.value.trackUrl).toMatch(/\/acme\/widget\/builds\/b418732$/);
    expect(out.hint).toContain("publish is now possible");
    expect(out.hint).toContain(`extension_publish (buildSha: '${SHA}')`);
    expect(out.value.status).toContain("nothing blocks publishing it");
  });

  it("sends the one browser asked for and names a failed recheck without calling it publishable", async () => {
    if (process.platform === "win32") return;

    platform.reply = {
      body: {
        buildId: SHA,
        browsers: [{ browser: "firefox", ok: false, checkedAt: "2026-10-19T16:40:00Z", checks: [{ id: "zip-structure", ok: false, title: "Zip readable" }] }],
      },
    };

    const out = JSON.parse(await builds({ action: "recheck", buildId: SHA, browser: "Firefox", api: API }));

    expect(platform.posts[0].body).toEqual({ browser: "firefox" });
    expect(out.value).toMatchObject({ failed: ["firefox"], publishable: false });
    expect(out.value.browsers.firefox.failedChecks).toEqual([{ id: "zip-structure", title: "Zip readable" }]);
    expect(out.hint).not.toContain("publish is now possible");
    expect(out.hint).toContain("action: 'rebuild'");
  });

  it("reads a 202 with no checks as still checking", async () => {
    if (process.platform === "win32") return;

    platform.reply = { status: 202, body: { buildId: SHA, browsers: [{ browser: "chrome", ok: false, checkedAt: "2026-10-19T16:40:00Z" }] } };

    const out = JSON.parse(await builds({ action: "recheck", buildId: SHA, api: API }));

    expect(out.status).toBe("checking");
    expect(out.value).toMatchObject({ checking: ["chrome"], publishable: false });
    expect(out.value.browsers.chrome.integrity).toBe("checking");
    expect(out.hint).toContain("still checking chrome");
  });

  it.each([
    [404, "not-found", "has no stored artifact to check"],
    [409, "run-in-progress", "has a run in progress"],
    [429, "rate-limited", "one recheck per build every 60 seconds"],
  ])("maps a %i to a clear refusal with the build page as trackUrl", async (status, expected, sentence) => {
    if (process.platform === "win32") return;

    platform.reply = { status, body: { message: "no" } };

    const out = JSON.parse(await builds({ action: "recheck", buildId: SHA, api: API }));

    expect(out.ok).toBe(false);
    expect(out.status).toBe(expected);
    expect(out.error.message).toContain(sentence);
    expect(out.value.trackUrl).toMatch(/\/acme\/widget\/builds\/b418732$/);
    expect(out.value.status).toContain(`Build ${SHA} was not rechecked`);
  });

  it("refuses a recheck with no buildId before any request", async () => {
    const out = JSON.parse(await builds({ action: "recheck", api: API }));

    expect(out.status).toBe("bad-request");
    expect(platform.posts).toEqual([]);
  });
});
