import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createServer } from "../index";
import { resetBatchCreateSessions } from "../lib/project-create-batch";
import {
  DEFAULT_SERVER_OPTIONS,
  TOOL_POLICY,
  disabledToolEnvelope,
  pinProjectArgs,
  type ServerOptions,
} from "../lib/tool-policy";
import { schema as authSchema } from "../tools/auth";
import { schema as createSchema } from "../tools/project-create";

const KEYS = ["XDG_CONFIG_HOME", "EXTENSION_DEV_PROJECT", "EXTENSION_DEV_TOKEN", "EXTENSION_DEV_API_URL"];
const saved: Record<string, string | undefined> = {};
let tmp: string;
let fetchMock: ReturnType<typeof vi.fn>;

const CREATE_LIST = [
  { project: "acme/app", repo: "octo/app" },
  { project: "acme/other", repo: "octo/other" },
];
const LOGIN_LIST = ["acme/app", "acme/other"];

async function connected(options: ServerOptions): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await createServer(options).connect(serverTransport);
  const client = new Client({ name: "batch-policy-probe", version: "0.0.0" });
  await client.connect(clientTransport);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args });
  return {
    isError: result.isError === true,
    body: JSON.parse((result.content as Array<{ text: string }>)[0]!.text),
  };
}

function platformAnswers() {
  fetchMock.mockImplementation(async (url: any, init?: RequestInit) => {
    const href = String(url);
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status });
    if (href.endsWith("/api/cli/login/config")) {
      return json({
        batchOnboarding: {
          createProjectsPerApproval: 10,
          loginProjectsPerApproval: 20,
        },
      });
    }
    if (href.endsWith("/api/cli/device/code")) {
      return json({
        device_code: "dev-code",
        user_code: "ABCD-1234",
        verification_uri: "https://extension.dev/device",
        interval: 30,
        body: init?.body,
      });
    }
    if (href.endsWith("/api/cli/device/token")) {
      return json({ error: "authorization_pending" }, 400);
    }
    throw new Error(`Unexpected fetch: ${href}`);
  });
}

function sentTo(suffix: string): any[] {
  return fetchMock.mock.calls
    .filter(([url]) => String(url).endsWith(suffix))
    .map(([, init]) => JSON.parse(String((init as RequestInit).body)));
}

beforeEach(() => {
  for (const key of KEYS) saved[key] = process.env[key];
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "extdev-batch-policy-"));
  process.env.XDG_CONFIG_HOME = tmp;
  process.env.EXTENSION_DEV_API_URL = "https://api.test";
  delete process.env.EXTENSION_DEV_PROJECT;
  delete process.env.EXTENSION_DEV_TOKEN;
  fetchMock = vi.fn(async () => {
    throw new Error("batch policy tests never reach the network");
  });
  vi.stubGlobal("fetch", fetchMock);
  resetBatchCreateSessions();
});

afterEach(() => {
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  vi.unstubAllGlobals();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("a batch sits in the same policy row as its single twin", () => {
  it("adds no tool: the list is an input of the two tools that already exist", () => {
    expect(TOOL_POLICY.extension_project_create?.group).toBe("platform");
    expect(TOOL_POLICY.extension_auth?.group).toBe("platform");
    expect(TOOL_POLICY.extension_project_create?.ships).toBeUndefined();
    expect(TOOL_POLICY.extension_auth?.ships).toBeUndefined();
    expect(Object.keys(TOOL_POLICY).filter((name) => /batch/i.test(name))).toEqual([]);
  });

  it("is refused with its twin when the platform group is off", async () => {
    const client = await connected({ features: ["local"], noShip: false });
    for (const [name, single, batch] of [
      ["extension_project_create", { project: "acme/app", repo: "octo/app" }, { projects: CREATE_LIST }],
      ["extension_auth", { action: "login", project: "acme/app" }, { action: "login", projects: LOGIN_LIST }],
    ] as const) {
      const one = await call(client, name, single);
      const many = await call(client, name, batch);
      expect(one.body.error.code, name).toBe("E_TOOL_DISABLED");
      expect(many.isError, name).toBe(true);
      expect(many.body.error.code, name).toBe("E_TOOL_DISABLED");
      expect(many.body.status, name).toBe(one.body.status);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("is let through no-ship mode exactly as its twin is", () => {
    const noShip = { ...DEFAULT_SERVER_OPTIONS, noShip: true };
    for (const [name, single, batch] of [
      ["extension_project_create", { project: "acme/app", repo: "octo/app" }, { projects: CREATE_LIST }],
      ["extension_auth", { action: "login", project: "acme/app" }, { action: "login", projects: LOGIN_LIST }],
    ] as const) {
      expect(disabledToolEnvelope(name, batch, noShip)).toEqual(
        disabledToolEnvelope(name, single, noShip),
      );
    }
  });
});

describe("--project holds a batch to the pinned project, name by name", () => {
  const pinned = { ...DEFAULT_SERVER_OPTIONS, project: "acme/app" };

  it.each([
    ["a create list naming another project", "extension_project_create", { projects: CREATE_LIST }, createSchema],
    ["a login list naming another project", "extension_auth", { action: "login", projects: LOGIN_LIST }, authSchema],
    ["a list with only another project", "extension_auth", { action: "login", projects: ["acme/other"] }, authSchema],
    ["a list in another workspace", "extension_auth", { action: "login", projects: ["globex/app"] }, authSchema],
    ["a list hiding the name in a bare slug", "extension_auth", { action: "login", projects: ["app", "acme/other"] }, authSchema],
    ["a list with an entry that names nothing", "extension_project_create", { projects: [{ repo: "octo/app" }] }, createSchema],
    ["a list with a non-entry", "extension_project_create", { projects: [42] }, createSchema],
    ["a list that is not an array", "extension_auth", { action: "login", projects: "acme/other" }, authSchema],
    ["an empty list", "extension_auth", { action: "login", projects: [] }, authSchema],
  ] as const)("refuses %s", (_label, name, args, toolSchema) => {
    const out = pinProjectArgs(name, args, toolSchema.inputSchema, pinned);
    expect("refused" in out).toBe(true);
    if ("refused" in out) {
      const body = JSON.parse(out.refused);
      expect(body.status).toBe("project-pinned");
      expect(body.error.code).toBe("E_TOOL_DISABLED");
      expect(body.value.pinned).toBe("acme/app");
    }
  });

  it("names the projects that broke the pin", () => {
    const out = pinProjectArgs(
      "extension_auth",
      { action: "login", projects: ["acme/app", "acme/other", "acme/third"] },
      authSchema.inputSchema,
      pinned,
    );
    expect("refused" in out).toBe(true);
    if ("refused" in out) {
      expect(JSON.parse(out.refused).value.named).toEqual(["acme/other", "acme/third"]);
    }
  });

  it("hands a list of exactly the pinned project on untouched, with no project injected beside it", () => {
    for (const args of [
      { action: "login", projects: ["acme/app"] },
      { action: "login", projects: ["ACME/App"] },
    ]) {
      expect(pinProjectArgs("extension_auth", args, authSchema.inputSchema, pinned)).toEqual({
        args,
      });
    }
    const create = { projects: [{ project: "acme/app", repo: "octo/app" }] };
    expect(
      pinProjectArgs("extension_project_create", create, createSchema.inputSchema, pinned),
    ).toEqual({ args: create });
  });

  it("leaves a list alone on an unpinned server", () => {
    const args = { action: "login", projects: LOGIN_LIST };
    expect(
      pinProjectArgs("extension_auth", args, authSchema.inputSchema, DEFAULT_SERVER_OPTIONS),
    ).toEqual({ args });
  });

  it("refuses both batches through a real pinned server before any request leaves", async () => {
    const client = await connected(pinned);
    for (const [name, args] of [
      ["extension_project_create", { projects: CREATE_LIST }],
      ["extension_auth", { action: "login", projects: LOGIN_LIST }],
    ] as const) {
      const out = await call(client, name, args);
      expect(out.isError, name).toBe(true);
      expect(out.body.status, name).toBe("project-pinned");
      expect(out.body.value.named, name).toEqual(["acme/other"]);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("runs a batch of the pinned project alone through a real pinned server", async () => {
    platformAnswers();
    const client = await connected(pinned);

    const login = await call(client, "extension_auth", {
      action: "login",
      projects: ["acme/app"],
    });
    expect(login.body.status).toBe("authorization-pending");
    expect(sentTo("/api/cli/device/code")[0]).toEqual({
      projects: ["acme/app"],
      clientName: "extension-mcp",
    });

    const create = await call(client, "extension_project_create", {
      projects: [{ project: "acme/app", repo: "octo/app" }],
    });
    expect(create.body.status).toBe("authorization-pending");
    expect(sentTo("/api/cli/device/code")[1]).toEqual({
      projects: ["acme/app"],
      clientName: "extension-mcp",
      intent: "create",
    });
  });

  it("still fills the pin into a single call that names no project", async () => {
    platformAnswers();
    const client = await connected(pinned);
    const out = await call(client, "extension_auth", { action: "login" });

    expect(out.body.status).toBe("authorization-pending");
    expect(sentTo("/api/cli/device/code")[0]).toEqual({
      project: "acme/app",
      clientName: "extension-mcp",
    });
  });
});

describe("the input validator sees the list", () => {
  it("refuses a list of the wrong shape as an input error, through the real server", async () => {
    const client = await connected(DEFAULT_SERVER_OPTIONS);
    const login = await call(client, "extension_auth", {
      action: "login",
      projects: [1, 2],
    });
    expect(login.isError).toBe(true);
    expect(login.body.error.code).toBe("E_INPUT_VALIDATION");

    const create = await call(client, "extension_project_create", {
      projects: "acme/app",
    });
    expect(create.isError).toBe(true);
    expect(create.body.error.code).toBe("E_INPUT_VALIDATION");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
