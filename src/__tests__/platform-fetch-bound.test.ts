import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { writeCredentials } from "../lib/credentials";
import { envelope } from "../lib/envelope";
import {
  PLATFORM_DISPATCH_TIMEOUT_MS,
  PLATFORM_READ_TIMEOUT_MS,
  platformFetch,
  type PlatformFetchResult,
} from "../lib/platform-fetch";
import { attachTrack } from "../lib/track-url";
import { handler as builds } from "../tools/builds";

const API = "http://localhost:3100";
const PROJECT_ID = "prj_probe";
const WHOAMI = "https://www.extension.dev/api/cli/whoami";

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    text: async () => JSON.stringify(body),
    json: async () => body,
  } as unknown as Response;
}

function neverSettles(): Promise<Response> {
  return new Promise<Response>(() => {});
}

function failing(code: string): typeof fetch {
  return (async () => {
    throw Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error(`connect ${code}`), { code }) });
  }) as unknown as typeof fetch;
}

async function settledAfter(pending: Promise<PlatformFetchResult>, ms: number): Promise<PlatformFetchResult | null> {
  let settled: PlatformFetchResult | null = null;
  void pending.then((result) => {
    settled = result;
  });

  await vi.advanceTimersByTimeAsync(ms);

  return settled;
}

describe("every platform call is one bounded fetch", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("answers a read that never settles at 15 s and says the platform did not answer", async () => {
    const fetchSpy = vi.fn(() => neverSettles());
    const pending = platformFetch(WHOAMI, {}, { fetchImpl: fetchSpy as unknown as typeof fetch });

    expect(await settledAfter(pending, PLATFORM_READ_TIMEOUT_MS - 1)).toBeNull();
    expect(await settledAfter(pending, 1)).toEqual({
      ok: false,
      unreached: { kind: "timeout", message: `could not reach ${WHOAMI}: the platform did not answer within 15 s` },
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect((fetchSpy.mock.calls[0] as unknown as [string, RequestInit])[1].signal?.aborted).toBe(true);
  });

  it("gives a write that dispatches 60 s and no second attempt", async () => {
    const fetchSpy = vi.fn(() => neverSettles());
    const pending = platformFetch(WHOAMI, { method: "POST" }, { kind: "dispatch", fetchImpl: fetchSpy as unknown as typeof fetch });

    expect(await settledAfter(pending, PLATFORM_READ_TIMEOUT_MS)).toBeNull();
    expect(await settledAfter(pending, PLATFORM_DISPATCH_TIMEOUT_MS - PLATFORM_READ_TIMEOUT_MS)).toMatchObject({
      ok: false,
      unreached: { kind: "timeout", message: `could not reach ${WHOAMI}: the platform did not answer within 60 s` },
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("names a refused connection and a host DNS cannot resolve", async () => {
    expect(await platformFetch(WHOAMI, {}, { fetchImpl: failing("ECONNREFUSED") })).toEqual({
      ok: false,
      unreached: { kind: "refused", message: `could not reach ${WHOAMI}: the connection was refused by www.extension.dev (ECONNREFUSED)` },
    });

    expect(await platformFetch(WHOAMI, {}, { fetchImpl: failing("ENOTFOUND") })).toEqual({
      ok: false,
      unreached: { kind: "dns", message: `could not reach ${WHOAMI}: www.extension.dev could not be resolved (DNS ENOTFOUND)` },
    });

    expect(await platformFetch(WHOAMI, {}, { fetchImpl: failing("ECONNRESET") })).toMatchObject({ ok: false, unreached: { kind: "refused" } });
  });

  it("passes a response through untouched", async () => {
    const out = await platformFetch(WHOAMI, {}, { fetchImpl: (async () => jsonResponse({ projectId: PROJECT_ID })) as unknown as typeof fetch });

    expect(out.ok).toBe(true);
    if (out.ok) expect(await out.res.json()).toEqual({ projectId: PROJECT_ID });
  });

  it("an unreached refusal carries the console page as trackUrl", () => {
    const out = JSON.parse(
      attachTrack(
        "extension_builds",
        { action: "list", project: "acme/widget" },
        envelope({
          ok: false,
          command: "extension_builds",
          status: "unavailable",
          value: { action: "list" },
          error: { code: "E_NETWORK", name: "BuildsError", message: "could not reach x: the platform did not answer within 15 s" },
        }),
      ),
    );

    expect(out.value.trackUrl).toMatch(/\/acme\/widget\/builds$/);
    expect(out.hint).toBe(`The console page is ${out.value.trackUrl}.`);
  });
});

describe("extension_builds list answers at the read bound", () => {
  let tmp: string;
  let prevXdg: string | undefined;
  let prevApi: string | undefined;
  let calls: string[];

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "extdev-fetch-bound-"));
    prevXdg = process.env.XDG_CONFIG_HOME;
    prevApi = process.env.EXTENSION_DEV_API_URL;
    delete process.env.EXTENSION_DEV_API_URL;
    process.env.XDG_CONFIG_HOME = tmp;
    calls = [];

    vi.stubGlobal("fetch", (async (url: string) => {
      const target = String(url);
      calls.push(target);

      if (new URL(target).pathname === "/api/cli/whoami") {
        return jsonResponse({ login: "acme/widget", live: true, projectId: PROJECT_ID, workspaceSlug: "acme", projectSlug: "widget" });
      }

      return neverSettles();
    }) as unknown as typeof fetch);

    writeCredentials({
      version: 1,
      token: "claims.sig",
      workspaceSlug: "acme",
      projectSlug: "widget",
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      api: API,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prevXdg;
    if (prevApi === undefined) delete process.env.EXTENSION_DEV_API_URL;
    else process.env.EXTENSION_DEV_API_URL = prevApi;

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("answers E_NETWORK with the bound it hit when the builds index never answers", async () => {
    if (process.platform === "win32") return;

    const pending = builds({ api: API, action: "list", limit: 2 });
    await vi.advanceTimersByTimeAsync(PLATFORM_READ_TIMEOUT_MS);
    const out = JSON.parse(await pending);

    expect(out.ok).toBe(false);
    expect(out.status).toBe("unavailable");
    expect(out.error.code).toBe("E_NETWORK");
    expect(out.error.message).toBe(`could not reach ${API}/api/projects/${PROJECT_ID}/builds?limit=2: the platform did not answer within 15 s`);
    expect(calls).toEqual([`${API}/api/cli/whoami`, `${API}/api/projects/${PROJECT_ID}/builds?limit=2`]);
  });
});
