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

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createServer } from "../index";
import { readCredentials, writeCredentials } from "../lib/credentials";
import { resolveToken } from "../lib/publish";
import {
  DEFAULT_SERVER_OPTIONS,
  FEATURE_GROUPS,
  pinProjectArgs,
  resolveServerOptions,
} from "../lib/tool-policy";

const KEYS = ["XDG_CONFIG_HOME", "EXTENSION_DEV_PROJECT", "EXTENSION_DEV_TOKEN"];
const saved: Record<string, string | undefined> = {};
let tmp: string;

function login(workspaceSlug: string, projectSlug: string, token: string) {
  writeCredentials({
    version: 1,
    token,
    workspaceSlug,
    projectSlug,
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    api: "https://www.extension.dev",
  });
}

beforeEach(() => {
  for (const key of KEYS) saved[key] = process.env[key];
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "extdev-pin-"));
  process.env.XDG_CONFIG_HOME = tmp;
  delete process.env.EXTENSION_DEV_PROJECT;
  delete process.env.EXTENSION_DEV_TOKEN;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("project-pin tests never reach the network");
    }),
  );
});

afterEach(() => {
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }

  vi.unstubAllGlobals();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("--project", () => {
  it("reads the flag in both spellings and the env, lowercased", () => {
    expect(resolveServerOptions(["--project", "Acme/App"], {})).toMatchObject({
      ok: true,
      options: { project: "acme/app" },
    });

    expect(resolveServerOptions(["--project=acme/app"], {})).toMatchObject({
      options: { project: "acme/app" },
    });

    expect(
      resolveServerOptions([], { EXTENSION_DEV_PROJECT: "acme/app" }),
    ).toMatchObject({ options: { project: "acme/app" } });

    expect(resolveServerOptions([], {})).toEqual({
      ok: true,
      options: DEFAULT_SERVER_OPTIONS,
    });
  });

  it("refuses a value that is not workspace/project", () => {
    const out = resolveServerOptions(["--project", "app"], {});
    expect(out.ok).toBe(false);
  });
});

describe("a pinned server reads only the pinned login", () => {
  it("selects the pinned login even when another was signed in last", () => {
    login("acme", "first", "tok-first");
    login("acme", "second", "tok-second");
    expect(readCredentials()?.projectSlug).toBe("second");

    process.env.EXTENSION_DEV_PROJECT = "acme/first";
    expect(readCredentials()?.projectSlug).toBe("first");
    expect(resolveToken()).toBe("tok-first");
  });

  it("falls back to EXTENSION_DEV_TOKEN when the pinned project has no stored login", () => {
    process.env.EXTENSION_DEV_PROJECT = "acme/ci-only";
    process.env.EXTENSION_DEV_TOKEN = "tok-ci";
    expect(resolveToken()).toBe("tok-ci");
  });

  it("still lets a call name its own login when nothing is pinned", () => {
    login("acme", "first", "tok-first");
    login("acme", "second", "tok-second");
    expect(resolveToken({ project: "acme/first" })).toBe("tok-first");
  });
});

describe("pinProjectArgs", () => {
  const schema = { properties: { project: { type: "string" } } };
  const pinned = { features: [...FEATURE_GROUPS], noShip: false, project: "acme/app" };

  it("fills the pinned project into a tool that takes one", () => {
    expect(pinProjectArgs("extension_release_status", {}, schema, pinned)).toEqual({
      args: { project: "acme/app" },
    });
  });

  it("accepts the pinned project by full ref or by its slug", () => {
    for (const project of ["acme/app", "ACME/App", "app"]) {
      expect(
        pinProjectArgs("extension_release_status", { project }, schema, pinned),
      ).toEqual({ args: { project } });
    }
  });

  it("refuses a call that names another project", () => {
    const out = pinProjectArgs(
      "extension_submit",
      { project: "acme/other" },
      schema,
      pinned,
    );
    expect("refused" in out).toBe(true);

    if ("refused" in out) {
      const body = JSON.parse(out.refused);
      expect(body.status).toBe("project-pinned");
      expect(body.error.code).toBe("E_TOOL_DISABLED");
    }
  });

  it("leaves auth status, tools without a project, and unpinned servers alone", () => {
    expect(
      pinProjectArgs("extension_auth", { action: "status" }, schema, pinned),
    ).toEqual({ args: { action: "status" } });

    expect(pinProjectArgs("extension_dev", {}, { properties: {} }, pinned)).toEqual({
      args: {},
    });

    expect(
      pinProjectArgs("extension_submit", { project: "x/y" }, schema, DEFAULT_SERVER_OPTIONS),
    ).toEqual({ args: { project: "x/y" } });
  });

  it("refuses another project through a real server call", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await createServer(pinned).connect(serverTransport);
    const client = new Client({ name: "pin-probe", version: "0.0.0" });
    await client.connect(clientTransport);

    const result = await client.callTool({
      name: "extension_release_status",
      arguments: { project: "acme/other" },
    });
    const body = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(result.isError).toBe(true);
    expect(body.status).toBe("project-pinned");
  });
});
