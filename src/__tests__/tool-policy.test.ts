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
  isServerFlag,
  resolveServerOptions,
  runsOnPlatform,
  type ServerOptions,
  toolTitle,
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

  it("reads --no-ship bare or with true or false, as server.json declares it, and refuses any other value", () => {
    expect(resolveServerOptions(["--no-ship=true"], {})).toEqual({ ok: true, options: { features: ["local"], noShip: true } });
    expect(resolveServerOptions(["--no-ship=1"], {})).toEqual({ ok: true, options: { features: ["local"], noShip: true } });
    expect(resolveServerOptions(["--no-ship=false"], { EXTENSION_DEV_NO_SHIP: "1" })).toEqual({ ok: true, options: { features: ["local"], noShip: false } });
    expect(resolveServerOptions(["--no-ship=maybe"], {})).toEqual({ ok: false, message: '--no-ship takes true or false, got "maybe".' });
    expect(isServerFlag("--no-ship=true")).toBe(true);
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

describe("the default start stays under a directory's tool ceiling", () => {
  const MOVED = { extension_try: "platform", extension_theme_verify: "extras", extension_network: "extras" } as const;

  it("lists exactly 24 tools on a bare start, none of the three moved ones", async () => {
    const listed = (await (await connected()).listTools()).tools.map((t) => t.name);

    expect(listed).toHaveLength(24);
    for (const name of Object.keys(MOVED)) expect(listed, name).not.toContain(name);
  });

  it("keeps extension_try in the platform group and the two niche tools in extras, a group that is off unless named", () => {
    expect(FEATURE_GROUPS).toEqual(["local", "platform", "extras"]);
    expect(DEFAULT_SERVER_OPTIONS.features).toEqual(["local"]);

    for (const [name, group] of Object.entries(MOVED)) expect(TOOL_POLICY[name].group, name).toBe(group);

    const groups = Object.values(TOOL_POLICY).map((policy) => policy.group);

    expect(groups.filter((group) => group === "local")).toHaveLength(24);
    expect(groups.filter((group) => group === "platform")).toHaveLength(15);
    expect(groups.filter((group) => group === "extras")).toHaveLength(2);
  });

  it("lists 39 with the platform group and all 41 once extras is named", async () => {
    const platform = (await (await connected({ features: ["local", "platform"], noShip: false })).listTools()).tools.map((t) => t.name);
    const everything = (await (await connected({ features: ["local", "platform", "extras"], noShip: false })).listTools()).tools.map((t) => t.name);

    expect(platform).toHaveLength(39);
    expect(platform).toContain("extension_try");
    expect(platform).not.toContain("extension_network");
    expect(platform).not.toContain("extension_theme_verify");
    expect(everything.sort()).toEqual(registered);
    expect(everything).toHaveLength(41);
  });

  it("reads extras from the flag and the environment, in the table's order", () => {
    expect(resolveServerOptions(["--features=extras,platform,local"], {})).toEqual({
      ok: true,
      options: { features: ["local", "platform", "extras"], noShip: false },
    });

    expect(resolveServerOptions([], { EXTENSION_DEV_FEATURES: "local,extras" })).toEqual({
      ok: true,
      options: { features: ["local", "extras"], noShip: false },
    });

    const unknown = resolveServerOptions(["--features=local,extra"], {});

    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.message).toContain("Use local, platform or extras, comma-separated.");
  });

  it("answers a call to an unlisted tool with E_TOOL_DISABLED and the flag that lists it", async () => {
    const bare = await connected();

    for (const [name, group] of Object.entries(MOVED)) {
      const out = await call(bare, name, name === "extension_try" ? { project: "acme/app" } : { projectPath: "/nowhere" });

      expect(out.isError, name).toBe(true);
      expect(out.body.error.code, name).toBe("E_TOOL_DISABLED");
      expect(out.body.error.message, name).toContain(`"${group}" feature group`);
      expect(out.body.value, name).toMatchObject({ group, features: ["local"], add: `--features=local,${group}` });
      expect(out.body.hint, name).toContain(`Add ${group} to --features`);
      expect(out.body.hint, name).toContain(`--features=local,${group}`);
    }

    const platform = await connected({ features: ["local", "platform"], noShip: false });
    const stub = await call(platform, "extension_network", { projectPath: "/nowhere", action: "list" });

    expect(stub.body.error.code).toBe("E_TOOL_DISABLED");
    expect(stub.body.hint).toContain("--features=local,platform,extras");
  });

  it("runs extension_try on this machine although the platform group lists it", () => {
    expect(runsOnPlatform("extension_try")).toBe(false);
    expect(runsOnPlatform("extension_publish")).toBe(true);
    expect(runsOnPlatform("extension_dev")).toBe(false);
    expect(runsOnPlatform("extension_network")).toBe(false);
  });
});

describe("the server honours the options", () => {
  it("lists every tool with its annotations when every group is named", async () => {
    const client = await connected({ features: [...FEATURE_GROUPS], noShip: false });
    const listed = (await client.listTools()).tools;
    expect(listed.map((t) => t.name).sort()).toEqual(registered);

    for (const tool of listed) {
      expect(tool.annotations, tool.name).toEqual({ title: toolTitle(tool.name), ...TOOL_POLICY[tool.name].annotations });
      expect(tool.title, tool.name).toBe(toolTitle(tool.name));
      expect(tool.title, tool.name).toMatch(/^[A-Z]/);
    }
  });

  it("lists the local group alone on a bare start", async () => {
    const client = await connected();
    const listed = (await client.listTools()).tools.map((t) => t.name).sort();
    const local = registered.filter((name) => TOOL_POLICY[name].group === "local");
    expect(listed).toEqual(local);
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

  it("answers the check tool in no-ship mode, since it executes nothing, while the same act through extension_submit stays refused", async () => {
    const client = await connected({ features: [...FEATURE_GROUPS], noShip: true });
    const act = { action: "publish", browsers: ["chrome"] };
    const checked = await call(client, "extension_submit_check", act);

    expect(checked.body.command).toBe("extension_submit_check");
    expect(checked.body.error?.code).not.toBe("E_TOOL_DISABLED");
    expect((await call(client, "extension_submit", act)).body.error?.code).toBe("E_TOOL_DISABLED");
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

  it("refuses a listing sync in no-ship mode and says so, naming only calls that still work", () => {
    const noShip = { features: [...FEATURE_GROUPS], noShip: true };
    const refused = JSON.parse(String(disabledToolEnvelope("extension_submit", { action: "sync-listing", browsers: ["firefox"], projectPath: "/nowhere" }, noShip)));

    expect(refused.error.code).toBe("E_TOOL_DISABLED");
    expect(refused.hint).toContain("a listing sync is refused with the other store acts");
    expect(refused.hint).toContain("reading the share links still work");
    expect(refused.hint).not.toMatch(/and listing still work/);

    for (const args of [{ action: "preflight" }, { action: "status" }, { dryRun: true }]) {
      expect(disabledToolEnvelope("extension_submit", args, noShip), JSON.stringify(args)).toBeNull();
    }
  });
});
