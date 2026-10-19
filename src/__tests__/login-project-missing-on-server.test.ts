import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { writeCredentials } from "../lib/credentials";
import { loginToProject } from "../tools/login";

const LOCAL = "http://localhost:3100";
const PROD = "https://www.extension.dev";
const PROJECT = "cezaraugusto/pii-shield";
const ENV_KEYS = ["XDG_CONFIG_HOME", "EXTENSION_DEV_API_URL", "EXTENSION_DEV_TOKEN", "EXTENSION_DEV_PROJECT"];
const saved: Record<string, string | undefined> = {};
let tmp: string;

type Route = { status: number; body: unknown };

function platform(routes: { resolve?: Route; token: Route }) {
  const calls: string[] = [];
  const fn = vi.fn(async (url: unknown) => {
    const href = String(url);
    calls.push(href);
    const reply = (route: Route) => new Response(JSON.stringify(route.body), { status: route.status });

    if (href.endsWith("/api/cli/login/config")) {
      return reply({
        status: 200,
        body: {
          deviceCodeUrl: "/api/cli/device/code",
          deviceTokenUrl: "/api/cli/device/token",
          verificationUri: `${PROD}/device`,
        },
      });
    }

    if (href.includes("/api/projects/resolve?")) {
      return reply(routes.resolve ?? { status: 404, body: { code: "NO_PUBLIC_PROJECT" } });
    }

    if (href.endsWith("/api/cli/device/code")) {
      return reply({
        status: 200,
        body: {
          device_code: "dev-code",
          user_code: "BR11-KXYA",
          verification_uri: `${PROD}/device`,
          verification_uri_complete: `${PROD}/device?code=BR11-KXYA`,
          interval: 30,
          expires_in: 900,
        },
      });
    }

    if (href.endsWith("/api/cli/device/token")) return reply(routes.token);

    throw new Error(`Unexpected fetch: ${href}`);
  });

  vi.stubGlobal("fetch", fn);

  return calls;
}

const PENDING: Route = { status: 400, body: { error: "authorization_pending" } };

beforeEach(() => {
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "extdev-login-missing-"));
  process.env.XDG_CONFIG_HOME = tmp;
  delete process.env.EXTENSION_DEV_API_URL;
  delete process.env.EXTENSION_DEV_TOKEN;
  delete process.env.EXTENSION_DEV_PROJECT;
});

afterEach(() => {
  vi.unstubAllGlobals();

  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("extension_auth login for a project the target server may not hold", () => {
  it("warns before the approval when the project is not public there and names the other server's login", async () => {
    writeCredentials({
      version: 1,
      token: "local-token",
      workspaceSlug: "cezaraugusto",
      projectSlug: "pii-shield",
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      api: LOCAL,
      provider: "extensiondev",
    });

    const calls = platform({ token: PENDING });

    const out = JSON.parse(await loginToProject({ project: PROJECT, api: PROD }));

    expect(calls.some((href) => href.startsWith(`${PROD}/api/projects/resolve?workspace=cezaraugusto&projectSlug=pii-shield`))).toBe(true);
    expect(out.status).toBe("authorization-pending");
    expect(out.value.projectCheck).toEqual({
      server: PROD,
      publicProject: false,
      loginsForThisSlugElsewhere: [LOCAL],
    });

    expect(out.warnings[0]).toContain(`not a public project on ${PROD}`);
    expect(out.warnings[0]).toContain(`login for ${PROJECT} on ${LOCAL}`);
    expect(out.warnings[0]).toContain(`extension_project_create with api: '${PROD}'`);
  });

  it("adds nothing when the project is public on the target server", async () => {
    platform({ resolve: { status: 200, body: { projectId: "prj_1", access: "public" } }, token: PENDING });

    const out = JSON.parse(await loginToProject({ project: PROJECT, api: PROD }));

    expect(out.status).toBe("authorization-pending");
    expect(out.value.projectCheck).toBeUndefined();
    expect(out.warnings).toHaveLength(1);
  });

  it("answers the refusal on resume when the approver canceled a code for a missing project", async () => {
    platform({
      token: {
        status: 404,
        body: {
          error: "access_denied",
          code: "PROJECT_NOT_FOUND",
          refusedAt: "approval",
          authorizationValid: false,
          message: "Project 'cezaraugusto/pii-shield' was not found, so this device authorization was closed.",
        },
      },
    });

    const out = JSON.parse(await loginToProject({ project: PROJECT, api: PROD, deviceCode: "dev-code" }));

    expect(out.ok).toBe(false);
    expect(out.status).toBe("approval-refused");
    expect(out.error.code).toBe("E_AUTH_DENIED");
    expect(out.error.message).toContain("was not found");
    expect(out.value).toMatchObject({ server: PROD, platformCode: "PROJECT_NOT_FOUND", reason: "project-not-found" });
    expect(out.hint).toContain(`extension_project_create with project: '${PROJECT}' and api: '${PROD}'`);
  });

  it("answers project-not-found when the mint refuses a project that is gone", async () => {
    platform({
      token: {
        status: 404,
        body: {
          code: "PROJECT_NOT_FOUND",
          authorizationValid: false,
          message: "Project 'cezaraugusto/pii-shield' was not found, so this device authorization was closed.",
        },
      },
    });

    const out = JSON.parse(await loginToProject({ project: PROJECT, api: PROD, deviceCode: "dev-code" }));

    expect(out.ok).toBe(false);
    expect(out.status).toBe("project-not-found");
    expect(out.value.server).toBe(PROD);
  });

  it("keeps a plain denial as login-denied", async () => {
    platform({ token: { status: 400, body: { error: "access_denied", message: "The authorization was denied." } } });

    const out = JSON.parse(await loginToProject({ project: PROJECT, api: PROD, deviceCode: "dev-code" }));

    expect(out.status).toBe("login-denied");
    expect(out.error.message).toContain("The authorization was denied.");
  });
});
