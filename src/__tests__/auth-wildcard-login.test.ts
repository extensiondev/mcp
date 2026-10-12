import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { handler, schema } from "../tools/auth";
import {
  listCredentials,
  readCredentials,
  writeCredentials,
  type StoredCredentials,
} from "../lib/credentials";

const API = "https://api.test";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(
    typeof body === "string" ? body : JSON.stringify(body),
    { status },
  );
}

type Route = { status: number; body: unknown };

function harness(options: {
  batchOnboarding?: unknown;
  code?: Route;
  token?: Route[];
}) {
  const calls: Array<{ url: string; body: any }> = [];
  let tokenCalls = 0;
  const fn = vi.fn(async (url: any, init?: RequestInit) => {
    const href = String(url);
    calls.push({ url: href, body: init?.body ? JSON.parse(String(init.body)) : null });

    if (href.endsWith("/api/cli/login/config")) {
      return jsonResponse({
        deviceCodeUrl: "/api/cli/device/code",
        deviceTokenUrl: "/api/cli/device/token",
        verificationUri: "https://extension.dev/device",
        ...("batchOnboarding" in options
          ? options.batchOnboarding === undefined
            ? {}
            : { batchOnboarding: options.batchOnboarding }
          : {
              batchOnboarding: {
                createProjectsPerApproval: 10,
                loginProjectsPerApproval: 20,
                workspaceWildcard: true,
              },
            }),
      });
    }

    if (href.endsWith("/api/cli/device/code")) {
      const route = options.code ?? {
        status: 200,
        body: {
          device_code: "dev-code",
          user_code: "ABCD-1234",
          verification_uri: "https://extension.dev/device",
          verification_uri_complete: "https://extension.dev/device?code=ABCD-1234",
          interval: 30,
          expires_in: 900,
        },
      };

      return jsonResponse(route.body, route.status);
    }

    if (href.endsWith("/api/cli/device/token")) {
      const list = options.token ?? [];
      const next = list[Math.min(tokenCalls, list.length - 1)] ?? {
        status: 400,
        body: { error: "authorization_pending" },
      };
      tokenCalls += 1;

      return jsonResponse(next.body, next.status);
    }

    throw new Error(`Unexpected fetch: ${href}`);
  });
  vi.stubGlobal("fetch", fn);

  return {
    fn,
    calls,
    to: (suffix: string) => calls.filter((call) => call.url.endsWith(suffix)),
  };
}

function entry(slug: string, extra: Record<string, unknown> = {}) {
  return {
    token: `login-token-for-${slug}`,
    expiresAt: 1_900_000_000,
    ttlSeconds: 604800,
    workspaceSlug: "acme",
    projectSlug: slug,
    ...extra,
  };
}

function tokens(slugs: string[]): Route {
  const all = slugs.map((slug) => entry(slug));

  return { status: 200, body: { ...all[0], tokens: all } };
}

async function run(args: Record<string, unknown>) {
  return JSON.parse(await handler(args as never));
}

function stored(slug: string, token = `old-${slug}`): StoredCredentials {
  return {
    version: 1,
    token,
    workspaceSlug: "acme",
    projectSlug: slug,
    expiresAt: 1_900_000_000,
    api: API,
  };
}

let tmp: string;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("batch login tests never reach the network");
    }),
  );

  for (const key of ["XDG_CONFIG_HOME", "EXTENSION_DEV_API_URL", "EXTENSION_DEV_TOKEN", "EXTENSION_DEV_PROJECT"]) {
    saved[key] = process.env[key];
  }

  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "extdev-wildcard-"));
  process.env.XDG_CONFIG_HOME = tmp;
  process.env.EXTENSION_DEV_API_URL = API;
  delete process.env.EXTENSION_DEV_TOKEN;
  delete process.env.EXTENSION_DEV_PROJECT;
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();

  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("extension_auth login to every project of a workspace with projects: \"*\"", () => {
  it("documents the wildcard beside the list and the workspace input", () => {
    expect(schema.inputSchema.properties.projects.type).toEqual(["array", "string"]);
    expect(schema.inputSchema.properties.projects.description).toContain('"*"');
    expect(schema.inputSchema.properties.workspace.description).toContain('projects: "*"');
  });

  it("asks for one code naming the workspace and the wildcard, and nothing else", async () => {
    const h = harness({});
    const out = await run({ action: "login", workspace: "Acme", projects: "*" });

    expect(out.ok).toBe(true);
    expect(out.status).toBe("authorization-pending");
    expect(out.value).toMatchObject({
      userCode: "ABCD-1234",
      deviceCode: "dev-code",
      workspace: "acme",
      projects: "*",
      legacyStatus: "authorization_pending",
    });

    expect(out.hint).toContain("every project acme has");
    expect(h.to("/api/cli/device/code")[0]?.body).toEqual({
      projects: "*",
      workspace: "acme",
      clientName: "extension-mcp",
    });

    expect(h.to("/api/cli/device/token")[0]?.body).toEqual({
      device_code: "dev-code",
      projects: "*",
      workspace: "acme",
    });

    expect(listCredentials()).toHaveLength(0);
  });

  it("stores every token the platform returns for the workspace and names the projects", async () => {
    const h = harness({ token: [tokens(["alpha", "beta", "gamma", "delta"])] });
    const text = await handler({ action: "login", workspace: "acme", projects: "*", deviceCode: "dev-code" } as never);
    const out = JSON.parse(text);

    expect(out.ok).toBe(true);
    expect(out.status).toBe("logged-in");
    expect(out.value.workspaceSlug).toBe("acme");
    expect(out.value.logins.map((login: { project: string }) => login.project)).toEqual([
      "acme/alpha",
      "acme/beta",
      "acme/gamma",
      "acme/delta",
    ]);

    expect(out.hint).toContain("alpha, beta, gamma, delta");
    expect(text).not.toContain("login-token-for-");
    expect(h.to("/api/cli/device/code")).toHaveLength(0);

    for (const slug of ["alpha", "beta", "gamma", "delta"]) {
      expect(readCredentials({ project: `acme/${slug}` })).toMatchObject({ token: `login-token-for-${slug}`, api: API });
    }
  });

  it.each([
    ["a token in another workspace", [entry("alpha"), entry("beta", { workspaceSlug: "globex" })]],
    ["the same project twice", [entry("alpha"), entry("alpha")]],
    ["an entry with no token", [entry("alpha"), entry("beta", { token: "" })]],
    ["an empty list", []],
  ])("stores nothing when the platform answers with %s", async (_label, list) => {
    writeCredentials(stored("beta"));
    harness({ token: [{ status: 200, body: { ...(list[0] ?? { token: "x" }), tokens: list } }] });
    const out = await run({ action: "login", workspace: "acme", projects: "*", deviceCode: "dev-code" });

    expect(out.ok).toBe(false);
    expect(out.status).toBe("login-failed");
    expect(out.error.message).toContain("nothing was stored");
    expect(listCredentials()).toHaveLength(1);
    expect(readCredentials({ project: "acme/beta" })?.token).toBe("old-beta");
  });

  it.each([
    ["no flag", { createProjectsPerApproval: 10, loginProjectsPerApproval: 20 }],
    ["no batch at all", undefined],
  ])("refuses before spending a device code when the platform advertises %s", async (_label, batchOnboarding) => {
    const h = harness({ batchOnboarding });
    const out = await run({ action: "login", workspace: "acme", projects: "*" });

    expect(out.ok).toBe(false);
    expect(out.status).toBe("batch-unsupported");
    expect(out.error.code).toBe("E_PLATFORM");
    expect(out.error.message).toContain("every project of a workspace");
    expect(h.to("/api/cli/device/code")).toHaveLength(0);
  });

  it.each([
    ["no workspace", { projects: "*" }, "workspace"],
    ["a workspace with a slash", { workspace: "acme/alpha", projects: "*" }, "workspace slug"],
    ["a project beside it", { workspace: "acme", projects: "*", project: "acme/alpha" }, "not both"],
    ["a string that is not the wildcard", { projects: "acme/alpha" }, '"*"'],
    ["a workspace beside a list", { workspace: "acme", projects: ["acme/alpha"] }, 'projects: "*"'],
    ["a workspace with no projects", { workspace: "acme" }, 'projects: "*"'],
  ])("refuses %s with no network call", async (_label, args, fragment) => {
    const { fn } = harness({});
    const out = await run({ action: "login", ...args });

    expect(out.ok).toBe(false);
    expect(out.status).toBe("bad-request");
    expect(out.error.message).toContain(fragment);
    expect(fn).not.toHaveBeenCalled();
  });

  it("keeps a still-pending resume short and resumable with the same deviceCode", async () => {
    vi.useFakeTimers();
    const h = harness({});
    const started = Date.now();
    const pending = run({ action: "login", workspace: "acme", projects: "*", deviceCode: "dev-code" });
    await vi.advanceTimersByTimeAsync(45_000);
    const out = await pending;

    expect(out.status).toBe("authorization-pending");
    expect(out.value.deviceCode).toBe("dev-code");
    expect(out.hint).toContain('workspace: "acme"');
    expect(h.to("/api/cli/device/code")).toHaveLength(0);
    expect(h.to("/api/cli/device/token").length).toBeLessThanOrEqual(5);
    expect(Date.now() - started).toBeLessThanOrEqual(45_000);
  });
});
