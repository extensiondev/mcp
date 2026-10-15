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
import { credentialsPath, writeCredentials } from "../lib/credentials";
import { tools } from "../index";
import { PROJECT, WWW, stubPlatformFetch } from "./hosted-platform-fetch";

const REQUEST_TOKEN = "request-bearer-token";
const credential = { token: REQUEST_TOKEN, api: WWW, projects: [PROJECT], expiresAt: 4102444800 };

const ALLOWED = [
  "extension_auth",
  "extension_builds",
  "extension_project_create",
  "extension_release_promote",
  "extension_release_status",
  "extension_shares",
  "extension_workspace",
];

const NEVER = [
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
    await call(client, "extension_shares", { action: "list" });
    await call(client, "extension_auth", {});

    const toWww = seen.filter((request) => request.url.startsWith(WWW));
    expect(toWww.length).toBeGreaterThan(2);
    for (const request of toWww) expect(request.authorization).toBe(`Bearer ${REQUEST_TOKEN}`);
    expect(seen.map((request) => request.authorization)).not.toContain("Bearer disk-token");
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
