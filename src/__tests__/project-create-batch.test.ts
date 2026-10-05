import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { handler, schema } from "../tools/project-create";
import {
  credentialsPath,
  listCredentials,
  readCredentials,
  writeCredentials,
} from "../lib/credentials";
import { PLATFORM_HOLD_STATUS } from "../lib/platform-hold";
import {
  parseBatchCreateArgs,
  resetBatchCreateSessions,
} from "../lib/project-create-batch";

const API = "https://api.test";
const GRANT = "batch-grant-secret-value";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(
    typeof body === "string" ? body : JSON.stringify(body),
    { status },
  );
}

type Route = { status: number; body: unknown; headers?: Record<string, string> };
type CreateRoute = Route | "network-error";

let clock = 0;

function harness(options: {
  batchOnboarding?: unknown;
  code?: Route;
  token?: Route[];
  create?: (project: string, slug: string, call: number) => CreateRoute;
  createTakesMs?: number;
}) {
  const calls: Array<{ url: string; body: any; headers: Record<string, string> }> = [];
  let tokenCalls = 0;
  let createCalls = 0;
  const fn = vi.fn(async (url: any, init?: RequestInit) => {
    const href = String(url);
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({
      url: href,
      body,
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
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
          verification_uri_complete:
            "https://extension.dev/device?code=ABCD-1234",
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
    if (href.endsWith("/api/cli/projects/create")) {
      createCalls += 1;
      clock += options.createTakesMs ?? 1_000;
      const ref = String(body?.project || "");
      const slug = ref.split("/")[1] ?? "";
      const route = options.create
        ? options.create(ref, slug, createCalls)
        : created(slug);
      if (route === "network-error") throw new Error("socket hang up");
      return new Response(JSON.stringify(route.body), {
        status: route.status,
        headers: route.headers,
      });
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

function created(slug: string, extra: Record<string, unknown> = {}): Route {
  return {
    status: 200,
    body: {
      success: true,
      projectId: `prj_${slug}`,
      projectSlug: slug,
      workspaceSlug: "acme",
      idempotencyKey: `idem-${slug}`,
      initialBuild: { dispatched: true },
      tokenIssued: true,
      token: `seven-day-token-for-${slug}`,
      expiresAt: 1_900_000_000,
      ttlSeconds: 604800,
      ...extra,
    },
  };
}

function refused(status: number, code: string, extra: Record<string, unknown> = {}): Route {
  return { status, body: { message: `refused: ${code}`, code, ...extra } };
}

function grant(slugs: string[], extra: Record<string, unknown> = {}): Route {
  return {
    status: 200,
    body: {
      token: GRANT,
      expiresAt: Math.floor(clock / 1000) + 900,
      ttlSeconds: 900,
      workspaceSlug: "acme",
      projectSlugs: slugs,
      tokenKind: "provisioning",
      ...extra,
    },
  };
}

const THREE = [
  { project: "acme/alpha", repo: "octo/alpha-src" },
  { project: "acme/beta", repo: "octo/beta-src" },
  { project: "acme/gamma", repo: "octo/gamma-src" },
];
const SLUGS = ["alpha", "beta", "gamma"];

async function run(args: Record<string, unknown>) {
  return JSON.parse(await handler(args as never));
}

let tmp: string;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("batch create tests never reach the network");
    }),
  );
  for (const key of ["XDG_CONFIG_HOME", "EXTENSION_DEV_API_URL", "EXTENSION_DEV_TOKEN", "EXTENSION_DEV_PROJECT"]) {
    saved[key] = process.env[key];
  }
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "extdev-batchcreate-"));
  process.env.XDG_CONFIG_HOME = tmp;
  process.env.EXTENSION_DEV_API_URL = API;
  delete process.env.EXTENSION_DEV_TOKEN;
  delete process.env.EXTENSION_DEV_PROJECT;
  clock = 1_800_000_000_000;
  vi.spyOn(Date, "now").mockImplementation(() => clock);
  resetBatchCreateSessions();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("extension_project_create with projects: refusals before a device code is spent", () => {
  it.each([
    ["two workspaces", [THREE[0], { project: "globex/tool", repo: "octo/tool" }], "one workspace"],
    ["a name twice", [THREE[0], { project: "ACME/Alpha", repo: "octo/again" }], "named twice"],
    ["a name the platform would rename", [{ project: "acme/my.app", repo: "octo/app" }], "exact slug"],
    ["a slug over 48 characters", [{ project: `acme/${"p".repeat(49)}`, repo: "octo/app" }], "exact slug"],
    ["an empty list", [], "between 1 and 20"],
    ["a bare name where an entry belongs", ["acme/alpha"], "must be an object"],
    ["an entry with no repo", [{ project: "acme/alpha" }], "needs repo"],
    ["an entry with an unknown key", [{ project: "acme/alpha", repo: "octo/a", branch: "main" }], "Unknown key 'branch'"],
    ["an entry with an unsupported browser", [{ project: "acme/alpha", repo: "octo/a", browsers: ["safari"] }], "browsers must be"],
    ["an entry whose build command is not a string", [{ project: "acme/alpha", repo: "octo/a", buildCommand: 3 }], "buildCommand must be a string"],
    ["something that is not a list", "acme/alpha", "must be an array"],
  ])("refuses %s with the reason and no network call", async (_label, projects, fragment) => {
    const { fn } = harness({});
    const out = await run({ projects });
    expect(out.ok).toBe(false);
    expect(out.status).toBe("bad-request");
    expect(out.error.code).toBe("E_BAD_REQUEST");
    expect(out.error.message).toContain(fragment);
    expect(fn).not.toHaveBeenCalled();
  });

  const entries = (count: number) =>
    Array.from({ length: count }, (_, i) => ({
      project: `acme/app-${i + 1}`,
      repo: `octo/app-${i + 1}`,
    }));

  it("refuses eleven projects against the platform's cap of ten, without chunking and without a device code", async () => {
    const h = harness({});
    const out = await run({ projects: entries(11) });

    expect(out.ok).toBe(false);
    expect(out.status).toBe("bad-request");
    expect(out.error.message).toContain("creates at most 10");
    expect(out.value).toEqual({ maxProjects: 10, listed: 11 });
    expect(out.hint).toContain("Send the first 10; the next 10 can start in a new call");
    expect(out.hint).toContain("once the hourly creation limit allows");
    expect(out.hint).toContain("at most 10 projects per hour");
    expect(out.hint).toContain("no device code was spent");
    expect(h.to("/api/cli/device/code")).toHaveLength(0);
    expect(h.calls.map((call) => call.url)).toEqual([`${API}/api/cli/login/config`]);
  });

  it("accepts exactly ten", async () => {
    const h = harness({});
    const out = await run({ projects: entries(10) });

    expect(parseBatchCreateArgs({ projects: entries(10) }).ok).toBe(true);
    expect(out.status).toBe("authorization-pending");
    expect(h.to("/api/cli/device/code")[0]?.body.projects).toHaveLength(10);
  });

  it("takes the create cap from the platform, lower or higher than ten", async () => {
    const low = harness({ batchOnboarding: { createProjectsPerApproval: 3, loginProjectsPerApproval: 20 } });
    const refused = await run({ projects: entries(4) });
    expect(refused.status).toBe("bad-request");
    expect(refused.value.maxProjects).toBe(3);
    expect(refused.hint).toContain("Send the first 3");
    expect(low.to("/api/cli/device/code")).toHaveLength(0);

    const high = harness({ batchOnboarding: { createProjectsPerApproval: 20, loginProjectsPerApproval: 20 } });
    const taken = await run({ projects: entries(11) });
    expect(taken.status).toBe("authorization-pending");
    expect(high.to("/api/cli/device/code")[0]?.body.projects).toHaveLength(11);
  });

  it.each([
    ["a missing number", {}],
    ["zero", { createProjectsPerApproval: 0 }],
    ["a negative number", { createProjectsPerApproval: -5 }],
    ["a string that is not a number", { createProjectsPerApproval: "many" }],
    ["a fraction", { createProjectsPerApproval: 10.5 }],
    ["null", { createProjectsPerApproval: null }],
  ])("falls back to ten when the platform advertises the capability with %s", async (_label, batchOnboarding) => {
    harness({ batchOnboarding });
    const refused = await run({ projects: entries(11) });
    expect(refused.value.maxProjects).toBe(10);

    harness({ batchOnboarding });
    const taken = await run({ projects: entries(10) });
    expect(taken.status).toBe("authorization-pending");
  });

  it("never reads a cap above twenty as more than twenty", async () => {
    harness({ batchOnboarding: { createProjectsPerApproval: 500 } });
    const out = await run({ projects: entries(21) });

    expect(out.status).toBe("bad-request");
    expect(out.error.message).toContain("between 1 and 20");
  });

  it.each([
    ["no flag at all", undefined],
    ["a flag that is false", false],
    ["a flag that is true but carries nothing", true],
    ["a flag that is a list", [10, 20]],
    ["a flag that is null", null],
  ])("refuses a list before spending a device code when the platform answers with %s", async (_label, batchOnboarding) => {
    const h = harness({ batchOnboarding });
    const out = await run({ projects: THREE });

    expect(out.ok).toBe(false);
    expect(out.status).toBe("batch-unsupported");
    expect(out.error.code).toBe("E_PLATFORM");
    expect(out.error.message).toContain("does not advertise batch onboarding");
    expect(out.value.projects).toEqual(["acme/alpha", "acme/beta", "acme/gamma"]);
    expect(out.hint).toContain("one extension_project_create call each");
    expect(h.to("/api/cli/device/code")).toHaveLength(0);
    expect(h.to("/api/cli/device/token")).toHaveLength(0);
  });

  it("still creates one project on a platform that advertises no batch", async () => {
    const h = harness({
      batchOnboarding: undefined,
      token: [{ status: 400, body: { error: "authorization_pending" } }],
    });
    const out = await run({ project: "acme/alpha", repo: "octo/alpha-src" });

    expect(out.status).toBe("authorization-pending");
    expect(h.to("/api/cli/device/code")[0]?.body).toEqual({
      project: "acme/alpha",
      clientName: "extension-mcp",
      intent: "create",
    });
  });

  it.each([
    ["project", { project: "acme/alpha" }],
    ["repo", { repo: "octo/alpha-src" }],
    ["displayName", { displayName: "Alpha" }],
    ["description", { description: "An extension" }],
  ])("refuses a top-level %s beside the list", async (key, extra) => {
    const { fn } = harness({});
    const out = await run({ projects: THREE, ...extra });
    expect(out.status).toBe("bad-request");
    expect(out.error.message).toContain(`${key} belongs inside each entry`);
    expect(fn).not.toHaveBeenCalled();
  });

  it("refuses to send a batch to a hostile api argument", async () => {
    const { fn } = harness({});
    const out = await run({ projects: THREE, api: "https://evil.example" });
    expect(out.ok).toBe(false);
    expect(out.error.message).toContain("Refusing to send the access token");
    expect(fn).not.toHaveBeenCalled();
  });

  it("names the limit in the tool description and the projects input", () => {
    expect(schema.description).toContain("One approval creates at most 10 projects");
    expect(schema.description).toContain("at most 10 per hour");
    expect(schema.description).toContain("the next 10 can start in a new call once that limit allows");
    expect(schema.description).toContain("never split silently");
    expect(schema.description).toContain("does not advertise batch onboarding");
    expect(schema.inputSchema.properties.projects.description).toContain("1 to 10 entries");
    expect(schema.inputSchema.properties.projects.description).toContain("at most 48 characters");
  });
});

describe("extension_project_create with projects: one approval", () => {
  it("asks for ONE device code naming every project and returns the pending shape", async () => {
    const h = harness({ token: [{ status: 400, body: { error: "authorization_pending" } }] });
    const out = await run({ projects: THREE });

    expect(out.ok).toBe(true);
    expect(out.status).toBe("authorization-pending");
    expect(out.value).toEqual({
      userCode: "ABCD-1234",
      verificationUri: "https://extension.dev/device",
      verificationUriComplete: "https://extension.dev/device?code=ABCD-1234",
      deviceCode: "dev-code",
      projects: ["acme/alpha", "acme/beta", "acme/gamma"],
    });
    expect(out.hint).toContain("lists all 3 projects");
    expect(out.hint).toContain("7 days");

    const codes = h.to("/api/cli/device/code");
    expect(codes).toHaveLength(1);
    expect(codes[0]?.body).toEqual({
      projects: ["acme/alpha", "acme/beta", "acme/gamma"],
      clientName: "extension-mcp",
      intent: "create",
    });
    expect(h.to("/api/cli/device/token")[0]?.body).toEqual({
      device_code: "dev-code",
      projects: ["acme/alpha", "acme/beta", "acme/gamma"],
    });
    expect(h.to("/api/cli/projects/create")).toHaveLength(0);
  });

  it("creates each project with its own request, the grant as bearer and the name in the body", async () => {
    const h = harness({ token: [grant(SLUGS)] });
    const out = await run({ projects: THREE, deviceCode: "dev-code" });

    expect(out.ok).toBe(true);
    expect(out.status).toBe("created");
    const creates = h.to("/api/cli/projects/create");
    expect(creates.map((call) => call.body.project)).toEqual([
      "acme/alpha",
      "acme/beta",
      "acme/gamma",
    ]);
    for (const [index, call] of creates.entries()) {
      expect(call.headers.authorization).toBe(`Bearer ${GRANT}`);
      expect(call.body.workspaceSlug).toBe("acme");
      expect(call.body.info.name).toBe(SLUGS[index]);
      expect(call.body.github).toMatchObject({
        owner: "octo",
        repo: `${SLUGS[index]}-src`,
      });
    }
    expect(h.to("/api/cli/device/code")).toHaveLength(0);
    expect(h.to("/api/cli/device/token")).toHaveLength(1);
  });

  it("stores each returned token as that project's login and reports a row per project", async () => {
    harness({ token: [grant(SLUGS)] });
    const out = await run({ projects: THREE, deviceCode: "dev-code" });

    expect(out.value.results).toEqual(
      SLUGS.map((slug) => ({
        project: `acme/${slug}`,
        status: "created",
        loggedIn: true,
        projectId: `prj_${slug}`,
        consoleUrl: expect.stringContaining(`/acme/${slug}`),
        firstBuild: { dispatched: true },
        expiresAt: new Date(1_900_000_000 * 1000).toISOString(),
      })),
    );
    expect(out.value.counts).toEqual({
      listed: 3,
      created: 3,
      loggedIn: 3,
      refused: 0,
      unconfirmed: 0,
      notAttempted: 0,
    });
    for (const slug of SLUGS) {
      expect(readCredentials({ project: `acme/${slug}` })).toMatchObject({
        token: `seven-day-token-for-${slug}`,
        workspaceSlug: "acme",
        projectSlug: slug,
        expiresAt: 1_900_000_000,
        api: API,
      });
    }
    expect(listCredentials()).toHaveLength(3);
  });

  it("never puts the grant or a project token in the envelope, and never writes the grant to disk", async () => {
    harness({ token: [grant(SLUGS)] });
    const text = await handler({ projects: THREE, deviceCode: "dev-code" } as never);

    expect(text).not.toContain(GRANT);
    expect(text).not.toContain("seven-day-token-for-");
    expect(fs.readFileSync(credentialsPath(), "utf8")).not.toContain(GRANT);
  });

  it("keeps the grant out of every envelope a list can answer with on the way", async () => {
    harness({ token: [{ status: 400, body: { error: "authorization_pending" } }] });
    const pending = await handler({ projects: THREE } as never);

    harness({ token: [grant(SLUGS)], createTakesMs: 21_000 });
    const creating = await handler({ projects: THREE, deviceCode: "dev-code" } as never);
    const creatingAgain = await handler({ projects: THREE, deviceCode: "dev-code" } as never);
    const mismatch = await handler({ projects: [THREE[0]], deviceCode: "dev-code" } as never);
    const done = await handler({ projects: THREE, deviceCode: "dev-code" } as never);

    expect(JSON.parse(creating).status).toBe("creating");
    expect(JSON.parse(creatingAgain).status).toBe("creating");
    expect(JSON.parse(mismatch).status).toBe("bad-request");
    expect(JSON.parse(done).status).toBe("created");
    for (const text of [pending, creating, creatingAgain, mismatch, done]) {
      expect(text).not.toContain(GRANT);
      expect(text).not.toContain("seven-day-token-for-");
    }
    expect(fs.readFileSync(credentialsPath(), "utf8")).not.toContain(GRANT);
  });

  it("leaves the default login where it was", async () => {
    writeCredentials({
      version: 1,
      token: "earlier-token",
      workspaceSlug: "acme",
      projectSlug: "earlier",
      expiresAt: 1_900_000_000,
      api: API,
    });
    harness({ token: [grant(SLUGS)] });
    await run({ projects: THREE, deviceCode: "dev-code" });

    expect(readCredentials()?.projectSlug).toBe("earlier");
    expect(listCredentials()).toHaveLength(4);
  });

  it("makes the first created project the default only when no login existed", async () => {
    harness({ token: [grant(SLUGS)] });
    await run({ projects: THREE, deviceCode: "dev-code" });

    expect(readCredentials()?.projectSlug).toBe("alpha");
  });

  it("sends per-entry build settings over the shared defaults", async () => {
    const h = harness({ token: [grant(["alpha", "beta"])] });
    await run({
      projects: [
        { project: "acme/alpha", repo: "octo/a" },
        {
          project: "acme/beta",
          repo: "octo/b",
          buildCommand: "pnpm build:beta",
          browsers: ["firefox"],
          displayName: "Beta Tool",
        },
      ],
      installCommand: "pnpm install",
      buildCommand: "pnpm build",
      browsers: ["chrome", "edge"],
      deviceCode: "dev-code",
    });

    const [alpha, beta] = h.to("/api/cli/projects/create").map((call) => call.body);
    expect(alpha.build.chrome).toMatchObject({
      enabled: true,
      installCommand: "pnpm install",
      buildCommand: "pnpm build",
    });
    expect(alpha.build.edge.enabled).toBe(true);
    expect(alpha.build.firefox.enabled).toBe(false);
    expect(alpha.info.displayName).toBe("alpha");
    expect(beta.build.firefox).toMatchObject({
      enabled: true,
      installCommand: "pnpm install",
      buildCommand: "pnpm build:beta",
    });
    expect(beta.build.chrome.enabled).toBe(false);
    expect(beta.info.displayName).toBe("Beta Tool");
  });
});

describe("extension_project_create with projects: every project keeps its own answer", () => {
  it("reports created with no token and points at a batch login", async () => {
    harness({
      token: [grant(SLUGS)],
      create: (_ref, slug) =>
        slug === "beta"
          ? {
              status: 200,
              body: {
                success: true,
                projectId: "prj_beta",
                projectSlug: "beta",
                workspaceSlug: "acme",
                tokenIssued: false,
                tokenCode: "PROJECT_TOKEN_NOT_ISSUED",
              },
            }
          : created(slug),
    });
    const out = await run({ projects: THREE, deviceCode: "dev-code" });

    expect(out.ok).toBe(true);
    expect(out.status).toBe("created");
    expect(out.value.results[1]).toMatchObject({
      project: "acme/beta",
      status: "created",
      loggedIn: false,
      tokenCode: "PROJECT_TOKEN_NOT_ISSUED",
    });
    expect(out.value.nextSteps[0]).toBe(
      "extension_auth (action: login, projects: ['acme/beta'])",
    );
    expect(out.warnings[0]).toContain("acme/beta");
    expect(readCredentials({ project: "acme/beta" })).toBeNull();
    expect(readCredentials({ project: "acme/alpha" })?.token).toBe(
      "seven-day-token-for-alpha",
    );
  });

  it("keeps going past a refusal that is about one project, and shows every row", async () => {
    const h = harness({
      token: [grant(SLUGS)],
      create: (_ref, slug) =>
        slug === "alpha" ? refused(409, "PROJECT_EXISTS") : created(slug),
    });
    const out = await run({ projects: THREE, deviceCode: "dev-code" });

    expect(out.ok).toBe(false);
    expect(out.status).toBe("batch-incomplete");
    expect(h.to("/api/cli/projects/create")).toHaveLength(3);
    expect(out.value.results.map((row: any) => [row.project, row.status])).toEqual([
      ["acme/alpha", "refused"],
      ["acme/beta", "created"],
      ["acme/gamma", "created"],
    ]);
    expect(out.value.results[0]).toMatchObject({
      httpStatus: 409,
      code: "PROJECT_EXISTS",
      message: "refused: PROJECT_EXISTS",
    });
    expect(out.value.nextSteps[0]).toBe(
      "extension_auth (action: login, projects: ['acme/alpha'])",
    );
    expect(out.error.message).toContain("2 of 3 projects were created");
    expect(listCredentials().map((entry) => entry.projectSlug).sort()).toEqual([
      "beta",
      "gamma",
    ]);
  });

  it("stops at the hourly limit, names it, and marks the rest not attempted", async () => {
    const h = harness({
      token: [grant(SLUGS)],
      create: (_ref, slug) =>
        slug === "beta"
          ? refused(429, "RATE_LIMITED", { retryAfterSeconds: 1800 })
          : created(slug),
    });
    const out = await run({ projects: THREE, deviceCode: "dev-code" });

    expect(h.to("/api/cli/projects/create")).toHaveLength(2);
    expect(out.status).toBe("batch-incomplete");
    expect(out.value.results).toMatchObject([
      { project: "acme/alpha", status: "created", loggedIn: true },
      {
        project: "acme/beta",
        status: "refused",
        code: "RATE_LIMITED",
        retryAfterSeconds: 1800,
      },
      { project: "acme/gamma", status: "not-attempted", code: "RATE_LIMITED" },
    ]);
    expect(out.value.results[1].hint).toContain("at most 10 projects per hour");
    expect(out.value.results[1].hint).toContain("1800 seconds");
    expect(out.hint).toContain("at most 10 projects per hour");
    expect(out.value.nextSteps.join(" ")).toContain("['acme/beta', 'acme/gamma']");
  });

  it("reads the wait from the Retry-After header when the body does not carry it", async () => {
    harness({
      token: [grant(SLUGS)],
      create: () => ({
        status: 429,
        body: { message: "Too many project creations.", code: "RATE_LIMITED" },
        headers: { "retry-after": "2400" },
      }),
    });
    const out = await run({ projects: THREE, deviceCode: "dev-code" });

    expect(out.value.results[0]).toMatchObject({
      status: "refused",
      code: "RATE_LIMITED",
      retryAfterSeconds: 2400,
    });
    expect(out.value.results[0].hint).toContain("2400 seconds");
  });

  it.each([
    "TOKEN_EXPIRED",
    "MEMBERSHIP_REVOKED",
    "PROJECT_LIMIT_EXCEEDED",
    "INSTALLATION_ABSENT",
    "NOT_A_PROVISIONING_GRANT",
  ])("stops the list at %s, which is about the approval and not the project", async (code) => {
    const h = harness({
      token: [grant(SLUGS)],
      create: () => refused(403, code, { connectUrl: "https://www.extension.dev/connect/github" }),
    });
    const out = await run({ projects: THREE, deviceCode: "dev-code" });

    expect(h.to("/api/cli/projects/create")).toHaveLength(1);
    expect(out.value.results.map((row: any) => row.status)).toEqual([
      "refused",
      "not-attempted",
      "not-attempted",
    ]);
    expect(out.value.results[0].code).toBe(code);
    expect(out.value.results[0].connectUrl).toBe(
      "https://www.extension.dev/connect/github",
    );
    expect(out.value.results[2].code).toBe(code);
  });

  it.each(["RESERVED_PROJECT_SLUG", "PROJECT_CREATE_ROLLED_BACK", "SOMETHING_NEW"])(
    "keeps going past %s",
    async (code) => {
      const h = harness({
        token: [grant(SLUGS)],
        create: (_ref, slug) => (slug === "alpha" ? refused(409, code) : created(slug)),
      });
      const out = await run({ projects: THREE, deviceCode: "dev-code" });

      expect(h.to("/api/cli/projects/create")).toHaveLength(3);
      expect(out.value.counts).toMatchObject({ created: 2, refused: 1, notAttempted: 0 });
    },
  );

  it("answers the hold envelope when the hold refuses the first project", async () => {
    harness({
      token: [grant(SLUGS)],
      create: () => refused(403, "PLATFORM_NOT_OPEN"),
    });
    const out = await run({ projects: THREE, deviceCode: "dev-code" });

    expect(out.ok).toBe(false);
    expect(out.status).toBe(PLATFORM_HOLD_STATUS);
    expect(out.value.projects).toEqual(["acme/alpha", "acme/beta", "acme/gamma"]);
    expect(out.value.results).toHaveLength(3);
  });

  it("answers lane-closed with the console route when the lane closed after approval", async () => {
    harness({
      token: [grant(SLUGS)],
      create: () => refused(403, "CLI_PROJECT_CREATE_DISABLED"),
    });
    const out = await run({ projects: THREE, deviceCode: "dev-code" });

    expect(out.status).toBe("lane-closed");
    expect(out.hint).toContain("console");
    expect(out.value.results).toHaveLength(3);
  });

  it("stores no login when the platform registered a different name", async () => {
    harness({
      token: [grant(["alpha"])],
      create: () => created("alpha-2"),
    });
    const out = await run({ projects: [THREE[0]], deviceCode: "dev-code" });

    expect(out.value.results[0]).toMatchObject({
      project: "acme/alpha",
      status: "created",
      loggedIn: false,
      tokenCode: "PROJECT_NAME_MISMATCH",
    });
    expect(listCredentials()).toHaveLength(0);
  });

  it("stores no token the platform did not mark as issued, even when one is in the body", async () => {
    harness({
      token: [grant(["alpha"])],
      create: () => created("alpha", { tokenIssued: false, tokenCode: "PROJECT_TOKEN_NOT_ISSUED" }),
    });
    const out = await run({ projects: [THREE[0]], deviceCode: "dev-code" });

    expect(out.value.results[0]).toMatchObject({
      status: "created",
      loggedIn: false,
      tokenCode: "PROJECT_TOKEN_NOT_ISSUED",
    });
    expect(listCredentials()).toHaveLength(0);
  });

  it("stores no login when the platform answered in another workspace", async () => {
    harness({
      token: [grant(["alpha"])],
      create: () => created("alpha", { workspaceSlug: "globex" }),
    });
    const out = await run({ projects: [THREE[0]], deviceCode: "dev-code" });

    expect(out.value.results[0].loggedIn).toBe(false);
    expect(listCredentials()).toHaveLength(0);
  });

  it("marks a request with no answer unconfirmed and does not send it again", async () => {
    const h = harness({
      token: [grant(SLUGS)],
      create: (_ref, slug, call) => (slug === "alpha" && call === 1 ? "network-error" : created(slug)),
    });
    const first = await run({ projects: THREE, deviceCode: "dev-code" });

    expect(first.status).toBe("creating");
    expect(first.value.results[0]).toMatchObject({
      project: "acme/alpha",
      status: "unconfirmed",
    });
    expect(first.value.remaining).toEqual(["acme/beta", "acme/gamma"]);

    const second = await run({ projects: THREE, deviceCode: "dev-code" });

    expect(h.to("/api/cli/projects/create").map((call) => call.body.project)).toEqual([
      "acme/alpha",
      "acme/beta",
      "acme/gamma",
    ]);
    expect(second.status).toBe("batch-incomplete");
    expect(second.value.counts).toMatchObject({ created: 2, unconfirmed: 1 });
    expect(second.value.nextSteps.join(" ")).toContain("check ['acme/alpha'] in the console");
  });

  it("stops after two requests in a row with no answer, marking the rest never sent", async () => {
    const h = harness({ token: [grant(SLUGS)], create: () => "network-error" });
    const first = await run({ projects: THREE, deviceCode: "dev-code" });
    expect(first.status).toBe("creating");
    const second = await run({ projects: THREE, deviceCode: "dev-code" });

    expect(h.to("/api/cli/projects/create")).toHaveLength(2);
    expect(second.value.results.map((row: any) => row.status)).toEqual([
      "unconfirmed",
      "unconfirmed",
      "not-attempted",
    ]);
    expect(second.value.results[2].code).toBe("PLATFORM_UNREACHABLE");
  });
});

describe("extension_project_create with projects: the grant and the list", () => {
  it.each([
    ["a longer list", grant([...SLUGS, "delta"])],
    ["a shorter list", grant(["alpha", "beta"])],
    ["a different name", grant(["alpha", "beta", "omega"])],
    ["another workspace", grant(SLUGS, { workspaceSlug: "globex" })],
    ["a single-project grant", { status: 200, body: { token: GRANT, expiresAt: 1, workspaceSlug: "acme", projectSlug: "alpha", tokenKind: "provisioning" } }],
    ["a login token instead of a grant", { status: 200, body: { token: "login-token", expiresAt: 1, workspaceSlug: "acme", projectSlugs: SLUGS } }],
  ] as Array<[string, Route]>)("discards a grant for %s and creates nothing", async (_label, route) => {
    const h = harness({ token: [route] });
    const out = await run({ projects: THREE, deviceCode: "dev-code" });

    expect(out.ok).toBe(false);
    expect(out.error.name).toBe("CreateScopeError");
    expect(h.to("/api/cli/projects/create")).toHaveLength(0);
    expect(listCredentials()).toHaveLength(0);
  });

  it("continues across calls from memory, with no second approval and no second poll", async () => {
    const h = harness({ token: [grant(SLUGS)], createTakesMs: 21_000 });
    const first = await run({ projects: THREE, deviceCode: "dev-code" });

    expect(first.ok).toBe(true);
    expect(first.status).toBe("creating");
    expect(first.value.deviceCode).toBe("dev-code");
    expect(first.value.remaining).toEqual(["acme/beta", "acme/gamma"]);
    expect(first.value.results.map((row: any) => row.status)).toEqual([
      "created",
      "pending",
      "pending",
    ]);
    expect(first.hint).toContain("same deviceCode");
    expect(readCredentials({ project: "acme/alpha" })?.token).toBe(
      "seven-day-token-for-alpha",
    );

    const second = await run({ projects: THREE, deviceCode: "dev-code" });
    expect(second.status).toBe("creating");
    const third = await run({ projects: THREE, deviceCode: "dev-code" });

    expect(third.status).toBe("created");
    expect(third.value.counts).toMatchObject({ created: 3, loggedIn: 3 });
    expect(h.to("/api/cli/device/token")).toHaveLength(1);
    expect(h.to("/api/cli/device/code")).toHaveLength(0);
    expect(h.to("/api/cli/login/config")).toHaveLength(1);
    expect(h.to("/api/cli/projects/create")).toHaveLength(3);
  });

  it("fits several fast creates into one call", async () => {
    const h = harness({ token: [grant(SLUGS)], createTakesMs: 4_000 });
    const out = await run({ projects: THREE, deviceCode: "dev-code" });

    expect(out.status).toBe("created");
    expect(h.to("/api/cli/projects/create")).toHaveLength(3);
  });

  it("refuses to continue an approval with a different list", async () => {
    const h = harness({ token: [grant(SLUGS)], createTakesMs: 21_000 });
    await run({ projects: THREE, deviceCode: "dev-code" });
    const out = await run({
      projects: [...THREE.slice(0, 2), { project: "acme/omega", repo: "octo/omega" }],
      deviceCode: "dev-code",
    });

    expect(out.status).toBe("bad-request");
    expect(out.error.message).toContain("belongs to an approval for");
    expect(h.to("/api/cli/projects/create")).toHaveLength(1);
  });

  it("stops creating when the grant has run out, without asking the platform", async () => {
    const h = harness({ token: [grant(SLUGS)], createTakesMs: 21_000 });
    await run({ projects: THREE, deviceCode: "dev-code" });
    clock += 15 * 60 * 1000;
    const out = await run({ projects: THREE, deviceCode: "dev-code" });

    expect(h.to("/api/cli/projects/create")).toHaveLength(1);
    expect(out.status).toBe("batch-incomplete");
    expect(out.value.results).toMatchObject([
      { project: "acme/alpha", status: "created", loggedIn: true },
      { project: "acme/beta", status: "not-attempted", code: "TOKEN_EXPIRED" },
      { project: "acme/gamma", status: "not-attempted", code: "TOKEN_EXPIRED" },
    ]);
  });

  it("says what a restarted server lost instead of pretending nothing happened", async () => {
    const h = harness({
      token: [grant(SLUGS), { status: 400, body: { error: "expired_token" } }],
      createTakesMs: 21_000,
    });
    await run({ projects: THREE, deviceCode: "dev-code" });
    resetBatchCreateSessions();
    const out = await run({ projects: THREE, deviceCode: "dev-code" });

    expect(out.ok).toBe(false);
    expect(out.status).toBe("create-expired");
    expect(out.error.message).toContain("the projects it created still exist");
    expect(out.hint).toContain("extension_auth (action: login, projects)");
    expect(h.to("/api/cli/projects/create")).toHaveLength(1);
  });

  it("maps a denied approval, and a lane closed at the poll, by the platform's code", async () => {
    harness({ token: [{ status: 400, body: { error: "access_denied", message: "The authorization was denied." } }] });
    const denied = await run({ projects: THREE, deviceCode: "dev-code" });
    expect(denied.status).toBe("create-denied");

    harness({
      token: [{ status: 403, body: { error: "access_denied", message: "closed", code: "CLI_PROJECT_CREATE_DISABLED" } }],
    });
    const closed = await run({ projects: THREE, deviceCode: "dev-code" });
    expect(closed.status).toBe("lane-closed");
  });

  it("answers lane-closed when the device code is refused for a closed lane", async () => {
    harness({
      code: { status: 403, body: { error: "access_denied", message: "not open", code: "CLI_PROJECT_CREATE_DISABLED" } },
    });
    const out = await run({ projects: THREE });

    expect(out.status).toBe("lane-closed");
    expect(out.error.message).toBe("not open");
  });

  it("says a platform that refuses the list form may predate it", async () => {
    harness({
      code: { status: 400, body: { message: "Field 'project' must be in the form '<workspace>/<project>'." } },
    });
    const out = await run({ projects: THREE });

    expect(out.status).toBe("create-failed");
    expect(out.hint).toContain("one extension_project_create call each");
  });

  it("carries the platform's own refusal of a list over its cap, should the two ever disagree", async () => {
    harness({
      batchOnboarding: { createProjectsPerApproval: 20, loginProjectsPerApproval: 20 },
      code: {
        status: 400,
        body: {
          message: "A create list names at most 10 projects per approval.",
          code: "CREATE_BATCH_TOO_LONG",
          maxProjects: 10,
        },
      },
    });
    const out = await run({
      projects: Array.from({ length: 11 }, (_, i) => ({
        project: `acme/app-${i + 1}`,
        repo: `octo/app-${i + 1}`,
      })),
    });

    expect(out.ok).toBe(false);
    expect(out.status).toBe("create-failed");
    expect(out.error.message).toContain("at most 10 projects per approval");
  });

  it("leaves the single-project call exactly as it was", async () => {
    const h = harness({
      token: [
        {
          status: 200,
          body: {
            token: "single-grant",
            expiresAt: 1,
            ttlSeconds: 900,
            workspaceSlug: "acme",
            projectSlug: "ghost-app",
            tokenKind: "provisioning",
          },
        },
      ],
      create: () => ({
        status: 200,
        body: { success: true, projectId: "prj_1", projectSlug: "ghost-app", workspaceSlug: "acme" },
      }),
    });
    const out = await run({
      project: "acme/ghost-app",
      repo: "octo/ghost-src",
      deviceCode: "dev-code",
    });

    expect(out.status).toBe("created");
    expect(h.to("/api/cli/device/token")[0]?.body).toEqual({
      device_code: "dev-code",
      project: "acme/ghost-app",
    });
    expect("project" in h.to("/api/cli/projects/create")[0]!.body).toBe(false);
    expect(listCredentials()).toHaveLength(0);
    expect(out.value.nextSteps[0]).toContain("extension_auth (action: login");
  });
});

describe("extension_project_create with projects: a first build is counted, never assumed", () => {
  it("says each first build was dispatched when every answer says so", async () => {
    harness({ token: [grant(SLUGS)] });
    const out = await run({ projects: THREE, deviceCode: "dev-code" });

    expect(out.status).toBe("created");
    expect(out.hint).toContain("each first build was dispatched");
    expect(out.value.allowance.spent).toContain("including each first build");
    expect(out.warnings ?? []).toEqual([]);
  });

  it("names the project the platform created without a build, with its reason", async () => {
    harness({
      token: [grant(SLUGS)],
      create: (_ref, slug) =>
        slug === "beta"
          ? created(slug, {
              initialBuild: { dispatched: false, reason: "allowance_exhausted" },
            })
          : created(slug),
    });
    const out = await run({ projects: THREE, deviceCode: "dev-code" });

    expect(out.ok).toBe(true);
    expect(out.status).toBe("created");
    expect(out.value.results[1].firstBuild).toEqual({
      dispatched: false,
      reason: "allowance_exhausted",
    });
    expect(out.hint).not.toContain("each first build was dispatched");
    expect(out.hint).toContain("2 of 3 first builds were dispatched");
    expect(out.value.allowance.spent).toContain("the 2 first builds");
    expect(out.warnings.join(" ")).toContain("acme/beta");
    expect(out.warnings.join(" ")).toContain("used its build allowance");
  });

  it("does not round an answer that says nothing about the build up to dispatched", async () => {
    harness({
      token: [grant(SLUGS)],
      create: (_ref, slug) =>
        slug === "gamma" ? created(slug, { initialBuild: undefined }) : created(slug),
    });
    const out = await run({ projects: THREE, deviceCode: "dev-code" });

    expect(out.value.results[2].firstBuild).toEqual({ dispatched: null });
    expect(out.hint).toContain("2 of 3 first builds were dispatched");
    expect(out.warnings.join(" ")).toContain("acme/gamma (the platform did not say)");
  });
});
