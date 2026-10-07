// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createServer, tools } from "../index";
import {
  DEFAULT_SERVER_OPTIONS,
  FEATURE_GROUPS,
  TOOL_POLICY,
  disabledToolEnvelope,
  resolveServerOptions,
  type ServerOptions,
} from "../lib/tool-policy";

async function connected(options?: ServerOptions): Promise<Client> {
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await createServer(options).connect(serverTransport);
  const client = new Client({ name: "policy-probe", version: "0.0.0" });
  await client.connect(clientTransport);

  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content as Array<{ text: string }>)[0].text;

  return { isError: result.isError, body: JSON.parse(text) };
}

const registered = tools.map((t) => t.schema.name).sort();

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("tool-policy tests never reach the network");
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the tool policy table", () => {
  it("has exactly one row per registered tool", () => {
    expect(Object.keys(TOOL_POLICY).sort()).toEqual(registered);
  });

  it("never marks a read-only tool destructive", () => {
    for (const [name, policy] of Object.entries(TOOL_POLICY)) {
      if (policy.annotations.readOnlyHint) {
        expect(policy.annotations.destructiveHint, name).toBe(false);
        expect(policy.ships, name).toBeUndefined();
      }
    }
  });

  it("marks every tool that can ship as open-world", () => {
    for (const [name, policy] of Object.entries(TOOL_POLICY)) {
      if (policy.ships) expect(policy.annotations.openWorldHint, name).toBe(true);
    }
  });
});

describe("resolveServerOptions", () => {
  it("defaults to the local group alone, with shipping allowed", () => {
    expect(DEFAULT_SERVER_OPTIONS).toEqual({ features: ["local"], noShip: false });
    expect(resolveServerOptions([], {})).toEqual({
      ok: true,
      options: DEFAULT_SERVER_OPTIONS,
    });

    expect(resolveServerOptions(["--features=local,platform"], {})).toEqual({
      ok: true,
      options: { features: ["local", "platform"], noShip: false },
    });
  });

  it("reads flags in both spellings and lets a flag override the env", () => {
    expect(
      resolveServerOptions(["--features", "local"], {
        EXTENSION_DEV_FEATURES: "platform",
      }),
    ).toEqual({ ok: true, options: { features: ["local"], noShip: false } });

    expect(resolveServerOptions(["--features=platform,local", "--no-ship"], {})).toEqual({
      ok: true,
      options: { features: ["local", "platform"], noShip: true },
    });
  });

  it("reads the env when no flag is passed", () => {
    expect(
      resolveServerOptions([], {
        EXTENSION_DEV_FEATURES: " Local ",
        EXTENSION_DEV_NO_SHIP: "1",
      }),
    ).toEqual({ ok: true, options: { features: ["local"], noShip: true } });

    expect(
      resolveServerOptions([], { EXTENSION_DEV_NO_SHIP: "false" }),
    ).toEqual({ ok: true, options: DEFAULT_SERVER_OPTIONS });
  });

  it("refuses an unknown group or flag by name instead of guessing", () => {
    const group = resolveServerOptions(["--features=local,database"], {});
    expect(group.ok).toBe(false);
    if (!group.ok) expect(group.message).toContain('"database"');

    const flag = resolveServerOptions(["--read-only"], {});
    expect(flag.ok).toBe(false);
    if (!flag.ok) expect(flag.message).toContain("--read-only");
  });
});

describe("the server honours the options", () => {
  it("lists every tool with its annotations when both groups are named", async () => {
    const client = await connected({ features: ["local", "platform"], noShip: false });
    const listed = (await client.listTools()).tools;
    expect(listed.map((t) => t.name).sort()).toEqual(registered);

    for (const tool of listed) {
      expect(tool.annotations, tool.name).toEqual(TOOL_POLICY[tool.name].annotations);
    }
  });

  it("lists no platform tool on a bare start", async () => {
    const client = await connected();
    const listed = (await client.listTools()).tools.map((t) => t.name).sort();
    const local = registered.filter((name) => TOOL_POLICY[name].group === "local");
    expect(listed).toEqual(local);
    expect(listed).toHaveLength(23);
    const out = await call(client, "extension_auth", { action: "status" });
    expect(out.body.error.code).toBe("E_TOOL_DISABLED");
    expect(out.body.hint).toContain("--features");
  });

  it("lists only the local group and refuses a platform call with E_TOOL_DISABLED", async () => {
    const client = await connected({ features: ["local"], noShip: false });
    const listed = (await client.listTools()).tools.map((t) => t.name);
    expect(listed).toContain("extension_dev");
    expect(listed).not.toContain("extension_auth");
    expect(listed).not.toContain("extension_submit");

    const out = await call(client, "extension_auth", { action: "status" });
    expect(out.isError).toBe(true);
    expect(out.body.error.code).toBe("E_TOOL_DISABLED");
    expect(out.body.hint).toContain("--features");
  });

  it("hides always-shipping tools in no-ship mode and refuses the shipping calls of the rest", async () => {
    const client = await connected({ features: [...FEATURE_GROUPS], noShip: true });
    const listed = (await client.listTools()).tools.map((t) => t.name);
    expect(listed).not.toContain("extension_publish");
    expect(listed).not.toContain("extension_release_promote");
    expect(listed).toContain("extension_submit");
    expect(listed).toContain("extension_shares");
    expect(listed).toContain("extension_preview_web");

    for (const [name, args] of [
      ["extension_publish", {}],
      ["extension_release_promote", { buildId: "abc", channel: "stable" }],
      ["extension_submit", { buildSha: "abc", browsers: ["chrome"], dryRun: false }],
      ["extension_preview_web", { projectPath: "/nowhere", share: true }],
      ["extension_shares", { action: "revoke", artifactId: "gen_x" }],
    ] as const) {
      const out = await call(client, name, args);
      expect(out.body.error?.code, name).toBe("E_TOOL_DISABLED");
      expect(out.body.value.noShip, name).toBe(true);
    }
  });

  it("lets the non-shipping calls of a guarded tool through no-ship mode", () => {
    const noShip = { features: [...FEATURE_GROUPS], noShip: true };

    for (const [name, args] of [
      ["extension_submit", { buildSha: "abc", browsers: ["chrome"] }],
      ["extension_submit", { buildSha: "abc", browsers: ["chrome"], dryRun: true }],
      ["extension_shares", { action: "list" }],
      ["extension_shares", {}],
      ["extension_preview_web", { projectPath: "/nowhere" }],
      ["extension_release_status", {}],
    ] as const) {
      expect(disabledToolEnvelope(name, args, noShip), name).toBeNull();
    }
  });
});
