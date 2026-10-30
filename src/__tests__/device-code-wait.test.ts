import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { readCredentials } from "../lib/credentials";
import { rememberPendingCreate } from "../lib/pending-creates";
import { schema as authSchema } from "../tools/auth";
import { loginToProject } from "../tools/login";
import { handler as createProject, schema as createSchema } from "../tools/project-create";

const API = "https://api.test";
const PROJECT = "acme/ghost-app";
const FUTURE = Math.floor(Date.now() / 1000) + 900;

type Route = { status: number; body: unknown };

const PENDING: Route = { status: 400, body: { error: "authorization_pending" } };
const SLOW_DOWN: Route = { status: 400, body: { error: "slow_down" } };
const EXPIRED: Route = { status: 400, body: { error: "expired_token", message: "The device code has expired." } };

const GRANT: Route = {
  status: 200,
  body: { token: "provision-token", expiresAt: FUTURE, workspaceSlug: "acme", projectSlug: "ghost-app", tokenKind: "provisioning" },
};

const LOGIN_TOKEN: Route = {
  status: 200,
  body: { token: "project-token", expiresAt: FUTURE, workspaceSlug: "acme", projectSlug: "ghost-app" },
};

const CREATED = {
  success: true,
  projectId: "prj_new",
  projectSlug: "ghost-app",
  workspaceSlug: "acme",
  initialBuild: { dispatched: true },
};

function platform(routes: { token: Route[]; create?: Route; interval?: number }) {
  let tokenCalls = 0;
  const tokenPolledAt: number[] = [];
  const fn = vi.fn(async (url: unknown) => {
    const href = String(url);
    const reply = (route: Route) => new Response(JSON.stringify(route.body), { status: route.status });

    if (href.endsWith("/api/cli/login/config")) {
      return reply({
        status: 200,
        body: { deviceCodeUrl: "/api/cli/device/code", deviceTokenUrl: "/api/cli/device/token", verificationUri: "https://extension.dev/device" },
      });
    }

    if (href.includes("/api/projects/resolve?")) return reply({ status: 404, body: { code: "NO_PUBLIC_PROJECT" } });

    if (href.endsWith("/api/cli/device/code")) {
      return reply({
        status: 200,
        body: {
          device_code: "dev-code",
          user_code: "ABCD-1234",
          verification_uri: "https://extension.dev/device",
          verification_uri_complete: "https://extension.dev/device?code=ABCD-1234",
          interval: routes.interval ?? 30,
          expires_in: 900,
        },
      });
    }

    if (href.endsWith("/api/cli/device/token")) {
      tokenPolledAt.push(Date.now());
      const next = routes.token[Math.min(tokenCalls, routes.token.length - 1)] ?? PENDING;
      tokenCalls += 1;

      return reply(next);
    }

    if (href.endsWith("/api/cli/projects/create")) return reply(routes.create ?? { status: 200, body: CREATED });

    throw new Error(`Unexpected fetch: ${href}`);
  });

  vi.stubGlobal("fetch", fn);

  return { tokenPolls: () => tokenCalls, tokenPolledAt };
}

const ENV_KEYS = ["XDG_CONFIG_HOME", "EXTENSION_DEV_API_URL", "EXTENSION_DEV_TOKEN", "EXTENSION_DEV_PROJECT"];
const saved: Record<string, string | undefined> = {};
let tmp: string;

beforeEach(() => {
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "extdev-device-wait-"));
  process.env.XDG_CONFIG_HOME = tmp;
  process.env.EXTENSION_DEV_API_URL = API;
  delete process.env.EXTENSION_DEV_TOKEN;
  delete process.env.EXTENSION_DEV_PROJECT;
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();

  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }

  fs.rmSync(tmp, { recursive: true, force: true });
});

function fakeClock() {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
}

async function settle<T>(run: Promise<T>, seconds: number): Promise<T> {
  await vi.advanceTimersByTimeAsync(seconds * 1000);

  return run;
}

const create = (args: Record<string, unknown>) =>
  createProject({ project: PROJECT, repo: "acme/ghost-app-src", ...args } as never).then((out) => JSON.parse(out));

const login = (args: Record<string, unknown>) =>
  loginToProject({ project: PROJECT, ...args } as never).then((out) => JSON.parse(out));

describe("extension_project_create waits inside the call (ledger 292)", () => {
  it("answers created in the same call once the owner approves during the wait", async () => {
    const h = platform({ token: [PENDING, PENDING, GRANT] });
    fakeClock();
    const out = await settle(create({ deviceCode: "dev-code", waitSeconds: 120 }), 15);

    expect(out.status).toBe("created");
    expect(h.tokenPolls()).toBe(3);
    expect(out.value.login).toBeDefined();
  });

  it("answers authorization-pending with waitedSeconds and the seconds left when the bound passes first", async () => {
    platform({ token: [PENDING] });
    await create({});
    fakeClock();
    const out = await settle(create({ deviceCode: "dev-code", waitSeconds: 60 }), 60);

    expect(out.status).toBe("authorization-pending");
    expect(out.value.waitedSeconds).toBeGreaterThanOrEqual(50);
    expect(out.value.waitedSeconds).toBeLessThanOrEqual(60);
    expect(out.value.expiresInSeconds).toBeGreaterThan(800);
    expect(out.value.expiresInSeconds).toBeLessThanOrEqual(900);
    expect(out.value.expiresAt).toMatch(/^\d{4}-/);
    expect(out.hint).toMatch(/^Waited \d+ s and the owner has not approved yet/);
    expect(out.hint).toContain("call extension_project_create again with this deviceCode and the same arguments and waitSeconds");
  });

  it("clamps the wait to the code's remaining life", async () => {
    platform({ token: [PENDING] });
    rememberPendingCreate(API, PROJECT, {
      userCode: "ABCD-1234",
      verificationUri: "https://extension.dev/device",
      expiresAt: new Date(Date.now() + 30_000).toISOString(),
    });

    fakeClock();
    const out = await settle(create({ deviceCode: "dev-code", waitSeconds: 900 }), 60);

    expect(out.status).toBe("authorization-pending");
    expect(out.value.waitedSeconds).toBeLessThanOrEqual(30);
    expect(out.value.expiresInSeconds).toBeLessThanOrEqual(5);
  });

  it("answers create-expired naming a new code without the old deviceCode when the code dies mid-wait", async () => {
    platform({ token: [PENDING, EXPIRED] });
    fakeClock();
    const out = await settle(create({ deviceCode: "dev-code", waitSeconds: 120 }), 10);

    expect(out.status).toBe("create-expired");
    expect(out.error.code).toBe("E_AUTH_EXPIRED");
    expect(out.error.message).toContain("a new code is needed");
    expect(out.error.message).toContain("without the old deviceCode");
  });

  it("never holds the first call, which carries the link, and says where waitSeconds applies", async () => {
    const h = platform({ token: [PENDING] });
    const out = await create({ waitSeconds: 600 });

    expect(out.status).toBe("authorization-pending");
    expect(h.tokenPolls()).toBe(1);
    expect(out.warnings[0]).toContain("waitSeconds applies to the call that carries deviceCode");
    expect(out.hint).toContain("waitSeconds: 900");
  });

  it("respects slow_down from the platform while it waits", async () => {
    const h = platform({ token: [SLOW_DOWN, PENDING, GRANT] });
    fakeClock();
    const run = create({ deviceCode: "dev-code", waitSeconds: 120 });
    await vi.advanceTimersByTimeAsync(9_000);
    expect(h.tokenPolls()).toBe(1);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(h.tokenPolls()).toBe(2);
    const out = await settle(run, 10);

    expect(out.status).toBe("created");
    expect(h.tokenPolls()).toBe(3);
  });

  it("declares waitSeconds 0 to 900 and says the call blocks", () => {
    const wait = createSchema.inputSchema.properties.waitSeconds;

    expect(wait.minimum).toBe(0);
    expect(wait.maximum).toBe(900);
    expect(wait.description).toContain("blocks");
    expect(createSchema.description).toContain("blocks (up to 900 s");
  });
});

describe("extension_auth login waits inside the call (ledger 292)", () => {
  it("answers logged-in in the same call once the owner approves during the wait", async () => {
    const h = platform({ token: [PENDING, PENDING, LOGIN_TOKEN] });
    fakeClock();
    const out = await settle(login({ deviceCode: "dev-code", waitSeconds: 120 }), 15);

    expect(out.status).toBe("logged-in");
    expect(h.tokenPolls()).toBe(3);
    expect(readCredentials({ project: PROJECT, api: API })?.token).toBe("project-token");
  });

  it("remembers the code's clock from the first call, so a resume that runs out answers the seconds left", async () => {
    platform({ token: [PENDING] });
    const first = await login({});

    expect(first.status).toBe("authorization-pending");
    expect(first.value.expiresInSeconds).toBe(900);
    expect(first.hint).toContain("waitSeconds: 900");

    fakeClock();
    const out = await settle(login({ deviceCode: "dev-code", waitSeconds: 60 }), 60);

    expect(out.status).toBe("authorization-pending");
    expect(out.value.waitedSeconds).toBeGreaterThanOrEqual(50);
    expect(out.value.expiresInSeconds).toBeGreaterThan(800);
    expect(out.value.expiresInSeconds).toBeLessThan(900);
    expect(out.hint).toMatch(/^Waited \d+ s and the owner has not approved yet/);
  });

  it("answers login-expired naming a new code without deviceCode when the code dies mid-wait", async () => {
    platform({ token: [PENDING, EXPIRED] });
    fakeClock();
    const out = await settle(login({ deviceCode: "dev-code", waitSeconds: 120 }), 10);

    expect(out.status).toBe("login-expired");
    expect(out.error.message).toContain("a new code is needed");
    expect(out.error.message).toContain("without deviceCode");
  });

  it("never holds the first call and says where waitSeconds applies", async () => {
    const h = platform({ token: [PENDING] });
    const out = await login({ waitSeconds: 600 });

    expect(out.status).toBe("authorization-pending");
    expect(h.tokenPolls()).toBe(1);
    expect(out.warnings.join(" ")).toContain("waitSeconds applies to the call that carries deviceCode");
  });

  it("declares waitSeconds 0 to 900 on extension_auth and says the call blocks", () => {
    const wait = (authSchema.inputSchema.properties as Record<string, { minimum?: number; maximum?: number; description?: string }>).waitSeconds!;

    expect(wait.minimum).toBe(0);
    expect(wait.maximum).toBe(900);
    expect(wait.description).toContain("blocks");
    expect(authSchema.description).toContain("blocks (up to 900 s");
  });
});

describe("extension_project_create stores the login the create minted (ledger 293)", () => {
  const issued = { ...CREATED, tokenIssued: true, token: "project-token", expiresAt: FUTURE };

  it("stores the token as the project's login and drops the extension_auth step", async () => {
    platform({ token: [GRANT], create: { status: 200, body: issued } });
    const out = await create({ deviceCode: "dev-code" });

    expect(out.status).toBe("created");
    expect(out.value.login).toMatchObject({ stored: true, project: PROJECT });
    expect(out.value.login.expiresAt).toMatch(/^\d{4}-/);
    expect(readCredentials({ project: PROJECT, api: API })?.token).toBe("project-token");
    expect(out.value.nextSteps[0]).toBe("extension_publish");
    expect(out.value.nextSteps.join(" ")).not.toContain("extension_auth");
    expect(out.hint).toContain("no extension_auth call is needed");
    expect(out.hint).not.toContain("to mint the project token");
  });

  it("says one more approval is needed when the platform answers no token on the grant", async () => {
    platform({
      token: [GRANT],
      create: { status: 200, body: { ...CREATED, tokenIssued: false, tokenCode: "PROJECT_TOKEN_NOT_ISSUED", tokenMessage: "No token on this grant." } },
    });

    const out = await create({ deviceCode: "dev-code" });

    expect(out.status).toBe("created");
    expect(out.value.login).toEqual({ stored: false, project: PROJECT, reason: "PROJECT_TOKEN_NOT_ISSUED", message: "No token on this grant." });
    expect(readCredentials({ project: PROJECT, api: API })).toBeNull();
    expect(out.value.nextSteps[0]).toContain("extension_auth (action: login, project: 'acme/ghost-app')");
    expect(out.hint).toContain("The platform answered no project token on this grant (PROJECT_TOKEN_NOT_ISSUED), so one more approval is needed: extension_auth (action: login, project: 'acme/ghost-app')");
  });

  it("answers NO_TOKEN_IN_RESPONSE for a platform that says nothing about a token", async () => {
    platform({ token: [GRANT] });
    const out = await create({ deviceCode: "dev-code" });

    expect(out.value.login).toEqual({ stored: false, project: PROJECT, reason: "NO_TOKEN_IN_RESPONSE" });
    expect(out.value.nextSteps[0]).toContain("extension_auth");
  });

  it("discards the token when login is false", async () => {
    platform({ token: [GRANT], create: { status: 200, body: issued } });
    const out = await create({ deviceCode: "dev-code", login: false });

    expect(out.value.login).toEqual({ stored: false, project: PROJECT, reason: "not-asked" });
    expect(readCredentials({ project: PROJECT, api: API })).toBeNull();
    expect(out.hint).toContain("the token the platform answered was discarded");
    expect(out.value.nextSteps[0]).toContain("extension_auth");
  });

  it("stores nothing from a replayed create, which carries no token", async () => {
    platform({ token: [GRANT], create: { status: 200, body: { ...CREATED, replayed: true } } });
    const out = await create({ deviceCode: "dev-code" });

    expect(out.value.login).toEqual({ stored: false, project: PROJECT, reason: "replayed" });
    expect(out.hint).toContain("a replay carries no token");
  });

  it("declares login as a boolean that defaults to true", () => {
    expect(createSchema.inputSchema.properties.login.type).toBe("boolean");
    expect(createSchema.inputSchema.properties.login.default).toBe(true);
    expect(createSchema.description).toContain("extension_auth (action: login) is needed only when value.login.stored is false");
  });
});
