// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { writeCredentials } from "../lib/credentials";
import { forgetLoginRenewals } from "../lib/login-expired";
import { handler as auth } from "../tools/auth";
import { handler as builds } from "../tools/builds";
import { handler as publish } from "../tools/publish";
import { handler as promote } from "../tools/release-promote";
import { handler as submit } from "../tools/submit-local";

const API = "https://www.extension.dev";
const NOW = Math.floor(Date.now() / 1000);
const EXPIRED_AT = NOW - 7200;
const EXPIRED_ISO = new Date(EXPIRED_AT * 1000).toISOString();
const VERIFY = `${API}/device`;
const ENV_KEYS = ["XDG_CONFIG_HOME", "EXTENSION_DEV_API_URL", "EXTENSION_DEV_TOKEN", "EXTENSION_DEV_PROJECT"];

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    headers: { get: () => null },
    text: async () => JSON.stringify(body),
    json: async () => body,
  } as unknown as Response;
}

function login(project: string, expiresAt: number): void {
  writeCredentials({ version: 1, token: `stored-${project}`, workspaceSlug: "acme", projectSlug: project, projectId: `prj_${project}`, expiresAt, api: API });
}

interface Seen {
  urls: string[];
  starts: number;
  tokens: string[];
}

function serve(seen: Seen): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    const at = String(url);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const bearer = String(headers.authorization ?? headers.Authorization ?? "");
    seen.urls.push(at);
    if (bearer) seen.tokens.push(bearer);

    if (at.endsWith("/api/cli/login/config")) {
      return jsonResponse({ deviceCodeUrl: "/api/cli/device/code", deviceTokenUrl: "/api/cli/device/token", verificationUri: VERIFY });
    }

    if (at.endsWith("/api/cli/device/code")) {
      seen.starts += 1;

      return jsonResponse({
        device_code: `dev_${seen.starts}`,
        user_code: `CODE-${seen.starts}`,
        verification_uri: VERIFY,
        verification_uri_complete: `${VERIFY}?code=CODE-${seen.starts}`,
        interval: 5,
        expires_in: 900,
      });
    }

    return jsonResponse({ error: "unauthorized", reason: "missing-token" }, false, 401);
  }) as unknown as typeof fetch;
}

const RENEW = { tool: "extension_auth", args: { action: "login", project: "acme/widget", deviceCode: "dev_1" } };

function expectRenewal(out: { ok: boolean; status: string; error: { code: string; name: string; message: string }; value: Record<string, any>; hint: string }): void {
  expect(out.ok).toBe(false);
  expect(out.status).toBe("not-signed-in");
  expect(out.error.code).toBe("E_AUTH_EXPIRED");
  expect(out.error.name).toBe("LoginExpired");
  expect(out.error.message).toContain(`The login for acme/widget expired at ${EXPIRED_ISO} (2 h 0 min ago)`);
  expect(out.error.message).not.toContain("No stored login");
  expect(out.value.login.project).toBe("acme/widget");
  expect(out.value.login.expiresAt).toBe(EXPIRED_ISO);
  expect(out.value.login.sent).toBe(false);
  expect(out.value.login.renew).toEqual(RENEW);
  expect(out.value.login.device).toEqual({ verificationUrl: `${VERIFY}?code=CODE-1`, userCode: "CODE-1", expiresAt: expect.any(String), then: RENEW });
  expect(Date.parse(out.value.login.device.expiresAt)).toBeGreaterThan(Date.now() + 800_000);
  expect(out.value.nextStep).toEqual({ kind: "login", say: expect.stringContaining(`Open ${VERIFY}?code=CODE-1 and approve (code CODE-1`), url: `${VERIFY}?code=CODE-1` });
  expect(out.hint).toContain('extension_auth {action: "login", project: "acme/widget", deviceCode: "dev_1"}');
  expect(out.hint).toContain(`expired at ${EXPIRED_ISO}`);
  expect(out.hint).not.toMatch(/extension_auth \(action: status\)/);
}

describe("a token-scoped tool under an expired login names the expiry and starts the renewal (ledger 453)", () => {
  let tmp: string;
  let prevFetch: typeof fetch;
  let seen: Seen;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of ENV_KEYS) saved[key] = process.env[key];
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "extdev-login-renewal-"));
    process.env.XDG_CONFIG_HOME = tmp;
    delete process.env.EXTENSION_DEV_API_URL;
    delete process.env.EXTENSION_DEV_TOKEN;
    delete process.env.EXTENSION_DEV_PROJECT;
    prevFetch = global.fetch;
    seen = { urls: [], starts: 0, tokens: [] };
    global.fetch = serve(seen);
    forgetLoginRenewals();
    login("widget", EXPIRED_AT);
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }

    global.fetch = prevFetch;
    forgetLoginRenewals();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("extension_submit preflight answers the expiry, the renew call and the approval link, and sends no token", async () => {
    if (process.platform === "win32") return;

    const out = JSON.parse(await submit({ action: "preflight", project: "acme/widget", browsers: ["safari"] }));

    expectRenewal(out);
    expect(out.command).toBe("extension_submit");
    expect(out.value.action).toBe("preflight");
    expect(out.value.trackUrl).toBe("https://console.extension.dev/acme/widget");
    expect(out.hint).toContain("The project page is https://console.extension.dev/acme/widget");
    expect(seen.urls).toEqual([`${API}/api/cli/login/config`, `${API}/api/cli/device/code`]);
    expect(seen.tokens).toEqual([]);
  });

  it("extension_submit, extension_publish and extension_release_promote share the refusal and one pending code per project", async () => {
    if (process.platform === "win32") return;

    const submitted = JSON.parse(await submit({ action: "submit", project: "acme/widget", browsers: ["chrome"], buildSha: "abc1234" }));
    const published = JSON.parse(await publish({ project: "acme/widget" }));
    const promoted = JSON.parse(await promote({ project: "acme/widget", buildId: "abc1234", channel: "stable" }));

    for (const out of [submitted, published, promoted]) expectRenewal(out);
    expect(submitted.command).toBe("extension_submit");
    expect(submitted.value.action).toBe("submit");
    expect(published.command).toBe("extension_publish");
    expect(promoted.command).toBe("extension_release_promote");
    expect(seen.starts).toBe(1);
    expect(seen.tokens).toEqual([]);
  });

  it("extension_builds list names the expiry and the renew call too", async () => {
    if (process.platform === "win32") return;

    const out = JSON.parse(await builds({ action: "list", project: "acme/widget" }));

    expectRenewal(out);
    expect(out.command).toBe("extension_builds");
    expect(out.value.action).toBe("list");
  });

  it("a login that is merely missing keeps the no-stored-login wording and starts nothing", async () => {
    if (process.platform === "win32") return;

    const out = JSON.parse(await submit({ action: "submit", project: "acme/other", browsers: ["chrome"], buildSha: "abc1234" }));

    expect(out.ok).toBe(false);
    expect(out.status).toBe("auth-required");
    expect(out.error.code).toBe("E_AUTH_REQUIRED");
    expect(out.error.message).toContain("No stored login for acme/other");
    expect(out.value?.login).toBeUndefined();
    expect(seen.urls).toEqual([]);
  });

  it("extension_auth status lists the expired login and never starts a device flow", async () => {
    if (process.platform === "win32") return;

    const out = JSON.parse(await auth({ action: "status" }));
    const listed = (out.value.logins as Array<{ project: string; expired?: boolean }>).find((entry) => entry.project === "acme/widget");

    expect(listed?.expired).toBe(true);
    expect(seen.starts).toBe(0);
    expect(seen.urls.some((url) => url.endsWith("/api/cli/device/code") || url.endsWith("/api/cli/login/config"))).toBe(false);
  });

  it("a device start the platform refuses still answers the expiry and the renew call, with no device", async () => {
    if (process.platform === "win32") return;

    global.fetch = (async (url: string) => {
      seen.urls.push(String(url));

      return jsonResponse({ message: "device flow paused" }, false, 503);
    }) as unknown as typeof fetch;

    const out = JSON.parse(await publish({ project: "acme/widget" }));

    expect(out.status).toBe("not-signed-in");
    expect(out.error.code).toBe("E_AUTH_EXPIRED");
    expect(out.value.login.renew).toEqual({ tool: "extension_auth", args: { action: "login", project: "acme/widget" } });
    expect(out.value.login.device).toBeUndefined();
    expect(out.value.nextStep.say).toContain('Sign in again with extension_auth {action: "login", project: "acme/widget"}, then call this again');
    expect(out.value.nextStep.url).toBe("https://console.extension.dev/acme/widget");
  });

  it("EXTENSION_DEV_TOKEN covering the project outranks the expired default login", async () => {
    if (process.platform === "win32") return;

    process.env.EXTENSION_DEV_TOKEN = `${Buffer.from(JSON.stringify({ u: "acme", p: "widget" })).toString("base64url")}.sig`;
    const out = JSON.parse(await builds({ action: "list" }));

    expect(out.status).not.toBe("not-signed-in");
    expect(seen.starts).toBe(0);
  });
});
