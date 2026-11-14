// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HOSTED_TOOL_NAMES, createHostedServer, registerHostedTools } from "../hosted";
import { setApprovalOpener } from "../lib/approval-open";
import { loginIdOf } from "../lib/credential-source";
import { credentialsPath, writeCredentials } from "../lib/credentials";
import { envelope as envelopeOf } from "../lib/envelope";
import { forgetForwardCredentials } from "../lib/forward-credential";
import { forwardCall } from "../lib/hosted-forwarder";
import { createToolDispatcher } from "../lib/tool-dispatch";
import { tools } from "../index";
import { APPROVAL, PROJECT, WWW, stubPlatformFetch } from "./hosted-platform-fetch";

const REQUEST_TOKEN = "request-bearer-token";
const credential = { token: REQUEST_TOKEN, api: WWW, projects: [PROJECT], expiresAt: 4102444800 };

const ALLOWED = [
  "extension_auth",
  "extension_builds",
  "extension_project_create",
  "extension_release_promote",
  "extension_release_status",
  "extension_workspace",
];

const NEVER = [
  "extension_shares",
  "extension_publish",
  "extension_submit",
  "extension_preview_web",
  "extension_workspace_create",
  "extension_dev",
  "extension_start",
  "extension_browsers",
  "extension_inspect",
  "extension_reload",
  "extension_build",
  "extension_eval",
  "extension_storage",
  "extension_network",
  "extension_open",
  "extension_logs",
  "extension_create",
];

let tmp = "";
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "extdev-hosted-"));
  for (const key of ["XDG_CONFIG_HOME", "EXTENSION_DEV_TOKEN", "EXTENSION_DEV_PROJECT", "EXTENSION_DEV_API_URL"]) saved[key] = process.env[key];
  process.env.XDG_CONFIG_HOME = tmp;
  delete process.env.EXTENSION_DEV_TOKEN;
  delete process.env.EXTENSION_DEV_PROJECT;
  delete process.env.EXTENSION_DEV_API_URL;
});

afterEach(() => {
  vi.unstubAllGlobals();
  forgetForwardCredentials();

  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  fs.rmSync(tmp, { recursive: true, force: true });
});

async function hostedClient(): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await createHostedServer({ credential }).connect(serverTransport);
  const client = new Client({ name: "hosted-probe", version: "0.0.0" });
  await client.connect(clientTransport);

  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content as Array<{ text: string }>)[0]?.text ?? "";

  return { result, envelope: JSON.parse(text) };
}

describe("hosted tool surface", () => {
  it("lists exactly the allowed platform tools", async () => {
    const listed = (await (await hostedClient()).listTools()).tools.map((tool) => tool.name).sort();

    expect(listed).toEqual(ALLOWED);
    expect([...HOSTED_TOOL_NAMES].sort()).toEqual(ALLOWED);
  });

  it("lists none of the local, login, publish or submit tools", async () => {
    const listed = (await (await hostedClient()).listTools()).tools.map((tool) => tool.name);

    for (const name of NEVER) expect(listed).not.toContain(name);

    for (const tool of tools) {
      if (!ALLOWED.includes(tool.schema.name)) expect(listed).not.toContain(tool.schema.name);
    }
  });

  it("offers no api or local path input, only status on auth, and no usage on workspace", async () => {
    const listed = (await (await hostedClient()).listTools()).tools;

    for (const tool of listed) {
      const properties = Object.keys(tool.inputSchema.properties ?? {});
      expect(properties).not.toContain("api");
      expect(properties).not.toContain("projectPath");
    }

    const auth = listed.find((tool) => tool.name === "extension_auth")!;
    expect((auth.inputSchema.properties as any).action.enum).toEqual(["status"]);
    expect(auth.description).not.toMatch(/action:'login'/);
    const workspace = listed.find((tool) => tool.name === "extension_workspace")!;
    expect((workspace.inputSchema.properties as any).action.enum).not.toContain("usage");
    const create = listed.find((tool) => tool.name === "extension_project_create")!;
    expect(Object.keys(create.inputSchema.properties ?? {})).not.toContain("projects");
  });

  it("lists a title and explicit hints on every tool, read-only where the hosted actions only read", async () => {
    const listed = (await (await hostedClient()).listTools()).tools;
    const readOnly = new Set(["extension_auth", "extension_workspace", "extension_release_status"]);

    for (const tool of listed) {
      expect(tool.title, tool.name).toMatch(/^[A-Z]/);
      expect(tool.annotations?.title, tool.name).toBe(tool.title);

      for (const hint of ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"]) {
        expect(typeof (tool.annotations as Record<string, unknown> | undefined)?.[hint], `${tool.name}.${hint}`).toBe("boolean");
      }

      expect(tool.annotations?.readOnlyHint, tool.name).toBe(readOnly.has(tool.name));

      if (readOnly.has(tool.name)) expect(tool.annotations?.destructiveHint, tool.name).toBe(false);

      expect(tool.name.length, tool.name).toBeLessThanOrEqual(64);
    }

    const auth = listed.find((tool) => tool.name === "extension_auth")!;
    expect(auth.title).toBe("Read the signed-in identity");
    const workspace = listed.find((tool) => tool.name === "extension_workspace")!;
    expect(workspace.title).toBe("Read the workspace");
    expect(workspace.description).not.toMatch(/change a project's settings/);
    expect(workspace.description).not.toMatch(/every project|build allowance and what is used/);
    const builds = listed.find((tool) => tool.name === "extension_builds")!;
    expect((builds.inputSchema.properties as any).action.enum).not.toContain("download");
    expect(Object.keys(builds.inputSchema.properties ?? {})).not.toContain("to");
  });

  it("answers approval-required with the approval page and the same call again, naming no tool the hosted server does not serve", async () => {
    stubPlatformFetch();
    const client = await hostedClient();
    const { result, envelope } = await call(client, "extension_release_promote", { buildId: "abc1234", channel: "stable" });
    const text = (result.content as Array<{ text: string }>)[0]?.text ?? "";

    expect(envelope.status).toBe("approval-required");
    expect(envelope.value.approvalId).toBe(APPROVAL.approvalId);
    expect(envelope.hint).toBe(
      `Open ${APPROVAL.approvalUrl} in the browser and approve it there, then call extension_release_promote again with the same arguments and approvalId ${APPROVAL.approvalId}.`,
    );

    expect(envelope.error.message).toContain("Nothing was executed.");
    expect(text).not.toContain("extension_approvals");
  });

  it("names the console sign-in, not a login action, in the hosted projects hint", async () => {
    stubPlatformFetch();
    const client = await hostedClient();
    const { result, envelope } = await call(client, "extension_workspace", { action: "projects" });
    const text = (result.content as Array<{ text: string }>)[0]?.text ?? "";

    expect(envelope.status).toBe("listed");
    expect(envelope.hint.startsWith("acme has 2 projects; the last build failed for acme/web.")).toBe(true);
    expect(envelope.hint).toContain("sign in again from your MCP client");
    expect(text).not.toMatch(/extension_auth|action: "login"|on this machine/);
  });

  it("never names a tool or action the hosted list does not serve in a hint, a next step or a spoken line", async () => {
    stubPlatformFetch();
    const client = await hostedClient();
    const listed = (await client.listTools()).tools;
    const served = new Map(
      listed.map((tool) => [tool.name, ((tool.inputSchema.properties as any)?.action?.enum as string[] | undefined) ?? null]),
    );
    const calls: Array<[string, Record<string, unknown>]> = [
      ["extension_auth", {}],
      ["extension_workspace", { action: "info" }],
      ["extension_workspace", { action: "projects" }],
      ["extension_workspace", { action: "settings" }],
      ["extension_builds", { action: "list" }],
      ["extension_release_status", {}],
      ["extension_release_promote", { buildId: "abc1234", channel: "stable" }],
      ["extension_project_create", { repo: "acme/new", workspace: "acme", name: "new" }],
    ];

    for (const [name, args] of calls) {
      const { envelope } = await call(client, name, args);
      const value = envelope.value && typeof envelope.value === "object" ? envelope.value : {};
      const spoken = [envelope.hint, envelope.error?.message, value.nextStep?.say, value.sayToPerson, ...(envelope.warnings ?? [])].filter(
        (line): line is string => typeof line === "string",
      );

      for (const line of spoken) {
        for (const match of line.matchAll(/(extension_[a-z_]+)(?:\s*[({]\s*action:\s*"([a-z-]+)")?/g)) {
          const [, tool, action] = match;

          expect([...served.keys()], `${name}: ${line}`).toContain(tool);

          if (action) expect(served.get(tool) ?? [action], `${name}: ${line}`).toContain(action);
        }
      }
    }
  });

  it("answers unknown-tool for a forbidden tool called by name", async () => {
    const client = await hostedClient();

    for (const name of ["extension_publish", "extension_submit", "extension_dev"]) {
      const { result, envelope } = await call(client, name, {});
      expect(result.isError).toBe(true);
      expect(envelope.error.code).toBe("E_UNKNOWN_TOOL");
    }
  });

  it("refuses login, logout and an api override before any request is made", async () => {
    const seen = stubPlatformFetch();
    const client = await hostedClient();

    for (const action of ["login", "logout"]) {
      const { result, envelope } = await call(client, "extension_auth", { action, project: "acme/web" });
      expect(result.isError).toBe(true);
      expect(envelope.status).toBe("hosted-unavailable");
    }

    const redirected = await call(client, "extension_builds", { action: "list", api: "https://www.extension.dev.evil.example" });
    expect(redirected.envelope.status).toBe("hosted-unavailable");
    expect(redirected.envelope.value.inputs).toEqual(["api"]);
    expect(seen).toEqual([]);
  });

  it("forwards the request Bearer unchanged and never the token stored on disk", async () => {
    writeCredentials({ version: 1, token: "disk-token", workspaceSlug: "acme", projectSlug: "web", expiresAt: 4102444800, api: WWW });
    const seen = stubPlatformFetch();
    const client = await hostedClient();

    await call(client, "extension_builds", { action: "list" });
    await call(client, "extension_release_status", {});
    await call(client, "extension_auth", {});

    const toWww = seen.filter((request) => request.url.startsWith(WWW));
    expect(toWww.length).toBeGreaterThan(2);
    for (const request of toWww) expect(request.authorization).toBe(`Bearer ${REQUEST_TOKEN}`);
    expect(seen.map((request) => request.authorization)).not.toContain("Bearer disk-token");
  });

  it("names the project on every platform call, so one connected-app token reaches each of its projects", async () => {
    const seen = stubPlatformFetch();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await createHostedServer({
      credential: { token: "oauth-multi", api: WWW, projects: [PROJECT, { workspace: "acme", project: "docs" }], expiresAt: 4102444800 },
    }).connect(serverTransport);

    const client = new Client({ name: "hosted-probe", version: "0.0.0" });
    await client.connect(clientTransport);

    for (const [project, projectId, expected] of [
      ["acme/docs", "prj_hosted2", "acme/docs"],
      ["docs", "prj_hosted2", "acme/docs"],
      [undefined, "prj_hosted1", "acme/web"],
    ] as const) {
      seen.length = 0;
      const { envelope } = await call(client, "extension_builds", { action: "list", ...(project ? { project } : {}) });

      expect(envelope.ok).toBe(true);
      const toWww = seen.filter((request) => request.url.startsWith(WWW));
      expect(toWww.length).toBeGreaterThan(0);
      for (const request of toWww) expect(request.project).toBe(expected);
      expect(toWww.some((request) => request.url.includes(`/api/projects/${projectId}/builds`))).toBe(true);
      expect(seen.filter((request) => !request.url.startsWith(WWW)).every((request) => request.project === null)).toBe(true);
    }
  });

  it("describes the connection, not CLI token lifetimes, in a hosted status", async () => {
    stubPlatformFetch();
    const client = await hostedClient();
    const { result, envelope } = await call(client, "extension_auth", {});
    const text = (result.content as Array<{ text: string }>)[0]?.text ?? "";

    expect(envelope.ok).toBe(true);
    expect(text).not.toMatch(/7 days|re-mint|Access tokens page|CLI tokens/i);
    expect(text).not.toMatch(/stored on this machine/);
    expect(envelope.warnings).toContain(
      "This connection renews on its own. Revoke it under the project's Settings, Connected apps: https://console.extension.dev/acme/web/settings/connected-apps",
    );
  });

  it("stores and removes no login on disk while a request credential is in scope", async () => {
    stubPlatformFetch();
    const client = await hostedClient();

    await call(client, "extension_auth", {});
    expect(fs.existsSync(credentialsPath())).toBe(false);
  });

  it("registers the same set on an McpServer instance", async () => {
    const mcp = new McpServer({ name: "app", version: "0.0.0" }, { capabilities: { tools: {} } });
    registerHostedTools(mcp, { credential, tools: ["extension_release_status"] });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await mcp.connect(serverTransport);
    const client = new Client({ name: "hosted-probe", version: "0.0.0" });
    await client.connect(clientTransport);

    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(["extension_release_status"]);
    expect(() => registerHostedTools(new McpServer({ name: "x", version: "0" }), { credential, tools: ["extension_publish"] })).toThrow(/Not a hosted tool/);
  });
});

const LANE = "https://mcp.extension.dev/mcp/forward";
const LISTED = JSON.parse(envelopeOf({ ok: true, command: "extension_builds", status: "listed", value: { builds: [] } }));
const FORWARDING = { env: { EXTENSION_DEV_HOSTED: "1" }, version: "11.0.0", resolveLogin: () => ({ token: "device-login", ref: PROJECT }) };

function stubLane(answers: unknown[], exchange = 200) {
  const seen: Array<{ url: string; headers: Record<string, string>; body: any }> = [];
  vi.stubGlobal("fetch", async (input: unknown, init?: RequestInit) => {
    seen.push({ url: String(input), headers: Object.fromEntries(new Headers(init?.headers).entries()), body: JSON.parse(String(init?.body ?? "null")) });
    const exchanged = seen.filter((hit) => hit.url.endsWith("/api/cli/forward/exchange")).length;

    if (String(input).endsWith("/api/cli/forward/exchange")) return new Response(JSON.stringify(exchange === 200 ? { access_token: `forward-${exchanged}`, expires_in: 600 } : { code: "FORWARD_LANE_CLOSED", message: "The lane is off." }), { status: exchange });

    const next = answers.shift();

    if (next instanceof Error) throw next;

    return new Response(JSON.stringify(next), { status: 200 });
  });

  return { seen, lane: () => seen.filter((hit) => hit.url === LANE) };
}

describe("the forwarder", () => {
  it("sends the lane a project ref, a forward credential and one key, never the login, api or path", async () => {
    const { seen, lane } = stubLane([LISTED, LISTED]);
    const local = vi.fn(async () => "local");
    const out = await forwardCall("extension_builds", { action: "list", project: "acme/web", projectPath: "/work/web", api: WWW }, local, FORWARDING);
    await forwardCall("extension_builds", { action: "list", project: "acme/web" }, local, FORWARDING);
    const [first, second] = lane();

    expect(JSON.parse(out)).toEqual(LISTED);
    expect(local).not.toHaveBeenCalled();
    expect(seen.filter((hit) => hit.url.endsWith("/exchange"))).toHaveLength(1);
    expect(first?.headers).toMatchObject({ authorization: "Bearer forward-1", "x-extensiondev-forwarder": "11.0.0", "x-extensiondev-project": "acme/web" });
    expect(first?.headers["idempotency-key"]).toMatch(/^[A-Za-z0-9_-]{16,128}$/);
    expect(second?.headers["idempotency-key"]).not.toBe(first?.headers["idempotency-key"]);
    expect(first?.body).toEqual({ tool: "extension_builds", args: { action: "list", project: "acme/web" } });
    expect(lane().map((hit) => hit.headers.authorization)).not.toContain("Bearer device-login");
  });

  it("sends the submit facts it read here, and runs a step that writes to this machine here", async () => {
    const { lane } = stubLane([LISTED]);
    const local = vi.fn(async () => "local");
    await forwardCall("extension_submit_check", { action: "preflight", browsers: ["chrome"], projectPath: tmp }, local, FORWARDING);

    expect(lane()[0]?.body.args.local.facts.project).toMatchObject({ exists: true });
    expect(lane()[0]?.body.args).not.toHaveProperty("projectPath");

    for (const [tool, args] of [["extension_builds", { action: "download", buildId: "abc1234" }], ["extension_auth", { action: "login" }], ["extension_preview_web", {}]] as const) {
      expect(await forwardCall(tool, args, local, FORWARDING)).toBe("local");
    }

    expect(lane()).toHaveLength(1);
  });

  it("retries a lane that did not answer, and a refused cached credential, with the same key", async () => {
    const denied = { ok: false, status: "auth-refused", error: { code: "E_AUTH_DENIED", message: "Refused." } };
    const { lane } = stubLane([new Error("socket hang up"), LISTED, denied, LISTED]);
    await forwardCall("extension_builds", {}, async () => "local", FORWARDING);
    const out = await forwardCall("extension_builds", {}, async () => "local", FORWARDING);
    const keys = lane().map((hit) => hit.headers["idempotency-key"]);

    expect(JSON.parse(out)).toEqual(LISTED);
    expect(keys[0]).toBe(keys[1]);
    expect(keys[2]).toBe(keys[3]);
    expect(lane().map((hit) => hit.headers.authorization)).toEqual(["Bearer forward-1", "Bearer forward-1", "Bearer forward-1", "Bearer forward-2"]);
  });

  const WEB_LOGIN = "web.device.login";
  const DOCS_LOGIN = "docs.device.login";
  const DOCS_EXPIRES = Math.floor(Date.now() / 1000) + 2 * 24 * 3600;

  function twoLoginsDefaultWeb() {
    const entry = (projectSlug: string, token: string, expiresAt: number) => ({ version: 1 as const, token, workspaceSlug: "acme", projectSlug, expiresAt, api: WWW, provider: "extensiondev" as const });

    writeCredentials(entry("docs", DOCS_LOGIN, DOCS_EXPIRES));
    writeCredentials(entry("web", WEB_LOGIN, DOCS_EXPIRES + 24 * 3600));
  }

  function stubHostedPlatform(laneAnswer: unknown, record?: Record<string, unknown>) {
    const seen: Array<{ url: string; authorization: string | null; project: string | null; body: any }> = [];
    vi.stubGlobal("fetch", async (input: unknown, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      const hit = { url: String(input), authorization: headers.get("authorization"), project: headers.get("x-extensiondev-project"), body: JSON.parse(String(init?.body ?? "null")) };
      seen.push(hit);

      if (hit.url.endsWith("/api/cli/forward/exchange")) return new Response(JSON.stringify({ access_token: `forward-of-${String(hit.authorization).replace("Bearer ", "")}`, expires_in: 600 }), { status: 200 });

      if (hit.url.endsWith("/api/cli/forward/approvals")) {
        const held = record && hit.authorization === `Bearer forward-of-${DOCS_LOGIN}` && hit.body.approvalId === record.approvalId;

        return new Response(JSON.stringify(held ? { record } : { code: "APPROVAL_UNKNOWN" }), { status: held ? 200 : 404 });
      }

      if (hit.url.endsWith("/api/cli/whoami")) return new Response(JSON.stringify({ login: "acme/web", live: true, projectId: "prj_hosted1", workspaceSlug: "acme", projectSlug: "web" }), { status: 200 });

      return new Response(JSON.stringify(laneAnswer), { status: 200 });
    });

    return { seen, lane: () => seen.filter((hit) => hit.url === LANE) };
  }

  async function dispatched(name: string, args: Record<string, unknown>) {
    vi.stubEnv("EXTENSION_DEV_HOSTED", "1");

    try {
      const frame = await createToolDispatcher({ tools, options: { features: ["local", "platform"], noShip: false }, openApprovals: false })({ name, arguments: args });

      return JSON.parse((frame.content as Array<{ text: string }>)[0]?.text ?? "null");
    } finally {
      vi.unstubAllEnvs();
    }
  }

  it("693: makes a call that carries only approvalId as the project and login www holds the approval for", async () => {
    twoLoginsDefaultWeb();
    const record = {
      approvalId: "apr_0123456789abcdefghijklmnopqrstuv",
      workspace: "acme",
      project: "docs",
      loginId: loginIdOf(DOCS_LOGIN),
      action: "release.promote",
      fingerprint: "sha256:abc",
      approvalUrl: `${WWW}/device/approve/apr_0123456789abcdefghijklmnopqrstuv`,
      mintedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
    };
    const { seen, lane } = stubHostedPlatform(JSON.parse(envelopeOf({ ok: true, command: "extension_approvals", status: "approved", value: { approvalId: record.approvalId } })), record);
    const out = await dispatched("extension_approvals", { approvalId: record.approvalId });

    expect(out).toMatchObject({ ok: true, status: "approved" });
    expect(lane()).toHaveLength(1);
    expect(lane()[0]).toMatchObject({ authorization: `Bearer forward-of-${DOCS_LOGIN}`, project: "acme/docs" });
    expect(lane()[0]?.body.args).toMatchObject({ approvalId: record.approvalId, project: "acme/docs" });
    expect(seen.filter((hit) => hit.url.endsWith("/api/cli/forward/approvals")).map((hit) => hit.project)).toEqual(["acme/web", "acme/docs"]);
    expect(lane().map((hit) => hit.authorization)).not.toContain(`Bearer ${DOCS_LOGIN}`);
  });

  it("694: answers auth status here, with the device login's expiry and this machine's logins, and asks the lane nothing", async () => {
    twoLoginsDefaultWeb();
    const { seen, lane } = stubHostedPlatform(LISTED);
    const out = await dispatched("extension_auth", { action: "status", project: "acme/docs" });
    const all = await dispatched("extension_auth", { action: "status" });

    expect(out.command).toBe("extension_auth");
    expect(out.value).toMatchObject({ workspaceSlug: "acme", projectSlug: "docs", expiresAt: new Date(DOCS_EXPIRES * 1000).toISOString() });
    expect(out.value.expiresInSeconds).toBeGreaterThan(600);
    expect(all.value.logins.map((login: { project: string }) => login.project).sort()).toEqual(["acme/docs", "acme/web"]);
    expect(lane()).toHaveLength(0);
    expect(seen.filter((hit) => hit.url.endsWith("/api/cli/whoami")).map((hit) => hit.authorization)).toEqual([`Bearer ${DOCS_LOGIN}`, `Bearer ${WEB_LOGIN}`]);
  });

  it("697: opens the pages the lane names on this machine, https only, and under the rules an approval page obeys", async () => {
    const opened: string[] = [];
    const restore = setApprovalOpener((url) => {
      opened.push(url);

      return true;
    });
    const connectUrl = "https://console.extension.dev/acme/web/submissions/firefox/connect";
    const keyPage = "https://addons.mozilla.org/developers/addon/api/key/";
    const pending = () => JSON.parse(envelopeOf({ ok: true, command: "extension_submit", status: "connect-pending", value: { connectUrl, opened: true, openPages: [keyPage, connectUrl, "http://example.com/elsewhere", "file:///etc/hosts"] } }));

    try {
      const { lane } = stubLane([pending(), pending()]);
      const local = vi.fn(async () => "local");
      const out = JSON.parse(await forwardCall("extension_submit", { action: "connect", store: "firefox", projectPath: tmp }, local, { ...FORWARDING, platform: "darwin" }));

      expect(lane()[0]?.body.args.local.pageOpening).toEqual({ block: "" });
      expect(opened).toEqual([keyPage, connectUrl]);
      expect(out.value).toEqual({ connectUrl, opened: true });

      const headless = { ...FORWARDING, platform: "darwin" as const, env: { EXTENSION_DEV_HOSTED: "1", EXTENSION_HEADLESS: "1" } };
      const held = JSON.parse(await forwardCall("extension_submit", { action: "connect", store: "firefox", projectPath: tmp }, local, headless));

      expect(lane()[1]?.body.args.local.pageOpening.block).toContain("EXTENSION_HEADLESS=1");
      expect(opened).toHaveLength(2);
      expect(held.value).toMatchObject({ connectUrl, opened: false, openedNote: expect.stringContaining("No page was opened: EXTENSION_HEADLESS=1") });
      expect(held.value).not.toHaveProperty("openPages");
      expect(local).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });
});
