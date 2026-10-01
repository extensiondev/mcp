import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { handler, schema } from "../tools/workspace-create";
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

function createFetch(routes: { code?: Route; token: Route[]; create?: Route }) {
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
          user_code: "WXYZ-7890",
          verification_uri: "https://extension.dev/device",
          verification_uri_complete:
            "https://extension.dev/device?code=WXYZ-7890",
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
    if (href.endsWith("/api/cli/workspaces/create")) {
      const route = routes.create ?? { status: 500, body: { message: "no" } };
      return jsonResponse(route.body, route.status);
    }
    throw new Error(`Unexpected fetch: ${href}`);
  });
  return { fn, calls };
}

const grantBody = {
  token: "workspace-grant",
  expiresAt: FUTURE,
  ttlSeconds: 900,
  workspaceSlug: "new-org",
  ownerGithubLogin: "octocat",
  tokenKind: "workspace-provisioning",
};

const created = {
  status: 201,
  body: {
    id: "ws_new",
    slug: "new-org",
    displayName: "New Org",
    ownerGithubLogin: "octocat",
    createdAt: "2026-10-01T00:00:00.000Z",
  },
};

let tmp: string;
let prevXdg: string | undefined;
let prevApi: string | undefined;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "extdev-wscreate-"));
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

describe("extension_workspace_create", () => {
  it("declares itself for the moment before extension_project_create", () => {
    expect(schema.name).toBe("extension_workspace_create");
    expect(schema.description).toContain("before extension_project_create");
    expect(schema.description).toContain("becomes its owner");
    expect(schema.inputSchema.required).toEqual(["workspace"]);
  });

  it("refuses a project-shaped or malformed slug before any network call", async () => {
    const { fn } = createFetch({ token: [] });
    vi.stubGlobal("fetch", fn);
    for (const workspace of ["acme/widget", "", "-lead", "has space"]) {
      const out = JSON.parse(await handler({ workspace }));
      expect(out.ok).toBe(false);
      expect(out.error.code).toBe("E_BAD_REQUEST");
    }
    expect(fn).not.toHaveBeenCalled();
  });

  it("starts the device flow with the create-workspace intent and a workspace, no project", async () => {
    const { fn, calls } = createFetch({ token: [] });
    vi.stubGlobal("fetch", fn);
    const out = JSON.parse(await handler({ workspace: "New-Org" }));
    expect(out.ok).toBe(false);
    expect(out.status).toBe("authorization-pending");
    expect(out.value.deviceCode).toBe("dev-code");
    expect(out.hint).toContain("becomes the workspace owner");

    const start = calls.find((c) => c.url.endsWith("/api/cli/device/code"));
    const body = JSON.parse(String(start?.init?.body));
    expect(body).toEqual({
      workspace: "new-org",
      clientName: "extension-mcp",
      intent: "create-workspace",
    });
    expect(body.project).toBeUndefined();

    const poll = calls.find((c) => c.url.endsWith("/api/cli/device/token"));
    expect(JSON.parse(String(poll?.init?.body))).toEqual({
      device_code: "dev-code",
      workspace: "new-org",
    });
  });

  it("creates the workspace with the grant, names the owner and stores nothing", async () => {
    const { fn, calls } = createFetch({
      token: [{ status: 200, body: grantBody }],
      create: created,
    });
    vi.stubGlobal("fetch", fn);
    const out = JSON.parse(
      await handler({
        workspace: "new-org",
        displayName: "New Org",
        deviceCode: "dev-code",
      }),
    );
    expect(out.ok).toBe(true);
    expect(out.status).toBe("created");
    expect(out.value.workspaceSlug).toBe("new-org");
    expect(out.value.ownerGithubLogin).toBe("octocat");
    expect(out.hint).toContain("owned by octocat");
    expect(out.value.nextSteps[0]).toContain("extension_project_create");

    const create = calls.find((c) => c.url.endsWith("/api/cli/workspaces/create"));
    expect((create?.init?.headers as Record<string, string>).authorization).toBe(
      "Bearer workspace-grant",
    );
    const body = JSON.parse(String(create?.init?.body));
    expect(body.displayName).toBe("New Org");
    expect(body.slug).toBeUndefined();
    expect(readCredentials()).toBeNull();
  });

  it("refuses to spend a grant scoped to another workspace", async () => {
    const { fn, calls } = createFetch({
      token: [{ status: 200, body: { ...grantBody, workspaceSlug: "other" } }],
      create: created,
    });
    vi.stubGlobal("fetch", fn);
    const out = JSON.parse(
      await handler({ workspace: "new-org", deviceCode: "dev-code" }),
    );
    expect(out.ok).toBe(false);
    expect(out.error.name).toBe("CreateScopeError");
    expect(calls.some((c) => c.url.endsWith("/api/cli/workspaces/create"))).toBe(
      false,
    );
  });

  it("reads a non-workspace grant as the workspace already existing", async () => {
    const { fn } = createFetch({
      token: [{ status: 200, body: { ...grantBody, tokenKind: "provisioning" } }],
    });
    vi.stubGlobal("fetch", fn);
    const out = JSON.parse(
      await handler({ workspace: "new-org", deviceCode: "dev-code" }),
    );
    expect(out.ok).toBe(false);
    expect(out.status).toBe("workspace-exists");
  });

  it("relays the platform hold as the held envelope", async () => {
    const { fn } = createFetch({
      token: [{ status: 200, body: grantBody }],
      create: {
        status: 403,
        body: {
          message: "extension.dev is not open to the public yet. This action is not available yet.",
          code: "PLATFORM_NOT_OPEN",
        },
      },
    });
    vi.stubGlobal("fetch", fn);
    const out = JSON.parse(
      await handler({ workspace: "new-org", deviceCode: "dev-code" }),
    );
    expect(out.ok).toBe(false);
    expect(out.status).toBe("platform-held");
    expect(out.error.platformCode).toBe("PLATFORM_NOT_OPEN");
  });

  it("names the closed lane when the device code is refused", async () => {
    const { fn } = createFetch({
      code: {
        status: 403,
        body: {
          error: "access_denied",
          message: "Headless workspace creation is not open on this host yet. Create the workspace in the console instead.",
          code: "CLI_WORKSPACE_CREATE_DISABLED",
        },
      },
      token: [],
    });
    vi.stubGlobal("fetch", fn);
    const out = JSON.parse(await handler({ workspace: "new-org" }));
    expect(out.ok).toBe(false);
    expect(out.status).toBe("lane-closed");
    expect(out.error.message).toContain("Headless workspace creation");
  });
});
