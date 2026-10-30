import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";

import { createServer, tools } from "../index";
import { writeCredentials } from "../lib/credentials";
import { ENVELOPE_SCHEMA } from "../lib/envelope";
import { adoptHandover, listRebuilt, type BuildImporter } from "../lib/server-reload";
import { createServerStamp, listStaleSentence, reloadedWarning } from "../lib/server-stamp";
import { SUBMIT_ACTIONS } from "../tools/submit";

import type { ServerOptions } from "../lib/tool-policy";

const API = "http://localhost:3100";
const OPTIONS: ServerOptions = { features: ["local", "platform"], noShip: false };
const BUILT = "2026-10-30T12:00:00.000Z";
const REBUILT = "2026-10-30T16:25:11.000Z";
const REBUILT_AGAIN = "2026-10-30T17:08:44.000Z";

const REBUILT_SUBMIT = {
  name: "extension_submit",
  description: "rebuilt extension_submit",
  inputSchema: { type: "object", properties: { action: { type: "string", enum: ["submit", "release"] }, buildNumber: { type: "integer" } } },
};

const REBUILT_DEV = { name: "extension_dev", description: "rebuilt extension_dev", inputSchema: { type: "object", properties: {} } };

function fixtureBuild(withList: boolean): string {
  return [
    "let adopted = null;",
    "export function adoptHandover(state) { adopted = state; }",
    "export function handoverState() { return adopted; }",
    "export async function dispatchRebuilt(call) {",
    `  const text = JSON.stringify({ schema: ${JSON.stringify(ENVELOPE_SCHEMA)}, ok: true, command: call.name, status: "read", value: {}, error: null, warnings: [] });`,
    '  return { content: [{ type: "text", text }] };',
    "}",
    withList ? `export function listRebuilt() { return ${JSON.stringify([REBUILT_SUBMIT, REBUILT_DEV])}; }` : "",
    "",
  ].join("\n");
}

function writeBuild(file: string, source: string, at: string): void {
  fs.writeFileSync(file, source);
  fs.utimesSync(file, new Date(at), new Date(at));
}

async function connect(file: string) {
  const importer = vi.fn<BuildImporter>((specifier) => import(specifier));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await createServer(OPTIONS, { stamp: createServerStamp(file), importBuild: importer }).connect(serverTransport);
  const client = new Client({ name: "list-probe", version: "0.0.0" });
  const changed: string[] = [];
  client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
    changed.push("tools/list_changed");
  });

  await client.connect(clientTransport);

  const listed = async (name: string) => (await client.listTools()).tools.find((tool) => tool.name === name);

  const call = async () => {
    const result = await client.callTool({ name: "extension_builds", arguments: { action: "list", api: API } });

    return JSON.parse((result.content as Array<{ text: string }>)[0].text);
  };

  return { client, changed, listed, call };
}

describe("the listed tool schema is the one the answering build validates against", () => {
  let tmp: string;
  let prevXdg: string | undefined;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "extdev-listed-schema-"));
    prevXdg = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = tmp;
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 404, headers: { get: () => null }, text: async () => "{}" })));
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

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("answers a call from the rebuilt build before the client re-lists, flags the stale list once per build, and lists the rebuilt schema after", async () => {
    if (process.platform === "win32") return;

    const file = path.join(tmp, "module.js");
    writeBuild(file, fixtureBuild(true), BUILT);
    const { changed, listed, call } = await connect(file);

    const loadedSubmit = await listed("extension_submit");
    expect((loadedSubmit?.inputSchema.properties as Record<string, { enum?: string[] }>).action.enum).toEqual([...SUBMIT_ACTIONS]);

    writeBuild(file, fixtureBuild(true), REBUILT);

    const early = await call();
    expect(early.ok).toBe(true);
    expect(early.value.server).toEqual({ builtAt: REBUILT, listStale: true, listedAt: BUILT });
    expect(early.hint).toBe(listStaleSentence(BUILT, REBUILT));
    expect(early.warnings).toEqual([reloadedWarning(REBUILT)]);
    await vi.waitFor(() => expect(changed).toEqual(["tools/list_changed"]));

    const second = await call();
    expect(second.value.server).toEqual({ builtAt: REBUILT, listStale: true, listedAt: BUILT });
    expect(second.warnings).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(changed).toEqual(["tools/list_changed"]);

    const rebuiltSubmit = await listed("extension_submit");
    expect(rebuiltSubmit?.description).toBe(REBUILT_SUBMIT.description);
    expect(rebuiltSubmit?.inputSchema).toEqual(REBUILT_SUBMIT.inputSchema);
    expect((await listed("extension_dev"))?.description).not.toBe(REBUILT_DEV.description);

    const fresh = await call();
    expect(fresh.value.server).toBeUndefined();
    expect(fresh.hint).toBeUndefined();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(changed).toEqual(["tools/list_changed"]);

    writeBuild(file, fixtureBuild(true), REBUILT_AGAIN);

    const again = await call();
    expect(again.value.server).toEqual({ builtAt: REBUILT_AGAIN, listStale: true, listedAt: REBUILT });
    expect(again.hint).toBe(listStaleSentence(REBUILT, REBUILT_AGAIN));
    await vi.waitFor(() => expect(changed).toEqual(["tools/list_changed", "tools/list_changed"]));
  });

  it("flags nothing and sends no list change when the client listed the rebuilt build first", async () => {
    if (process.platform === "win32") return;

    const file = path.join(tmp, "module.js");
    writeBuild(file, fixtureBuild(true), BUILT);
    const { changed, listed, call } = await connect(file);
    writeBuild(file, fixtureBuild(true), REBUILT);

    expect((await listed("extension_submit"))?.description).toBe(REBUILT_SUBMIT.description);

    const out = await call();
    expect(out.value.server).toBeUndefined();
    expect(out.hint).toBeUndefined();
    expect(out.warnings).toEqual([reloadedWarning(REBUILT)]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(changed).toEqual([]);
  });

  it("keeps the loaded list when the rebuilt build answers no list", async () => {
    if (process.platform === "win32") return;

    const file = path.join(tmp, "module.js");
    writeBuild(file, fixtureBuild(false), BUILT);
    const { listed } = await connect(file);
    writeBuild(file, fixtureBuild(false), REBUILT);

    expect((await listed("extension_submit"))?.description).toBe(tools.find((tool) => tool.schema.name === "extension_submit")?.schema.description);
  });

  it("exports this build's own list for the process that loaded an older one", () => {
    adoptHandover({ options: OPTIONS, keptLogins: [] });

    const submit = listRebuilt().find((tool) => tool.name === "extension_submit");
    const props = submit?.inputSchema.properties as Record<string, { enum?: string[] }>;

    expect(props.action.enum).toContain("release");
    expect(props.action.enum).toContain("status");
    expect(props.buildNumber).toBeDefined();
    expect(submit?.description).toContain("release (Safari)");
  });
});
