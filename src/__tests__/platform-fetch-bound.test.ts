import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { writeCredentials } from "../lib/credentials";
import { envelope } from "../lib/envelope";
import { FORWARD_PAIRS, LOCAL_FORWARD_URL, forgetForwardCredentials, forwardCredential, forwardUrlFor } from "../lib/forward-credential";
import {
  PLATFORM_DISPATCH_TIMEOUT_MS,
  PLATFORM_READ_TIMEOUT_MS,
  bearerFetch,
  platformFetch,
  type PlatformFetchResult,
} from "../lib/platform-fetch";
import { forwardCall, forwardable } from "../lib/hosted-forwarder";
import { attachTrack } from "../lib/track-url";
import { handler as builds } from "../tools/builds";

import type { AddressInfo } from "node:net";

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

describe("a bearer never follows a platform redirect", () => {
  let tmp: string;
  let prevXdg: string | undefined;
  let prevApi: string | undefined;
  let server: http.Server;
  let base: string;
  let seen: Array<{ path: string; authorization: string | null }>;

  beforeEach(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "extdev-redirect-"));
    prevXdg = process.env.XDG_CONFIG_HOME;
    prevApi = process.env.EXTENSION_DEV_API_URL;
    delete process.env.EXTENSION_DEV_API_URL;
    process.env.XDG_CONFIG_HOME = tmp;
    seen = [];

    server = http.createServer((req, res) => {
      const at = new URL(String(req.url), "http://127.0.0.1");
      seen.push({ path: at.pathname, authorization: req.headers.authorization ?? null });

      if (at.pathname === "/api/cli/whoami") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ login: "acme/widget", live: true, projectId: PROJECT_ID, workspaceSlug: "acme", projectSlug: "widget" }));

        return;
      }

      if (at.pathname === "/collect") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ builds: [] }));

        return;
      }

      res.writeHead(302, { location: "/collect" });
      res.end();
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    writeCredentials({
      version: 1,
      token: "claims.sig",
      workspaceSlug: "acme",
      projectSlug: "widget",
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      api: base,
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prevXdg;
    if (prevApi === undefined) delete process.env.EXTENSION_DEV_API_URL;
    else process.env.EXTENSION_DEV_API_URL = prevApi;

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("refuses a 302 as an unreachable platform and never sends the bearer to the Location", async () => {
    const out = JSON.parse(await builds({ api: base, action: "list", limit: 2 }));

    expect(seen.map((hit) => hit.path)).not.toContain("/collect");
    expect(seen.every((hit) => hit.authorization === "Bearer claims.sig")).toBe(true);
    expect(out.ok).toBe(false);
    expect(out.status).toBe("unavailable");
    expect(out.error.code).toBe("E_NETWORK");
    expect(out.error.message).toBe(
      `could not reach ${base}/api/projects/${PROJECT_ID}/builds?limit=2: the platform answered a 302 redirect, and a credential is never sent to a redirect`,
    );
  });

  it("refuses the redirect on a direct bearer call and still follows one that carries no bearer", async () => {
    await expect(bearerFetch(`${base}/api/cli/approvals`, { headers: { authorization: "Bearer claims.sig" } })).rejects.toThrow(
      "the platform answered a 302 redirect, and a credential is never sent to a redirect",
    );

    expect(seen.map((hit) => hit.path)).not.toContain("/collect");

    const open = await bearerFetch(`${base}/api/public`);
    expect(open.status).toBe(200);
    expect(seen.map((hit) => hit.path)).toEqual(["/api/cli/approvals", "/api/public", "/collect"]);
  });

  it("sends every bearer in the source through a fetch that refuses redirects", () => {
    const root = path.join(__dirname, "..");
    const files = fs.readdirSync(root, { recursive: true, encoding: "utf8" }).filter((file) => file.endsWith(".ts") && !file.includes("__tests__"));
    const loose = files.filter((file) => {
      const text = fs.readFileSync(path.join(root, file), "utf8");
      const bearer = /bearerHeaders\(|Bearer \$\{/.test(text) && !file.endsWith("request-fetch.ts");

      return bearer && !/\b(platformFetch|bearerFetch|withoutRedirects)\(/.test(text);
    });

    expect(loose).toEqual([]);
  });
});

describe("the forwarder's login goes only to its own www and its own lane", () => {
  afterEach(() => forgetForwardCredentials());

  it.each([
    ["production www", "https://www.extension.dev", {}, FORWARD_PAIRS["https://www.extension.dev"]],
    ["the apex", "https://extension.dev", {}, "https://mcp.extension.dev/mcp/forward"],
    ["production www with an override", "https://www.extension.dev", { EXTENSION_DEV_FORWARD_URL: "https://lane.example/mcp/forward" }, "https://mcp.extension.dev/mcp/forward"],
    ["a loopback www", "http://localhost:3100", {}, LOCAL_FORWARD_URL],
    ["a loopback www with a loopback override", "http://127.0.0.1:3100", { EXTENSION_DEV_FORWARD_URL: "http://127.0.0.1:4555/mcp/forward" }, "http://127.0.0.1:4555/mcp/forward"],
    ["a loopback www with an HTTPS override", "http://localhost:3100", { EXTENSION_DEV_FORWARD_URL: "https://lane.example/mcp/forward" }, null],
    ["another HTTPS www", "https://staging.extension.dev", {}, null],
  ])("pairs %s from the closed table", (_name, api, env, expected) => {
    expect(forwardUrlFor(api, env)).toBe(expected);
  });

  it("exchanges the login once, keeps the short credential until a minute before it ends, and never follows a redirect", async () => {
    const seen: Array<{ url: string; authorization: string | null; redirect: string | undefined; body: unknown }> = [];
    let life = 600;
    const fetchImpl = (async (input: unknown, init?: RequestInit) => {
      seen.push({ url: String(input), authorization: new Headers(init?.headers).get("authorization"), redirect: init?.redirect, body: JSON.parse(String(init?.body)) });

      return jsonResponse({ access_token: `forward-${seen.length}`, expires_in: life });
    }) as unknown as typeof fetch;
    const input = { api: "https://www.extension.dev", login: "device-login", project: "acme/web", resource: "https://mcp.extension.dev/mcp/forward", fetchImpl };

    const first = await forwardCredential(input);
    const second = await forwardCredential(input);

    expect(first).toMatchObject({ ok: true, cached: false, credential: { token: "forward-1" } });
    expect(second).toMatchObject({ ok: true, cached: true, credential: { token: "forward-1" } });
    expect(seen).toEqual([{ url: "https://www.extension.dev/api/cli/forward/exchange", authorization: "Bearer device-login", redirect: "manual", body: { resource: input.resource } }]);

    forgetForwardCredentials();
    life = 30;
    await forwardCredential(input);
    expect((await forwardCredential(input)) as { cached: boolean }).toMatchObject({ cached: false, credential: { token: "forward-3" } });
  });

  it("keeps nothing from a refused exchange", async () => {
    let status = 503;
    const fetchImpl = (async () => jsonResponse({ code: "FORWARD_LANE_CLOSED", message: "The hosted lane is off." }, status)) as unknown as typeof fetch;
    const input = { api: "https://www.extension.dev", login: "device-login", project: null, resource: "https://mcp.extension.dev/mcp/forward", fetchImpl };

    expect(await forwardCredential(input)).toEqual({ ok: false, status: 503, code: "FORWARD_LANE_CLOSED", message: "The hosted lane is off." });

    status = 401;
    expect(await forwardCredential(input)).toMatchObject({ ok: false, status: 401 });
  });

  it("keeps the in-process path while the switch is off, and refuses with the switch's name when www has no open lane", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ code: "FORWARD_LANE_CLOSED", message: "The lane is off." }, 503)) as unknown as typeof fetch;
    const deps = { env: { EXTENSION_DEV_HOSTED: "1" }, fetchImpl, resolveLogin: () => ({ token: "device-login", ref: { workspace: "acme", project: "web" } }) };
    const local: (args: Record<string, unknown>) => Promise<string> = async () => "local";

    expect(await forwardable({ schema: { name: "extension_builds", description: "", inputSchema: {} }, handler: local }, { ...deps, env: {} }).handler({})).toBe("local");
    expect(fetchImpl).not.toHaveBeenCalled();

    const off = JSON.parse(await forwardCall("extension_release_status", {}, local, deps));
    expect(off).toMatchObject({ ok: false, status: "hosted-off", error: { code: "E_TOOL_DISABLED" }, hint: expect.stringContaining("Unset EXTENSION_DEV_HOSTED") });
    expect(JSON.parse(await forwardCall("extension_release_status", { api: "https://staging.extension.dev" }, local, deps))).toMatchObject({ status: "hosted-unpaired" });
  });
});
