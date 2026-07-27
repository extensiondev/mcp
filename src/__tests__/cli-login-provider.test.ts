import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runCli } from "../index";
import { loginToProject } from "../tools/login";
import { pollDeviceToken } from "../lib/device-flow";
import { readCredentials } from "../lib/credentials";

const API = "https://api.test";
const FUTURE = Math.floor(Date.now() / 1000) + 3600;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(
    typeof body === "string" ? body : JSON.stringify(body),
    { status },
  );
}

function loginFetch(
  tokenResponses: Array<{ status: number; body: unknown }>,
) {
  let tokenCalls = 0;
  const fn = vi.fn(async (url: any) => {
    const href = String(url);
    if (href.endsWith("/api/cli/login/config")) {
      return jsonResponse({
        deviceCodeUrl: "/api/cli/device/code",
        deviceTokenUrl: "/api/cli/device/token",
        verificationUri: "https://extension.dev/device",
      });
    }
    if (href.endsWith("/api/cli/device/code")) {
      return jsonResponse({
        device_code: "dev-code",
        user_code: "ABCD-1234",
        verification_uri: "https://extension.dev/device",
        verification_uri_complete:
          "https://extension.dev/device?code=ABCD-1234",
        interval: 1,
        expires_in: 900,
      });
    }
    if (href.endsWith("/api/cli/device/token")) {
      const next =
        tokenResponses[Math.min(tokenCalls, tokenResponses.length - 1)];
      tokenCalls += 1;
      return jsonResponse(next.body, next.status);
    }
    throw new Error(`Unexpected fetch: ${href}`);
  });
  return { fn, tokenCalls: () => tokenCalls };
}

let tmp: string;
let prevXdg: string | undefined;
let prevApi: string | undefined;
let lines: string[];
let stderrSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "extdev-login-"));
  prevXdg = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = tmp;
  prevApi = process.env.EXTENSION_DEV_API_URL;
  process.env.EXTENSION_DEV_API_URL = API;
  lines = [];
  stderrSpy = vi
    .spyOn(process.stderr, "write")
    .mockImplementation(((chunk: any) => {
      lines.push(String(chunk));
      return true;
    }) as any);
});

afterEach(() => {
  stderrSpy.mockRestore();
  vi.unstubAllGlobals();
  if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = prevXdg;
  if (prevApi === undefined) delete process.env.EXTENSION_DEV_API_URL;
  else process.env.EXTENSION_DEV_API_URL = prevApi;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("extension-mcp login CLI", () => {
  it("prints the one-click link and logs in on approval", async () => {
    if (process.platform === "win32") return;
    const { fn } = loginFetch([
      {
        status: 200,
        body: {
          token: "tok",
          workspaceSlug: "acme",
          projectSlug: "widget",
          expiresAt: FUTURE,
        },
      },
    ]);
    vi.stubGlobal("fetch", fn);

    const code = await runCli("login", ["--project", "acme/widget"]);
    const out = lines.join("");

    expect(code).toBe(0);
    expect(out).toContain("https://extension.dev/device?code=ABCD-1234");
    expect(out).toContain("ABCD-1234");
    expect(out).toContain("Logged in to acme/widget.");
    expect(readCredentials()?.token).toBe("tok");
  });

  it("surfaces a denial instead of claiming a timeout", async () => {
    const { fn, tokenCalls } = loginFetch([
      { status: 400, body: { error: "access_denied" } },
    ]);
    vi.stubGlobal("fetch", fn);

    const code = await runCli("login", ["--project", "acme/widget"]);

    expect(code).toBe(1);
    expect(tokenCalls()).toBe(1);
    expect(lines.join("")).toContain("Authorization was denied");
    expect(lines.join("")).not.toContain("Timed out");
  });

  it("surfaces the server message on an immediate hard error", async () => {
    const { fn, tokenCalls } = loginFetch([
      {
        status: 400,
        body: { error: "invalid_grant", message: "Device code not recognized" },
      },
    ]);
    vi.stubGlobal("fetch", fn);

    const code = await runCli("login", ["--project", "acme/widget"]);

    expect(code).toBe(1);
    expect(tokenCalls()).toBe(1);
    expect(lines.join("")).toContain("Device code not recognized");
    expect(lines.join("")).not.toContain("Timed out");
  });

  it("says the device code expired when the server says so", async () => {
    const { fn } = loginFetch([
      { status: 400, body: { error: "expired_token" } },
    ]);
    vi.stubGlobal("fetch", fn);

    const code = await runCli("login", ["--project", "acme/widget"]);

    expect(code).toBe(1);
    expect(lines.join("")).toContain("The device code expired");
  });

  it("refuses a cleartext non-localhost api before any request", async () => {
    const { fn } = loginFetch([]);
    vi.stubGlobal("fetch", fn);

    const code = await runCli("login", [
      "--project",
      "acme/widget",
      "--api",
      "http://evil.test",
    ]);

    expect(code).toBe(1);
    expect(lines.join("")).toContain("Refusing");
    expect(fn).not.toHaveBeenCalled();
  });
});

describe("extension_auth login first call", () => {
  it("reports a hard error with the server message, not pending", async () => {
    const { fn } = loginFetch([
      {
        status: 400,
        body: { error: "invalid_grant", message: "Device code not recognized" },
      },
    ]);
    vi.stubGlobal("fetch", fn);

    const result = JSON.parse(await loginToProject({ project: "acme/widget" }));

    expect(result.ok).toBe(false);
    expect(result.status).toBe("login-failed");
    expect(result.error.message).toContain("Device code not recognized");
  });

  it("reports an expired device code, not pending", async () => {
    const { fn } = loginFetch([
      { status: 400, body: { error: "expired_token" } },
    ]);
    vi.stubGlobal("fetch", fn);

    const result = JSON.parse(await loginToProject({ project: "acme/widget" }));

    expect(result.ok).toBe(false);
    expect(result.status).toBe("login-expired");
  });

  it("refuses a cleartext non-localhost api before any request", async () => {
    const { fn } = loginFetch([]);
    vi.stubGlobal("fetch", fn);

    const result = JSON.parse(
      await loginToProject({ project: "acme/widget", api: "http://evil.test" }),
    );

    expect(result.ok).toBe(false);
    expect(result.status).toBe("login-failed");
    expect(result.error.message).toContain("Refusing");
    expect(fn).not.toHaveBeenCalled();
  });
});

describe("pollDeviceToken hard failures", () => {
  it("treats a non-OK response without an OAuth error as a hard error", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse("<html>Internal Server Error</html>", 500),
    );

    const result = await pollDeviceToken({
      apiBase: API,
      path: "/api/cli/device/token",
      project: "acme/widget",
      deviceCode: "dev-code",
      interval: 1,
      budgetMs: 1500,
      fetchImpl: fetchImpl as any,
    });

    expect(result).toMatchObject({ ok: false, reason: "error" });
    expect((result as { message: string }).message).toContain("500");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("rejects and does not persist a token scoped to another project", async () => {
    if (process.platform === "win32") return;
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        token: "tok",
        workspaceSlug: "someone",
        projectSlug: "else",
        expiresAt: FUTURE,
      }),
    );

    const result = await pollDeviceToken({
      apiBase: API,
      path: "/api/cli/device/token",
      project: "acme/widget",
      deviceCode: "dev-code",
      interval: 1,
      budgetMs: 1500,
      fetchImpl: fetchImpl as any,
    });

    expect(result).toMatchObject({ ok: false, reason: "error" });
    expect((result as { message: string }).message).toContain("someone/else");
    expect((result as { message: string }).message).toContain("acme/widget");
    expect(readCredentials()).toBeNull();
  });

  it("rejects and does not persist a token with no project scope", async () => {
    if (process.platform === "win32") return;
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ token: "tok", expiresAt: FUTURE }),
    );

    const result = await pollDeviceToken({
      apiBase: API,
      path: "/api/cli/device/token",
      project: "acme/widget",
      deviceCode: "dev-code",
      interval: 1,
      budgetMs: 1500,
      fetchImpl: fetchImpl as any,
    });

    expect(result).toMatchObject({ ok: false, reason: "error" });
    expect((result as { message: string }).message).toContain(
      "workspace/project scope",
    );
    expect(readCredentials()).toBeNull();
  });
});
