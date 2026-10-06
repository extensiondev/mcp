import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { handler, schema } from "../tools/project-create";
import { readCredentials } from "../lib/credentials";

const API = "https://api.test";
const FUTURE = Math.floor(Date.now() / 1000) + 900;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(
    typeof body === "string" ? body : JSON.stringify(body),
    { status },
  );
}

type Route = { status: number; body: unknown };

function createFetch(routes: {
  code?: Route;
  token: Route[];
  create?: Route;
}) {
  let tokenCalls = 0;
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fn = vi.fn(async (url: any, init?: RequestInit) => {
    const href = String(url);
    calls.push({ url: href, init });
    if (href.endsWith("/api/cli/login/config")) {
      return jsonResponse({
        deviceCodeUrl: "/api/cli/device/code",
        deviceTokenUrl: "/api/cli/device/token",
        verificationUri: "https://extension.dev/device",
      });
    }
    if (href.endsWith("/api/cli/device/code")) {
      const route = routes.code ?? {
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
      const next =
        routes.token[Math.min(tokenCalls, routes.token.length - 1)] ?? {
          status: 400,
          body: { error: "authorization_pending" },
        };
      tokenCalls += 1;
      return jsonResponse(next.body, next.status);
    }
    if (href.endsWith("/api/cli/projects/create")) {
      const route = routes.create ?? { status: 500, body: { message: "no" } };
      return jsonResponse(route.body, route.status);
    }
    throw new Error(`Unexpected fetch: ${href}`);
  });
  return { fn, calls };
}

const grantBody = {
  token: "provision-token",
  expiresAt: FUTURE,
  ttlSeconds: 900,
  workspaceSlug: "acme",
  projectSlug: "ghost-app",
  tokenKind: "provisioning",
};

const baseArgs = {
  project: "acme/ghost-app",
  repo: "acme/ghost-app-src",
};

let tmp: string;
let prevXdg: string | undefined;
let prevApi: string | undefined;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "extdev-projcreate-"));
  prevXdg = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = tmp;
  prevApi = process.env.EXTENSION_DEV_API_URL;
  process.env.EXTENSION_DEV_API_URL = API;
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = prevXdg;
  if (prevApi === undefined) delete process.env.EXTENSION_DEV_API_URL;
  else process.env.EXTENSION_DEV_API_URL = prevApi;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("extension_project_create", () => {
  it("declares itself for the moment before extension_auth", () => {
    expect(schema.name).toBe("extension_project_create");
    expect(schema.description).toContain("BEFORE extension_auth");
    expect(schema.description).toContain("extension_build");
    expect(schema.inputSchema.required).toEqual([]);
  });

  it("still refuses a single call that names no project or no repo", async () => {
    const { fn } = createFetch({ token: [] });
    vi.stubGlobal("fetch", fn);
    for (const args of [{}, { project: "acme/ghost-app" }, { repo: "acme/src" }]) {
      const out = JSON.parse(await handler(args as never));
      expect(out.ok).toBe(false);
      expect(out.error.code).toBe("E_BAD_REQUEST");
    }
    expect(fn).not.toHaveBeenCalled();
  });

  it("asks for no installation id, because the platform resolves it", () => {
    expect(schema.inputSchema.required).not.toContain("installationId");
    expect(schema.inputSchema.properties.installationId.description).toContain(
      "Optional override",
    );
    expect(schema.description).toContain("connect link");
  });

  it("refuses a malformed project before any network call", async () => {
    const { fn } = createFetch({ token: [] });
    vi.stubGlobal("fetch", fn);
    const out = JSON.parse(
      await handler({ ...baseArgs, project: "no-slash" }),
    );
    expect(out.ok).toBe(false);
    expect(out.error.code).toBe("E_BAD_REQUEST");
    expect(fn).not.toHaveBeenCalled();
  });

  it("refuses to send the grant to a hostile api argument", async () => {
    const { fn } = createFetch({ token: [] });
    vi.stubGlobal("fetch", fn);
    const out = JSON.parse(
      await handler({ ...baseArgs, api: "https://evil.example" }),
    );
    expect(out.ok).toBe(false);
    expect(out.error.message).toContain("Refusing to send the access token");
    expect(fn).not.toHaveBeenCalled();
  });

  it("returns the device code and approval link when authorization is pending", async () => {
    const { fn } = createFetch({
      token: [{ status: 400, body: { error: "authorization_pending" } }],
    });
    vi.stubGlobal("fetch", fn);
    const out = JSON.parse(await handler(baseArgs));
    expect(out.ok).toBe(true);
    expect(out.status).toBe("authorization-pending");
    expect(out.error).toBeNull();
    expect(out.value.deviceCode).toBe("dev-code");
    expect(out.value.verificationUriComplete).toContain("ABCD-1234");
  });

  it("relays the server's closed-lane message verbatim", async () => {
    const serverSentence =
      "extension.dev is not open to the public yet. Project creation will be available when the platform opens.";
    const { fn } = createFetch({
      code: {
        status: 403,
        body: {
          error: "access_denied",
          message: serverSentence,
          code: "CLI_PROJECT_CREATE_DISABLED",
        },
      },
      token: [],
    });
    vi.stubGlobal("fetch", fn);
    const out = JSON.parse(await handler(baseArgs));
    expect(out.ok).toBe(false);
    expect(out.status).toBe("lane-closed");
    expect(out.error.message).toBe(serverSentence);
    expect(out.error.message.toLowerCase()).not.toContain("console");
    expect(out.hint).toContain("Create the project in the console");
    expect(out.hint).toContain("extension_auth");
    expect(out.hint).toContain("its own message above says which case this is");
    expect(out.hint).toContain("console answers its gate page");
    expect(out.hint).not.toContain("every workspace");
  });

  it("falls back to the console pointer only when the server sends no message", async () => {
    const { fn } = createFetch({
      code: {
        status: 403,
        body: {
          error: "access_denied",
          code: "CLI_PROJECT_CREATE_DISABLED",
        },
      },
      token: [],
    });
    vi.stubGlobal("fetch", fn);
    const out = JSON.parse(await handler(baseArgs));
    expect(out.ok).toBe(false);
    expect(out.status).toBe("lane-closed");
    expect(out.error.message).toContain(
      "Create the project in the console instead",
    );
  });

  it("creates the project with the provisioning grant and stores nothing locally", async () => {
    const { fn, calls } = createFetch({
      token: [{ status: 200, body: grantBody }],
      create: {
        status: 200,
        body: {
          success: true,
          message: "Repository created successfully",
          projectId: "prj_new",
          projectSlug: "ghost-app",
          workspaceSlug: "acme",
          idempotencyKey: "idem-1",
          initialBuild: { dispatched: true },
        },
      },
    });
    vi.stubGlobal("fetch", fn);
    const out = JSON.parse(
      await handler({ ...baseArgs, deviceCode: "dev-code" }),
    );
    expect(out.ok).toBe(true);
    expect(out.status).toBe("created");
    expect(out.value.projectId).toBe("prj_new");
    expect(out.value.firstBuild).toEqual({ dispatched: true });
    expect(out.hint).toContain("Its first build was dispatched.");
    expect(out.value.allowance.spent).toContain("including its first build");
    expect(out.warnings ?? []).toEqual([]);
    expect(out.value.nextSteps[0]).toContain("extension_auth");

    const createCall = calls.find((c) =>
      c.url.endsWith("/api/cli/projects/create"),
    );
    expect(createCall).toBeDefined();
    const headers = (createCall!.init?.headers ?? {}) as Record<string, string>;
    expect(headers.authorization).toBe("Bearer provision-token");
    const body = JSON.parse(String(createCall!.init?.body));
    expect(body.github).toMatchObject({
      owner: "acme",
      repo: "ghost-app-src",
    });
    expect(body.github.installationId).toBeUndefined();
    expect(body.origin).toBeUndefined();
    expect(body.createdFrom).toEqual({
      kind: "repository",
      ref: "acme/ghost-app-src",
    });

    expect(readCredentials()).toBeNull();
  });

  async function createBodyFor(extra: Record<string, unknown>) {
    const { fn, calls } = createFetch({
      token: [{ status: 200, body: grantBody }],
      create: {
        status: 200,
        body: {
          success: true,
          projectId: "prj_new",
          projectSlug: "ghost-app",
          workspaceSlug: "acme",
        },
      },
    });
    vi.stubGlobal("fetch", fn);
    await handler({ ...baseArgs, deviceCode: "dev-code", ...extra });
    const createCall = calls.find((c) =>
      c.url.endsWith("/api/cli/projects/create"),
    );

    return JSON.parse(String(createCall!.init?.body));
  }

  it("keeps the Chrome-only default when no browsers are named", async () => {
    const body = await createBodyFor({});
    expect(body.build.chrome).toMatchObject({
      enabled: true,
      outputDirectory: "dist/chrome",
    });
    expect(body.build.edge.enabled).toBe(false);
    expect(body.build.firefox.enabled).toBe(false);
  });

  it("enables every named browser with its own Extension.js output", async () => {
    const body = await createBodyFor({
      browsers: ["chrome", "edge", "firefox"],
      installCommand: "pnpm install",
      buildCommand: "pnpm build",
    });
    for (const name of ["chrome", "edge", "firefox"]) {
      expect(body.build[name]).toEqual({
        enabled: true,
        installCommand: "pnpm install",
        buildCommand: "pnpm build",
        outputDirectory: `dist/${name}`,
      });
    }
  });

  it("fills a <browser> placeholder and lets a per-browser override win", async () => {
    const body = await createBodyFor({
      browsers: ["chrome", "edge", "firefox"],
      outputDirectory: "packages/ext/dist/<browser>",
      outputDirectories: { edge: "build/manifestv3" },
    });
    expect(body.build.chrome.outputDirectory).toBe("packages/ext/dist/chrome");
    expect(body.build.edge.outputDirectory).toBe("build/manifestv3");
    expect(body.build.firefox.outputDirectory).toBe(
      "packages/ext/dist/firefox",
    );
  });

  it("sends intent create when starting the device flow", async () => {
    const { fn, calls } = createFetch({
      token: [{ status: 400, body: { error: "authorization_pending" } }],
    });
    vi.stubGlobal("fetch", fn);
    await handler(baseArgs);
    const codeCall = calls.find((c) => c.url.endsWith("/api/cli/device/code"));
    expect(codeCall).toBeDefined();
    expect(JSON.parse(String(codeCall!.init?.body)).intent).toBe("create");
  });

  it("keeps the login the platform minted when the project already exists, so no second approval is asked", async () => {
    const { fn } = createFetch({
      token: [
        {
          status: 200,
          body: { ...grantBody, token: "login-token", tokenKind: undefined },
        },
      ],
    });
    vi.stubGlobal("fetch", fn);
    const out = JSON.parse(
      await handler({ ...baseArgs, deviceCode: "dev-code" }),
    );
    expect(out.ok).toBe(true);
    expect(out.status).toBe("project-exists-logged-in");
    expect(out.value).toMatchObject({ workspaceSlug: "acme", projectSlug: "ghost-app", stored: true });
    expect(out.hint).toMatch(/no second approval is needed/);
    const { readCredentials } = await import("../lib/credentials");
    expect(readCredentials({ project: "acme/ghost-app" })?.token).toBe("login-token");
  });

  it("answers lane-closed with the platform's code when the lane shut between approval and poll", async () => {
    const { fn } = createFetch({
      token: [
        {
          status: 403,
          body: { error: "access_denied", code: "CLI_PROJECT_CREATE_DISABLED", message: "Headless project creation is closed on this host." },
        },
      ],
    });
    vi.stubGlobal("fetch", fn);
    const out = JSON.parse(await handler({ ...baseArgs, deviceCode: "dev-code" }));
    expect(out.status).toBe("lane-closed");
    expect(out.error.message).toMatch(/closed on this host/);
    expect(out.hint).not.toMatch(/this workspace is not on it/);
  });

  it("relays the platform's own sentence for an unknown or redeemed device code", async () => {
    const { fn } = createFetch({
      token: [
        {
          status: 400,
          body: { error: "expired_token", error_description: "This device code was already redeemed. Start the flow again." },
        },
      ],
    });
    vi.stubGlobal("fetch", fn);
    const out = JSON.parse(await handler({ ...baseArgs, deviceCode: "dev-code" }));
    expect(out.status).toBe("create-expired");
    expect(out.error.message).toMatch(/already redeemed/);
  });

  it("refuses a grant scoped to a different project and creates nothing", async () => {
    const { fn, calls } = createFetch({
      token: [
        {
          status: 200,
          body: { ...grantBody, projectSlug: "other-app" },
        },
      ],
    });
    vi.stubGlobal("fetch", fn);
    const out = JSON.parse(
      await handler({ ...baseArgs, deviceCode: "dev-code" }),
    );
    expect(out.ok).toBe(false);
    expect(out.error.message).toContain("Nothing was created");
    expect(
      calls.some((c) => c.url.endsWith("/api/cli/projects/create")),
    ).toBe(false);
  });

  it("surfaces a denial from the device page", async () => {
    const { fn } = createFetch({
      token: [{ status: 400, body: { error: "access_denied" } }],
    });
    vi.stubGlobal("fetch", fn);
    const out = JSON.parse(
      await handler({ ...baseArgs, deviceCode: "dev-code" }),
    );
    expect(out.ok).toBe(false);
    expect(out.status).toBe("create-denied");
    expect(out.error.code).toBe("E_AUTH_DENIED");
  });

  it("carries an explicit installationId through when an operator names one", async () => {
    const { fn, calls } = createFetch({
      token: [{ status: 200, body: grantBody }],
      create: {
        status: 200,
        body: { success: true, projectId: "prj_new" },
      },
    });
    vi.stubGlobal("fetch", fn);
    await handler({
      ...baseArgs,
      deviceCode: "dev-code",
      installationId: "99999999",
    });
    const createCall = calls.find((c) =>
      c.url.endsWith("/api/cli/projects/create"),
    );
    const body = JSON.parse(String(createCall!.init?.body));
    expect(body.github.installationId).toBe("99999999");
  });

  it("refuses a malformed installationId override without a network call", async () => {
    const { fn } = createFetch({ token: [] });
    vi.stubGlobal("fetch", fn);
    const out = JSON.parse(
      await handler({ ...baseArgs, installationId: "not-a-number" }),
    );
    expect(out.ok).toBe(false);
    expect(out.error.code).toBe("E_BAD_REQUEST");
    expect(fn).not.toHaveBeenCalled();
  });

  it("echoes the platform's connect link and never builds one", async () => {
    const { fn } = createFetch({
      token: [{ status: 200, body: grantBody }],
      create: {
        status: 403,
        body: {
          message: "The extension.dev GitHub App is not installed on octocat.",
          code: "INSTALLATION_ABSENT",
          connectUrl:
            "https://www.extension.dev/connect/github?next=project-create",
        },
      },
    });
    vi.stubGlobal("fetch", fn);
    const out = JSON.parse(
      await handler({ ...baseArgs, deviceCode: "dev-code" }),
    );
    expect(out.ok).toBe(false);
    expect(out.status).toBe("installation-required");
    expect(out.value.connectUrl).toBe(
      "https://www.extension.dev/connect/github?next=project-create",
    );
    expect(out.hint).toContain("Nothing was created");
  });

  it("says what to do when the platform sends no connect link", async () => {
    const { fn } = createFetch({
      token: [{ status: 200, body: grantBody }],
      create: {
        status: 409,
        body: {
          message: "octocat holds 2 installations.",
          code: "INSTALLATION_AMBIGUOUS",
        },
      },
    });
    vi.stubGlobal("fetch", fn);
    const out = JSON.parse(
      await handler({ ...baseArgs, deviceCode: "dev-code" }),
    );
    expect(out.ok).toBe(false);
    expect(out.status).toBe("installation-required");
    expect(out.value).toBeNull();
    expect(out.hint).toContain("Nothing was created");
  });

  it("surfaces a server refusal of the create call honestly", async () => {
    const { fn } = createFetch({
      token: [{ status: 200, body: grantBody }],
      create: {
        status: 403,
        body: {
          message: "That GitHub App installation is not on the account that approved this grant.",
          code: "INSTALLATION_NOT_HELD",
        },
      },
    });
    vi.stubGlobal("fetch", fn);
    const out = JSON.parse(
      await handler({ ...baseArgs, deviceCode: "dev-code" }),
    );
    expect(out.ok).toBe(false);
    expect(out.status).toBe("create-failed");
    expect(out.error.message).toContain("403");
    expect(out.error.message).toContain(
      "installation is not on the account that approved",
    );
  });

  async function createdWith(body: Record<string, unknown>) {
    const { fn } = createFetch({
      token: [{ status: 200, body: grantBody }],
      create: {
        status: 200,
        body: {
          success: true,
          message: "Repository created successfully",
          projectId: "prj_new",
          projectSlug: "ghost-app",
          workspaceSlug: "acme",
          idempotencyKey: "idem-1",
          ...body,
        },
      },
    });
    vi.stubGlobal("fetch", fn);

    return JSON.parse(await handler({ ...baseArgs, deviceCode: "dev-code" }));
  }

  it.each([
    ["allowance_exhausted", "used its build allowance"],
    ["no_commits", "no commits yet"],
    ["no_build_workflow", "no build workflow"],
    ["dispatch_paused", "paused on the platform"],
    ["dispatch_failed", "could not"],
  ])(
    "does not claim a first build the platform withheld (%s)",
    async (reason, words) => {
      const out = await createdWith({
        initialBuild: { dispatched: false, reason },
      });

      expect(out.ok).toBe(true);
      expect(out.status).toBe("created");
      expect(out.value.firstBuild).toEqual({ dispatched: false, reason });
      expect(out.hint).not.toContain("Its first build was dispatched");
      expect(out.hint).toContain("No first build was dispatched");
      expect(out.hint).toContain(words);
      expect(out.hint).toContain("/builds");
      expect(out.value.allowance.spent).not.toContain("including its first build");
      expect(out.warnings.join(" ")).toContain(words);
      expect(out.value.nextSteps.join(" ")).toContain("extension_release_status");
    },
  );

  it("relays a reason it has no sentence for instead of dropping it", async () => {
    const out = await createdWith({
      initialBuild: { dispatched: false, reason: "some_future_reason" },
    });

    expect(out.hint).toContain("some_future_reason");
  });

  it("claims no build when the answer does not say one was dispatched", async () => {
    const out = await createdWith({});

    expect(out.ok).toBe(true);
    expect(out.value.firstBuild).toEqual({ dispatched: null });
    expect(out.hint).not.toContain("Its first build was dispatched");
    expect(out.hint).toContain("did not say whether a first build was dispatched");
    expect(out.warnings.join(" ")).toContain("did not say");
  });

  it.each([[{ dispatched: "true" }], [{ dispatched: 1 }], ["yes"], [[true]]])(
    "takes only a literal true for dispatched (%j)",
    async (initialBuild) => {
      const out = await createdWith({ initialBuild });

      expect(out.value.firstBuild).toEqual({ dispatched: null });
      expect(out.hint).not.toContain("Its first build was dispatched");
    },
  );

  it("promises the firstBuild field in its description", () => {
    expect(schema.description).toContain("`firstBuild`");
    expect(schema.description).not.toContain("and dispatches the first build.");
  });

  async function createAnswers(create: Route | "no-answer") {
    const { fn } = createFetch({
      token: [{ status: 200, body: grantBody }],
      ...(create === "no-answer" ? {} : { create }),
    });
    const routed = vi.fn(async (url: any, init?: RequestInit) => {
      if (create === "no-answer" && String(url).endsWith("/api/cli/projects/create")) {
        throw new Error("socket hang up");
      }
      return fn(url, init);
    });
    vi.stubGlobal("fetch", routed);

    return JSON.parse(await handler({ ...baseArgs, deviceCode: "dev-code" }));
  }

  it.each([
    ["no answer at all", "no-answer" as const, "no answer came back"],
    ["a gateway timeout", { status: 504, body: "<html>504</html>" }, "in front of the platform"],
    ["a bare server error", { status: 500, body: { message: "no" } }, "no platform code"],
    ["an empty 200", { status: 200, body: "" }, "did not carry success: true"],
    ["an empty object", { status: 200, body: {} }, "did not carry success: true"],
    ["a page of html", { status: 200, body: "<html>ok</html>" }, "did not carry success: true"],
    ["success with no id", { status: 200, body: { success: true } }, "named no project id"],
    [
      "success with no names",
      { status: 200, body: { success: true, projectId: "prj_new" } },
      "did not name the workspace and project",
    ],
  ])("calls %s unconfirmed, never created and never failed", async (_label, create, words) => {
    const out = await createAnswers(create as Route | "no-answer");

    expect(out.ok).toBe(false);
    expect(out.status).toBe("create-unconfirmed");
    expect(out.error.message).toContain(words);
    expect(out.error.message).toContain("is unknown");
    expect(out.hint).toContain("Do not create it again blind");
    expect(out.hint).toContain("extension_auth (action: login, project: 'acme/ghost-app')");
  });

  it("keeps a failure the platform named a failure", async () => {
    const out = await createAnswers({
      status: 500,
      body: { message: "Project creation was rolled back.", code: "PROJECT_CREATE_ROLLED_BACK" },
    });

    expect(out.status).toBe("create-failed");
    expect(out.error.message).toContain("rolled back");
  });

  it("reports the names the platform registered, not the ones asked for", async () => {
    const out = await createdWith({
      projectSlug: "ghost-app-2",
      initialBuild: { dispatched: true },
    });

    expect(out.status).toBe("created");
    expect(out.value.projectSlug).toBe("ghost-app-2");
    expect(out.warnings.join(" ")).toContain("registered this project as acme/ghost-app-2");
    expect(out.value.nextSteps[0]).toContain("acme/ghost-app-2");
  });
});
