import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { handler as builds, schema } from "../tools/builds";
import { TOOL_POLICY } from "../lib/tool-policy";
import { writeCredentials } from "../lib/credentials";

const API = "http://localhost:3100";
const PROJECT_ID = "prj_probe";
const SETTINGS_ROUTE = `/api/projects/${PROJECT_ID}/settings/build`;
const DISPATCH_ROUTE = `/api/projects/${PROJECT_ID}/builds/dispatch`;
const CHANNELS_ROUTE = `/api/projects/${PROJECT_ID}/channels`;

type Reply = { body: unknown; status?: number; headers?: Record<string, string> };
type Call = { url: string; method: string; auth: string; body: any };

function reply({ body, status = 200, headers = {} }: Reply): Response {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));

  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => lower[name.toLowerCase()] ?? null },
    text: async () => JSON.stringify(body),
    json: async () => body,
  } as unknown as Response;
}

const CURRENT = {
  chrome: { enabled: true, installCommand: "npm install", buildCommand: "npm run build -- --browser chrome", outputDirectory: "dist/chrome" },
  edge: { enabled: false, installCommand: "npm install", buildCommand: "npm run build -- --browser edge", outputDirectory: "dist/edge" },
  firefox: { enabled: true, installCommand: "npm install", buildCommand: "npm run build -- --browser firefox", outputDirectory: "dist/firefox" },
  safari: { enabled: false, installCommand: "", buildCommand: "", outputDirectory: "" },
};

const sha256 = (text: string) => crypto.createHash("sha256").update(text).digest("hex");

function digestOf(settings: Record<string, any>): string {
  const canonical: Record<string, unknown> = {};

  for (const browser of ["chrome", "edge", "firefox", "safari"]) {
    const config = settings[browser];
    if (!config) continue;

    canonical[browser] = {
      enabled: config.enabled,
      installCommand: config.installCommand,
      buildCommand: config.buildCommand,
      outputDirectory: config.outputDirectory,
    };
  }

  return sha256(JSON.stringify(canonical));
}

describe("extension_builds starts a rebuild, changes build settings with an approval, and adds a channel", () => {
  let tmp: string;
  let prevXdg: string | undefined;
  let prevApi: string | undefined;
  let prevFetch: typeof fetch;
  let calls: Call[];
  let routes: Record<string, (call: Call) => Reply>;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "extdev-builds-acts-"));
    prevXdg = process.env.XDG_CONFIG_HOME;
    prevApi = process.env.EXTENSION_DEV_API_URL;
    delete process.env.EXTENSION_DEV_API_URL;
    process.env.XDG_CONFIG_HOME = tmp;
    prevFetch = global.fetch;
    calls = [];
    routes = {
      "GET /api/cli/whoami": () => ({
        body: { login: "acme/widget", live: true, projectId: PROJECT_ID, workspaceSlug: "acme", projectSlug: "widget" },
      }),
      [`GET ${SETTINGS_ROUTE}`]: () => ({
        body: { buildSettings: CURRENT, enabledBrowsers: { chrome: true, edge: false, firefox: true, safari: false } },
      }),
    };

    global.fetch = (async (url: string, init?: RequestInit) => {
      const target = String(url);
      const headers = (init?.headers ?? {}) as Record<string, string>;
      const method = String(init?.method ?? "GET").toUpperCase();
      const call: Call = {
        url: target,
        method,
        auth: String(headers.authorization ?? ""),
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      };
      calls.push(call);
      const route = routes[`${method} ${new URL(target).pathname}`];

      return reply(route ? route(call) : { body: { message: "not found" }, status: 404 });
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

  it("offers rebuild, configure and create-channel beside the reads, and is no longer a read-only tool", () => {
    expect(schema.inputSchema.properties.action.enum).toEqual(["list", "get", "logs", "rebuild", "configure", "create-channel"]);
    expect(TOOL_POLICY.extension_builds.annotations).toMatchObject({ readOnlyHint: false, openWorldHint: true });
    expect(TOOL_POLICY.extension_builds.ships).toBeUndefined();
    expect(TOOL_POLICY.extension_builds.untrusted).toBe(true);
  });

  it("rebuild dispatches as the agent, never forces, and says how to follow the run", async () => {
    if (process.platform === "win32") return;

    login();
    routes[`POST ${DISPATCH_ROUTE}`] = () => ({
      body: { ok: true, branch: "main", commit: "603fc8a", browsers: "chrome,firefox", origin: "mcp" },
    });

    const out = JSON.parse(await builds({ action: "rebuild", buildId: "603fc8a", buildEnv: "production", api: API }));
    const dispatch = calls.find((call) => call.method === "POST");

    expect(dispatch?.url).toBe(`${API}${DISPATCH_ROUTE}`);
    expect(dispatch?.body).toEqual({ origin: "mcp", buildEnv: "production", commitSha: "603fc8a" });
    expect(dispatch?.auth).toBe("Bearer claims.sig");
    expect(out.ok).toBe(true);
    expect(out.status).toBe("dispatched");
    expect(out.value).toMatchObject({ action: "rebuild", commit: "603fc8a", branch: "main", browsers: ["chrome", "firefox"], buildEnv: "production" });
    expect(out.hint).toContain("real build");
    expect(out.hint).toContain('action:"get"');
    expect(out.value.follow).toMatchObject({ list: { action: "list" }, get: { action: "get", buildId: "603fc8a" } });
  });

  it("rebuild refuses an unknown build environment before asking the platform", async () => {
    login();

    const out = JSON.parse(await builds({ action: "rebuild", buildEnv: "qa", api: API }));

    expect(out.ok).toBe(false);
    expect(out.error.code).toBe("E_BAD_REQUEST");
    expect(calls).toHaveLength(0);
  });

  it("rebuild passes on the burst cap with the wait the platform asked for", async () => {
    if (process.platform === "win32") return;

    login();
    routes[`POST ${DISPATCH_ROUTE}`] = () => ({
      body: { code: "burst_cap", message: "Too many builds in the last hour." },
      status: 429,
      headers: { "Retry-After": "120" },
    });

    const out = JSON.parse(await builds({ action: "rebuild", api: API }));

    expect(out.ok).toBe(false);
    expect(out.status).toBe("rate-limited");
    expect(out.error.platformCode).toBe("burst_cap");
    expect(out.value.retryAfterSeconds).toBe(120);
    expect(out.hint).toContain("120 seconds");
  });

  it("rebuild that would replace a live channel's artifacts names the matching environment", async () => {
    if (process.platform === "win32") return;

    login();
    routes[`POST ${DISPATCH_ROUTE}`] = () => ({
      body: { code: "REBUILD_REPLACES_LIVE_ARTIFACT", message: "Commit 603fc8a is live on stable (requires production)." },
      status: 409,
    });

    const out = JSON.parse(await builds({ action: "rebuild", buildId: "603fc8a", api: API }));

    expect(out.ok).toBe(false);
    expect(out.status).toBe("refused");
    expect(out.error.platformCode).toBe("REBUILD_REPLACES_LIVE_ARTIFACT");
    expect(out.hint).toContain("buildEnv");
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(1);
  });

  it("configure merges a partial change into the current settings and asks an owner to approve the server's diff", async () => {
    if (process.platform === "win32") return;

    login();
    const merged = { chrome: CURRENT.chrome, edge: CURRENT.edge, firefox: { ...CURRENT.firefox, buildCommand: "pnpm build --browser firefox" } };
    const digest = digestOf(merged);
    const approvalRequest = {
      action: "extension_settings.build",
      scope: { settingsDigest: digest },
      fingerprint: sha256(`extension_settings.build\nsettingsDigest=${digest}`),
    };
    routes[`PUT ${SETTINGS_ROUTE}`] = () => ({
      body: { code: "APPROVAL_REQUIRED", message: "needs approval", approvalRequest },
      status: 403,
    });

    routes["POST /api/cli/approvals"] = () => ({
      status: 201,
      body: {
        approvalId: "apr_1",
        approvalUrl: "http://localhost:3100/approve/apr_1",
        expiresAt: "2026-10-11T20:00:00.000Z",
        description: 'Change the build settings of widget: firefox.buildCommand: "npm run build -- --browser firefox" -> "pnpm build --browser firefox"',
        changes: ['firefox.buildCommand: "npm run build -- --browser firefox" -> "pnpm build --browser firefox"'],
      },
    });

    const out = JSON.parse(
      await builds({ action: "configure", buildSettings: { firefox: { buildCommand: "pnpm build --browser firefox" } }, api: API }),
    );
    const put = calls.find((call) => call.method === "PUT");
    const post = calls.find((call) => call.method === "POST");

    expect(put?.body).toEqual({ buildSettings: merged });
    expect(post?.body).toMatchObject({ ...approvalRequest, buildSettings: merged });
    expect(typeof post?.body.description).toBe("string");
    expect(out.ok).toBe(false);
    expect(out.status).toBe("approval-required");
    expect(out.value).toMatchObject({
      approvalId: "apr_1",
      approvalUrl: "http://localhost:3100/approve/apr_1",
      changes: ['firefox.buildCommand: "npm run build -- --browser firefox" -> "pnpm build --browser firefox"'],
    });

    expect(out.error.message).toContain("approvalId apr_1");
    expect(out.error.message).not.toContain("irreversible");
  });

  it("configure sends safari only when the change names it", async () => {
    if (process.platform === "win32") return;

    login();
    routes[`PUT ${SETTINGS_ROUTE}`] = () => ({ body: { ok: true } });

    await builds({ action: "configure", buildSettings: { safari: { enabled: true } }, api: API });
    const put = calls.find((call) => call.method === "PUT");

    expect(Object.keys(put?.body.buildSettings ?? {})).toEqual(["chrome", "edge", "firefox", "safari"]);
    expect(put?.body.buildSettings.safari).toEqual({ ...CURRENT.safari, enabled: true });
  });

  it("configure refuses a browser or field the settings do not have before any write", async () => {
    if (process.platform === "win32") return;

    login();

    const out = JSON.parse(await builds({ action: "configure", buildSettings: { chrome: { buildCmd: "x" } }, api: API }));

    expect(out.ok).toBe(false);
    expect(out.error.code).toBe("E_BAD_REQUEST");
    expect(out.error.message).toContain("buildCmd");
    expect(calls.some((call) => call.method !== "GET")).toBe(false);
  });

  it("configure passes on the platform's own validation refusal, before any approval is requested", async () => {
    if (process.platform === "win32") return;

    login();
    routes[`PUT ${SETTINGS_ROUTE}`] = () => ({ body: { message: "chrome.enabled must be a boolean" }, status: 400 });

    const out = JSON.parse(await builds({ action: "configure", buildSettings: { chrome: { enabled: "yes" } }, api: API }));

    expect(out.ok).toBe(false);
    expect(out.status).toBe("bad-request");
    expect(out.error.message).toContain("chrome.enabled must be a boolean");
    expect(calls.some((call) => call.url.endsWith("/api/cli/approvals"))).toBe(false);
  });

  it("configure with an approval that is still pending says to approve and call again, and writes nothing", async () => {
    if (process.platform === "win32") return;

    login();
    routes["GET /api/cli/approvals/apr_1"] = () => ({ body: { status: "pending", used: false } });

    const out = JSON.parse(
      await builds({ action: "configure", buildSettings: { firefox: { buildCommand: "pnpm build" } }, approvalId: "apr_1", api: API }),
    );

    expect(out.status).toBe("approval-pending");
    expect(calls.some((call) => call.method === "PUT")).toBe(false);
  });

  it("configure with a used approval says to read the settings first", async () => {
    if (process.platform === "win32") return;

    login();
    const merged = { chrome: CURRENT.chrome, edge: CURRENT.edge, firefox: { ...CURRENT.firefox, buildCommand: "pnpm build" } };
    const fingerprint = sha256(`extension_settings.build\nsettingsDigest=${digestOf(merged)}`);
    routes["GET /api/cli/approvals/apr_1"] = () => ({
      body: { status: "approved", used: true, fingerprint, expiresAt: new Date(Date.now() + 60_000).toISOString() },
    });

    const out = JSON.parse(
      await builds({ action: "configure", buildSettings: { firefox: { buildCommand: "pnpm build" } }, approvalId: "apr_1", api: API }),
    );

    expect(out.error.name).toBe("ApprovalConsumed");
    expect(out.error.message).toContain("extension_workspace");
    expect(calls.some((call) => call.method === "PUT")).toBe(false);
  });

  it("configure with an approved approval writes the merged settings once", async () => {
    if (process.platform === "win32") return;

    login();
    const merged = { chrome: CURRENT.chrome, edge: CURRENT.edge, firefox: { ...CURRENT.firefox, buildCommand: "pnpm build" } };
    const fingerprint = sha256(`extension_settings.build\nsettingsDigest=${digestOf(merged)}`);
    routes["GET /api/cli/approvals/apr_1"] = () => ({
      body: { status: "approved", used: false, fingerprint, expiresAt: new Date(Date.now() + 60_000).toISOString() },
    });

    routes[`PUT ${SETTINGS_ROUTE}`] = () => ({ body: { ok: true } });

    const out = JSON.parse(
      await builds({ action: "configure", buildSettings: { firefox: { buildCommand: "pnpm build" } }, approvalId: "apr_1", api: API }),
    );
    const puts = calls.filter((call) => call.method === "PUT");

    expect(puts).toHaveLength(1);
    expect(puts[0].body).toEqual({ buildSettings: merged, approvalId: "apr_1" });
    expect(out.ok).toBe(true);
    expect(out.status).toBe("configured");
  });

  it("create-channel adds the channel and answers with the project's channels", async () => {
    if (process.platform === "win32") return;

    login();
    routes[`POST ${CHANNELS_ROUTE}`] = () => ({
      body: { id: "beta", name: "beta", description: "", color: "#22c55e", createdAt: "2026-10-11T18:00:00.000Z" },
    });

    routes[`GET ${CHANNELS_ROUTE}`] = () => ({
      body: [
        { id: "beta", name: "beta" },
        { id: "stable", name: "stable" },
      ],
    });

    const out = JSON.parse(await builds({ action: "create-channel", channel: "beta", color: "#22c55e", api: API }));
    const post = calls.find((call) => call.method === "POST");

    expect(post?.body).toEqual({ name: "beta", color: "#22c55e" });
    expect(out.ok).toBe(true);
    expect(out.status).toBe("created");
    expect(out.value.channel).toMatchObject({ id: "beta", name: "beta" });
    expect(out.value.channels.map((c: any) => c.name)).toEqual(["beta", "stable"]);
    expect(out.hint).toContain("extension_release_promote");
  });

  it("create-channel reads an existing channel as already there, not as a failure", async () => {
    if (process.platform === "win32") return;

    login();
    routes[`POST ${CHANNELS_ROUTE}`] = () => ({ body: { message: "Channel already exists" }, status: 409 });
    routes[`GET ${CHANNELS_ROUTE}`] = () => ({ body: [{ id: "beta", name: "beta" }] });

    const out = JSON.parse(await builds({ action: "create-channel", channel: "beta", api: API }));

    expect(out.ok).toBe(true);
    expect(out.status).toBe("exists");
    expect(out.value.created).toBe(false);
  });

  it("create-channel without a name is refused before any request", async () => {
    login();

    const out = JSON.parse(await builds({ action: "create-channel", api: API }));

    expect(out.ok).toBe(false);
    expect(out.error.code).toBe("E_BAD_REQUEST");
    expect(calls).toHaveLength(0);
  });

  it("create-channel passes the audience asked for and reports the one the platform gave", async () => {
    if (process.platform === "win32") return;

    login();
    routes[`POST ${CHANNELS_ROUTE}`] = () => ({
      body: { id: "beta", name: "beta", description: "", color: "#22c55e", createdAt: "2026-10-18T18:00:00.000Z", audience: "public" },
    });

    routes[`GET ${CHANNELS_ROUTE}`] = () => ({ body: [{ id: "beta", name: "beta", audience: "public" }] });

    const out = JSON.parse(await builds({ action: "create-channel", channel: "beta", audience: "public", api: API } as never));
    const post = calls.find((call) => call.method === "POST");

    expect(post?.body).toEqual({ name: "beta", audience: "public" });
    expect(out.value.channel.audience).toBe("public");
    expect(out.warnings).toEqual([]);
  });

  it("create-channel says so when the platform gave the channel another audience than the one asked for", async () => {
    if (process.platform === "win32") return;

    login();
    routes[`POST ${CHANNELS_ROUTE}`] = () => ({
      body: { id: "beta", name: "beta", description: "", color: "#22c55e", createdAt: "2026-10-18T18:00:00.000Z", audience: "private" },
    });

    routes[`GET ${CHANNELS_ROUTE}`] = () => ({ body: [{ id: "beta", name: "beta", audience: "private" }] });

    const out = JSON.parse(await builds({ action: "create-channel", channel: "beta", audience: "public", api: API } as never));

    expect(out.ok).toBe(true);
    expect(out.status).toBe("created");
    expect(out.warnings.join(" ")).toMatch(/private, not public/);
    expect(out.warnings.join(" ")).toMatch(/Audience control on the console Releases page/);
  });

  it("create-channel leaves the audience to the project's visibility when none is asked for", async () => {
    if (process.platform === "win32") return;

    login();
    routes[`POST ${CHANNELS_ROUTE}`] = () => ({ body: { id: "beta", name: "beta", audience: "private" } });
    routes[`GET ${CHANNELS_ROUTE}`] = () => ({ body: [{ id: "beta", name: "beta", audience: "private" }] });

    const out = JSON.parse(await builds({ action: "create-channel", channel: "beta", api: API }));
    const post = calls.find((call) => call.method === "POST");

    expect(post?.body).toEqual({ name: "beta" });
    expect(out.warnings).toEqual([]);
  });

  it("create-channel refuses an audience other than public or private before any request", async () => {
    login();

    const out = JSON.parse(await builds({ action: "create-channel", channel: "beta", audience: "secret", api: API } as never));

    expect(out.ok).toBe(false);
    expect(out.error.code).toBe("E_BAD_REQUEST");
    expect(out.error.message).toMatch(/public or private/);
    expect(calls).toHaveLength(0);
  });

  it("names audience in the schema with the two values and the project's visibility as the default", () => {
    const audience = (schema.inputSchema.properties as Record<string, any>).audience;

    expect(audience.enum).toEqual(["public", "private"]);
    expect(audience.description).toMatch(/project's visibility/);
  });
});
