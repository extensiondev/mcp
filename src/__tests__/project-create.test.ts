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
    expect(schema.inputSchema.required).toEqual(["project", "repo"]);
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
    expect(out.ok).toBe(false);
    expect(out.status).toBe("authorization-pending");
    expect(out.value.deviceCode).toBe("dev-code");
    expect(out.value.verificationUriComplete).toContain("ABCD-1234");
  });

  it("surfaces a closed lane as a refusal that names the console", async () => {
    const { fn } = createFetch({
      code: {
        status: 403,
        body: {
          error: "access_denied",
          message: "Headless project creation is not open on this host yet.",
          code: "CLI_PROJECT_CREATE_DISABLED",
        },
      },
      token: [],
    });
    vi.stubGlobal("fetch", fn);
    const out = JSON.parse(await handler(baseArgs));
    expect(out.ok).toBe(false);
    expect(out.status).toBe("lane-closed");
  });

  it("creates the project with the provisioning grant and stores nothing locally", async () => {
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
    const out = JSON.parse(
      await handler({ ...baseArgs, deviceCode: "dev-code" }),
    );
    expect(out.ok).toBe(true);
    expect(out.status).toBe("created");
    expect(out.value.projectId).toBe("prj_new");
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

  it("redirects to extension_auth when the project already exists", async () => {
    const { fn } = createFetch({
      token: [
        {
          status: 200,
          body: { ...grantBody, tokenKind: undefined },
        },
      ],
    });
    vi.stubGlobal("fetch", fn);
    const out = JSON.parse(
      await handler({ ...baseArgs, deviceCode: "dev-code" }),
    );
    expect(out.ok).toBe(false);
    expect(out.status).toBe("project-exists");
    expect(out.hint).toContain("extension_auth");
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
});
