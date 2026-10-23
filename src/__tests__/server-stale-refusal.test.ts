import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createServer } from "../index";
import { writeCredentials } from "../lib/credentials";
import { createServerStamp, staleSentence, type ServerStampReader } from "../lib/server-stamp";

import { version } from "../../package.json";

const API = "http://localhost:3100";
const PROJECT_ID = "prj_probe";
const BUILT_AT = new Date("2026-10-23T14:19:47.654Z");
const REBUILT_AT = new Date("2026-10-23T15:17:33.978Z");

const BUILD_ROW = {
  id: "603fc8a",
  buildId: "603fc8a",
  commit: "603fc8ab0ff0ac1dae1c598428ce49ad43081c98",
  status: "success",
  buildEnv: "production",
  timestamp: "2026-10-11T16:45:37Z",
  branch: "main",
  browsers: ["chrome"],
  channel: "preview",
};

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    text: async () => JSON.stringify(body),
    json: async () => body,
  } as unknown as Response;
}

function entryFile(dir: string): string {
  const file = path.join(dir, "module.js");
  fs.writeFileSync(file, "export const v = 1;\n");
  fs.utimesSync(file, BUILT_AT, BUILT_AT);

  return file;
}

async function call(stamp: ServerStampReader, name: string, args: Record<string, unknown>) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await createServer({ features: ["local", "platform"], noShip: false }, { stamp }).connect(serverTransport);
  const client = new Client({ name: "stale-probe", version: "0.0.0" });
  await client.connect(clientTransport);
  const result = await client.callTool({ name, arguments: args });

  return { isError: result.isError === true, out: JSON.parse((result.content as Array<{ text: string }>)[0].text) };
}

describe("a server that knows it was rebuilt refuses platform tools before any fetch", () => {
  let tmp: string;
  let prevXdg: string | undefined;
  let prevApi: string | undefined;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "extdev-stale-"));
    prevXdg = process.env.XDG_CONFIG_HOME;
    prevApi = process.env.EXTENSION_DEV_API_URL;
    delete process.env.EXTENSION_DEV_API_URL;
    process.env.XDG_CONFIG_HOME = tmp;

    fetchSpy = vi.fn(async (url: string) => {
      const pathname = new URL(String(url)).pathname;

      if (pathname === "/api/cli/whoami") {
        return jsonResponse({ login: "acme/widget", live: true, projectId: PROJECT_ID, workspaceSlug: "acme", projectSlug: "widget" });
      }

      if (pathname === `/api/projects/${PROJECT_ID}/builds`) return jsonResponse({ items: [BUILD_ROW], latest: BUILD_ROW });

      return jsonResponse({ message: "not found" }, 404);
    });

    vi.stubGlobal("fetch", fetchSpy);

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
    vi.unstubAllGlobals();
    if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prevXdg;
    if (prevApi === undefined) delete process.env.EXTENSION_DEV_API_URL;
    else process.env.EXTENSION_DEV_API_URL = prevApi;

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("answers E_SERVER_STALE at once with the reconnect sentence and asks the platform nothing", async () => {
    if (process.platform === "win32") return;

    const file = entryFile(tmp);
    const stamp = createServerStamp(file);
    fs.utimesSync(file, REBUILT_AT, REBUILT_AT);

    const { isError, out } = await call(stamp, "extension_builds", { action: "list", api: API });

    expect(isError).toBe(true);
    expect(out.ok).toBe(false);
    expect(out.status).toBe("server-stale");
    expect(out.error).toEqual({ code: "E_SERVER_STALE", name: "ServerStale", message: staleSentence("2026-10-23T15:17:33.978Z") });
    expect(out.error.message).toBe("This server was rebuilt at 2026-10-23T15:17:33.978Z; run /mcp and pick extension-dev, then call again.");
    expect(out.value.server).toEqual({ version, builtAt: "2026-10-23T14:19:47.654Z" });
    expect(out.value.action).toBe("list");
    expect(out.value.trackUrl).toMatch(/\/acme\/widget\/builds$/);
    expect(out.warnings).toEqual([]);
    expect(fetchSpy).toHaveBeenCalledTimes(0);

    const status = await call(stamp, "extension_release_status", { api: API });

    expect(status.out.error.code).toBe("E_SERVER_STALE");
    expect(fetchSpy).toHaveBeenCalledTimes(0);
  });

  it("a fresh server reads the platform as before and carries its stamp", async () => {
    if (process.platform === "win32") return;

    const stamp = createServerStamp(entryFile(tmp));

    const { isError, out } = await call(stamp, "extension_builds", { action: "list", api: API });

    expect(isError).toBe(false);
    expect(out.ok).toBe(true);
    expect(out.status).toBe("listed");
    expect(out.value.builds).toHaveLength(1);
    expect(out.value.server).toEqual({ version, builtAt: "2026-10-23T14:19:47.654Z" });
    expect(out.warnings).toEqual([]);
    expect(fetchSpy.mock.calls.map((args) => new URL(String(args[0])).pathname)).toEqual(["/api/cli/whoami", `/api/projects/${PROJECT_ID}/builds`]);
  });
});
