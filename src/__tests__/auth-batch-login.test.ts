import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { handler, schema } from "../tools/auth";
import {
  listCredentials,
  readCredentials,
  writeCredentialBatch,
  writeCredentials,
  type StoredCredentials,
} from "../lib/credentials";
import { pollDeviceGrant, requestDeviceCode } from "../lib/device-flow";

const API = "https://api.test";
const LIST = ["acme/alpha", "acme/beta", "acme/gamma"];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(
    typeof body === "string" ? body : JSON.stringify(body),
    { status },
  );
}

type Route = { status: number; body: unknown };

function harness(options: { code?: Route; token?: Route[] }) {
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
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "extdev-batchlogin-"));
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

describe("extension_auth login with projects: refusals before a device code is spent", () => {
  it.each([
    ["two workspaces", ["acme/alpha", "globex/tool"], "one workspace"],
    ["a name twice", ["acme/alpha", "ACME/alpha"], "named twice"],
    ["twenty-one names", Array.from({ length: 21 }, (_, i) => `acme/app-${i}`), "between 1 and 20"],
    ["an empty list", [], "between 1 and 20"],
    ["a name the platform would rename", ["acme/my_app"], "exact slug"],
    ["a slug over 48 characters", [`acme/${"p".repeat(49)}`], "exact slug"],
    ["a bare slug", ["alpha"], "<workspace>/<project>"],
    ["an object entry", [{ project: "acme/alpha" }], "<workspace>/<project>"],
    ["something that is not a list", "acme/alpha", "must be an array"],
  ])("refuses %s with the reason and no network call", async (_label, projects, fragment) => {
    const { fn } = harness({});
    const out = await run({ action: "login", projects });
    expect(out.ok).toBe(false);
    expect(out.status).toBe("bad-request");
    expect(out.error.message).toContain(fragment);
    expect(fn).not.toHaveBeenCalled();
  });

  it("accepts twenty names, the platform's cap for a login list", async () => {
    const twenty = Array.from({ length: 20 }, (_, i) => `acme/app-${i + 1}`);
    const h = harness({});
    const out = await run({ action: "login", projects: twenty });
    expect(out.status).toBe("authorization-pending");
    expect(h.to("/api/cli/device/code")[0]?.body.projects).toHaveLength(20);
  });

  it("refuses project and projects together", async () => {
    const { fn } = harness({});
    const out = await run({ action: "login", project: "acme/alpha", projects: LIST });
    expect(out.status).toBe("bad-request");
    expect(out.error.message).toContain("not both");
    expect(fn).not.toHaveBeenCalled();
  });

  it.each(["logout", "status"])("refuses a list on %s instead of ignoring it", async (action) => {
    writeCredentials(stored("alpha"));
    const { fn } = harness({});
    const out = await run({ action, projects: LIST });
    expect(out.status).toBe("bad-request");
    expect(out.error.message).toContain("does not take a list");
    expect(fn).not.toHaveBeenCalled();
    expect(listCredentials()).toHaveLength(1);
  });

  it("refuses a list when no action is given, since the default is status", async () => {
    const { fn } = harness({});
    const out = await run({ projects: LIST });
    expect(out.status).toBe("bad-request");
    expect(fn).not.toHaveBeenCalled();
  });

  it("refuses to send a batch to a hostile api argument", async () => {
    const { fn } = harness({});
    const out = await run({ action: "login", projects: LIST, api: "https://evil.example" });
    expect(out.ok).toBe(false);
    expect(out.error.message).toContain("Refusing to send the access token");
    expect(fn).not.toHaveBeenCalled();
  });

  it("documents the list input and its rules", () => {
    const text = schema.inputSchema.properties.projects.description;
    expect(text).toContain("1 to 20");
    expect(text).toContain("at most 48 characters");
    expect(text).toContain("existing projects");
    expect(schema.description).toContain("`projects`");
  });
});

describe("extension_auth login with projects: one approval, one token per project", () => {
  it("asks for ONE code naming every project, with no intent and no single project", async () => {
    const h = harness({});
    const out = await run({ action: "login", projects: ["Acme/Alpha", "acme/beta", "acme/gamma"] });

    expect(out.ok).toBe(true);
    expect(out.status).toBe("authorization-pending");
    expect(out.value).toEqual({
      userCode: "ABCD-1234",
      verificationUri: "https://extension.dev/device",
      verificationUriComplete: "https://extension.dev/device?code=ABCD-1234",
      deviceCode: "dev-code",
      projects: LIST,
      legacyStatus: "authorization_pending",
    });
    expect(out.hint).toContain("lists all 3 projects");
    expect(out.warnings.join(" ")).toContain("up to a minute");
    expect(h.to("/api/cli/device/code")).toHaveLength(1);
    expect(h.to("/api/cli/device/code")[0]?.body).toEqual({
      projects: LIST,
      clientName: "extension-mcp",
    });
    expect(h.to("/api/cli/device/token")[0]?.body).toEqual({
      device_code: "dev-code",
      projects: LIST,
    });
    expect(listCredentials()).toHaveLength(0);
  });

  it("stores every returned token under its own project and names them, never the tokens", async () => {
    harness({ token: [tokens(["alpha", "beta", "gamma"])] });
    const text = await handler({ action: "login", projects: LIST, deviceCode: "dev-code" });
    const out = JSON.parse(text);

    expect(out.ok).toBe(true);
    expect(out.status).toBe("logged-in");
    expect(out.value).toEqual({
      workspaceSlug: "acme",
      logins: ["alpha", "beta", "gamma"].map((slug) => ({
        project: `acme/${slug}`,
        workspaceSlug: "acme",
        projectSlug: slug,
        expiresAt: new Date(1_900_000_000 * 1000).toISOString(),
      })),
    });
    expect(text).not.toContain("login-token-for-");
    for (const slug of ["alpha", "beta", "gamma"]) {
      expect(readCredentials({ project: `acme/${slug}` })).toMatchObject({
        token: `login-token-for-${slug}`,
        api: API,
        provider: "extensiondev",
      });
    }
    expect(listCredentials()).toHaveLength(3);
  });

  it("resumes with the same list on the poll and requests no second code", async () => {
    const h = harness({ token: [tokens(["alpha", "beta", "gamma"])] });
    await run({ action: "login", projects: LIST, deviceCode: "dev-code" });

    expect(h.to("/api/cli/device/code")).toHaveLength(0);
    expect(h.to("/api/cli/device/token")[0]?.body).toEqual({
      device_code: "dev-code",
      projects: LIST,
    });
  });

  it("renews existing logins in place and leaves the default login alone", async () => {
    writeCredentialBatch([stored("beta"), stored("elsewhere")]);
    writeCredentials(stored("elsewhere", "old-elsewhere-2"));
    harness({ token: [tokens(["alpha", "beta", "gamma"])] });
    await run({ action: "login", projects: LIST, deviceCode: "dev-code" });

    expect(readCredentials()?.projectSlug).toBe("elsewhere");
    expect(readCredentials({ project: "acme/beta" })?.token).toBe("login-token-for-beta");
    expect(listCredentials()).toHaveLength(4);
  });

  it("makes the first listed project the default only when no login existed", async () => {
    harness({ token: [tokens(["alpha", "beta", "gamma"])] });
    await run({ action: "login", projects: LIST, deviceCode: "dev-code" });

    expect(readCredentials()?.projectSlug).toBe("alpha");
  });

  it.each([
    ["a token for a project that was not asked for", [entry("alpha"), entry("beta"), entry("gamma"), entry("omega")]],
    ["one token too few", [entry("alpha"), entry("beta")]],
    ["a swapped name", [entry("alpha"), entry("beta"), entry("omega")]],
    ["the same project twice", [entry("alpha"), entry("alpha"), entry("gamma")]],
    ["a token in another workspace", [entry("alpha"), entry("beta"), entry("gamma", { workspaceSlug: "globex" })]],
    ["an entry with no token", [entry("alpha"), entry("beta"), entry("gamma", { token: "" })]],
    ["an entry with no scope", [entry("alpha"), entry("beta"), entry("gamma", { projectSlug: "" })]],
  ])("stores nothing when the platform answers with %s", async (_label, list) => {
    writeCredentials(stored("beta"));
    harness({ token: [{ status: 200, body: { ...list[0], tokens: list } }] });
    const out = await run({ action: "login", projects: LIST, deviceCode: "dev-code" });

    expect(out.ok).toBe(false);
    expect(out.status).toBe("login-failed");
    expect(out.error.message).toContain("nothing was stored");
    expect(listCredentials()).toHaveLength(1);
    expect(readCredentials({ project: "acme/beta" })?.token).toBe("old-beta");
  });

  it("stores nothing when the platform answers a list with the single-project shape", async () => {
    harness({ token: [{ status: 200, body: entry("alpha") }] });
    const out = await run({ action: "login", projects: LIST, deviceCode: "dev-code" });

    expect(out.ok).toBe(false);
    expect(out.error.message).toContain("may predate batch login");
    expect(listCredentials()).toHaveLength(0);
  });

  it("reports the missing projects by name and stores nothing", async () => {
    harness({
      token: [
        {
          status: 404,
          body: {
            message: "These projects were not found",
            code: "PROJECT_NOT_FOUND",
            authorizationValid: false,
            missingProjects: ["acme/beta"],
          },
        },
      ],
    });
    const out = await run({ action: "login", projects: LIST, deviceCode: "dev-code" });

    expect(out.ok).toBe(false);
    expect(out.error.name).toBe("LoginProjectNotFound");
    expect(out.value).toEqual({
      code: "PROJECT_NOT_FOUND",
      missingProjects: ["acme/beta"],
      projects: LIST,
    });
    expect(out.hint).toContain("all or nothing");
    expect(out.hint).toContain("acme/beta");
    expect(listCredentials()).toHaveLength(0);
  });

  it("tells an approver who left the workspace apart from a human pressing Deny, by code", async () => {
    harness({
      token: [
        { status: 403, body: { error: "access_denied", message: "gone", code: "MEMBERSHIP_REVOKED" } },
      ],
    });
    const revoked = await run({ action: "login", projects: LIST, deviceCode: "dev-code" });
    expect(revoked.error.name).toBe("LoginMembershipRevoked");
    expect(revoked.value.code).toBe("MEMBERSHIP_REVOKED");

    harness({ token: [{ status: 400, body: { error: "access_denied", message: "The authorization was denied." } }] });
    const denied = await run({ action: "login", projects: LIST, deviceCode: "dev-code" });
    expect(denied.status).toBe("login-denied");
    expect(denied.error.code).toBe("E_AUTH_DENIED");
  });

  it.each([
    ["BATCH_RECORD_INVALID", { status: 400, body: { error: "invalid_request", message: "closed", code: "BATCH_RECORD_INVALID" } }],
    ["BATCH_TOKEN_RECORD_FAILED", { status: 500, body: { message: "records failed", code: "BATCH_TOKEN_RECORD_FAILED" } }],
  ] as Array<[string, Route]>)("carries %s through and says a fresh approval is needed", async (code, route) => {
    harness({ token: [route] });
    const out = await run({ action: "login", projects: LIST, deviceCode: "dev-code" });

    expect(out.ok).toBe(false);
    expect(out.value.code).toBe(code);
    expect(out.hint).toContain("fresh approval");
    expect(listCredentials()).toHaveLength(0);
  });

  it("says a spent or expired code plainly", async () => {
    harness({ token: [{ status: 400, body: { error: "expired_token" } }] });
    const out = await run({ action: "login", projects: LIST, deviceCode: "dev-code" });

    expect(out.status).toBe("login-expired");
    expect(out.error.message).toContain("already spent");
  });

  it("says a platform that refuses the list form may predate it", async () => {
    harness({
      code: { status: 400, body: { message: "Field 'project' must be in the form '<workspace>/<project>'." } },
    });
    const out = await run({ action: "login", projects: LIST });

    expect(out.status).toBe("login-failed");
    expect(out.hint).toContain("its own extension_auth (action: login, project) call");
  });

  it("leaves the single-project login exactly as it was", async () => {
    const h = harness({ token: [{ status: 200, body: entry("alpha") }] });
    const out = await run({ action: "login", project: "acme/alpha", deviceCode: "dev-code" });

    expect(out.status).toBe("logged-in");
    expect(out.value).toEqual({
      workspaceSlug: "acme",
      projectSlug: "alpha",
      expiresAt: new Date(1_900_000_000 * 1000).toISOString(),
    });
    expect(h.to("/api/cli/device/token")[0]?.body).toEqual({
      device_code: "dev-code",
      project: "acme/alpha",
    });
    expect(readCredentials()?.projectSlug).toBe("alpha");
  });
});

describe("the device flow carries a list as a list", () => {
  it("sends projects and never project beside it, on the code and on the poll", async () => {
    const bodies: any[] = [];
    const fetchImpl = vi.fn(async (_url: any, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return jsonResponse(
        bodies.length === 1
          ? { device_code: "d", user_code: "u" }
          : { token: "t", tokens: [] },
      );
    }) as unknown as typeof fetch;

    await requestDeviceCode({
      apiBase: API,
      path: "/code",
      project: "acme/alpha",
      projects: LIST,
      fetchImpl,
    });
    await pollDeviceGrant({
      apiBase: API,
      path: "/token",
      project: "acme/alpha",
      projects: LIST,
      deviceCode: "d",
      interval: 5,
      budgetMs: 1000,
      fetchImpl,
    });

    expect(bodies).toEqual([
      { projects: LIST, clientName: "extension-mcp" },
      { device_code: "d", projects: LIST },
    ]);
  });

  it("keeps the single-project bodies byte for byte", async () => {
    const bodies: string[] = [];
    const fetchImpl = vi.fn(async (_url: any, init?: RequestInit) => {
      bodies.push(String(init?.body));
      return jsonResponse(
        bodies.length === 1 ? { device_code: "d", user_code: "u" } : { token: "t" },
      );
    }) as unknown as typeof fetch;

    await requestDeviceCode({ apiBase: API, path: "/code", project: "acme/alpha", intent: "create", fetchImpl });
    await pollDeviceGrant({ apiBase: API, path: "/token", project: "acme/alpha", deviceCode: "d", interval: 5, budgetMs: 1000, fetchImpl });

    expect(bodies).toEqual([
      '{"project":"acme/alpha","clientName":"extension-mcp","intent":"create"}',
      '{"device_code":"d","project":"acme/alpha"}',
    ]);
  });

  it("does not abandon a final poll that outlasts the call's budget", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          setTimeout(
            () => resolve(jsonResponse({ token: "t", tokens: [entry("alpha")] })),
            60_000,
          );
        }),
    ) as unknown as typeof fetch;

    const pending = pollDeviceGrant({
      apiBase: API,
      path: "/token",
      projects: ["acme/alpha"],
      deviceCode: "d",
      interval: 5,
      budgetMs: 22_000,
      fetchImpl,
    });
    await vi.advanceTimersByTimeAsync(60_000);
    const out = await pending;

    expect(out.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("writeCredentialBatch", () => {
  it("adds every entry in one write and keeps the active login", () => {
    writeCredentials(stored("first"));
    writeCredentialBatch([stored("alpha"), stored("beta")]);

    expect(readCredentials()?.projectSlug).toBe("first");
    expect(listCredentials().map((item) => item.projectSlug).sort()).toEqual([
      "alpha",
      "beta",
      "first",
    ]);
  });

  it("takes the first entry as active only for an empty store, and writes nothing for an empty batch", () => {
    expect(writeCredentialBatch([])).toBeNull();
    expect(listCredentials()).toHaveLength(0);
    writeCredentialBatch([stored("alpha"), stored("beta")]);
    expect(readCredentials()?.projectSlug).toBe("alpha");
  });
});
