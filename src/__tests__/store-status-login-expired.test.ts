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
import { fetchRegistryJson } from "../lib/registry";
import { RegistryAccessTokens } from "../lib/registry-access";
import { handler as releaseStatus } from "../tools/release-status";
import { readStores } from "../tools/store-status";
import { storeVersionStatus } from "../tools/store-version-status";

const API = "https://www.extension.dev";
const NOW = Math.floor(Date.now() / 1000);
const EXPIRED_AT = NOW - 34119;
const EXPIRED_ISO = new Date(EXPIRED_AT * 1000).toISOString();
const LOGIN_CALL = 'extension_auth {action: "login", project: "acme/widget"}';
const ENV_KEYS = ["XDG_CONFIG_HOME", "EXTENSION_DEV_API_URL", "EXTENSION_DEV_TOKEN", "EXTENSION_DEV_PROJECT"];
const READ_AT = "2026-10-31T11:15:45.000Z";

const IN_REVIEW = {
  id: "sub_safari_14",
  store: "safari",
  channel: "stable",
  buildId: "e679664",
  version: "0.2.0",
  status: "submitted",
  submittedAt: "2026-10-29T20:24:00.000Z",
  storeUrl: null,
  run: null,
  storeVersion: { packaged: "0.2.0", displayed: "0.2.0", source: "repo", buildNumber: 14 },
  storeReview: { state: "WAITING_FOR_REVIEW", checkedAt: READ_AT, source: "poll" },
  statusRead: { word: "submitted", readAt: READ_AT, source: "poll", storeWord: "WAITING_FOR_REVIEW" },
  appStoreRelease: { type: "MANUAL", readAt: READ_AT },
};

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    headers: { get: () => null },
    text: async () => JSON.stringify(body),
    json: async () => body,
  } as unknown as Response;
}

function login(expiresAt: number): void {
  writeCredentials({ version: 1, token: "claims.sig", workspaceSlug: "acme", projectSlug: "widget", projectId: "prj_1", expiresAt, api: API });
}

function claimsToken(workspace: string, project: string): string {
  return `${Buffer.from(JSON.stringify({ u: workspace, p: project })).toString("base64url")}.sig`;
}

function serve(calls: string[]): typeof fetch {
  return (async (url: string) => {
    const at = String(url);
    calls.push(at);

    if (at.endsWith("/api/cli/whoami")) return jsonResponse({ projectId: "prj_1", workspaceSlug: "acme", projectSlug: "widget" });
    if (at.endsWith("/api/cli/stores/submissions")) return jsonResponse({ ok: true, projectId: "prj_1", submissions: [IN_REVIEW] });

    return jsonResponse({ error: "unauthorized", reason: "missing-token" }, false, 401);
  }) as unknown as typeof fetch;
}

describe("a store status read under an expired login names the expiry instead of guessing (ledger 314)", () => {
  let tmp: string;
  let prevFetch: typeof fetch;
  let calls: string[];
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of ENV_KEYS) saved[key] = process.env[key];
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "extdev-login-expired-"));
    process.env.XDG_CONFIG_HOME = tmp;
    delete process.env.EXTENSION_DEV_API_URL;
    delete process.env.EXTENSION_DEV_TOKEN;
    delete process.env.EXTENSION_DEV_PROJECT;
    prevFetch = global.fetch;
    calls = [];
    global.fetch = serve(calls);
    login(EXPIRED_AT);
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }

    global.fetch = prevFetch;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("extension_submit status answers not-signed-in with the expiry, the login call and the store page, and reads nothing", async () => {
    if (process.platform === "win32") return;

    const out = JSON.parse(await storeVersionStatus({ project: "acme/widget", browsers: ["safari"], waitSeconds: 180 }));

    expect(out.ok).toBe(false);
    expect(out.command).toBe("extension_submit");
    expect(out.status).toBe("not-signed-in");
    expect(out.error.code).toBe("E_AUTH_EXPIRED");
    expect(out.error.name).toBe("LoginExpired");
    expect(out.error.message).toContain(`The login for acme/widget expired at ${EXPIRED_ISO} (9 h 29 min ago)`);
    expect(out.error.message).toContain("this server drops an expired token instead of sending it, and the platform would have read the call as missing-token");
    expect(out.error.message).not.toMatch(/no stores configured|slugs may be wrong|StoreStatusNotFound/);
    expect(out.value.login).toEqual({ project: "acme/widget", expiresAt: EXPIRED_ISO, expiredForSeconds: 34119, sent: false });
    expect(out.value.nextStep.kind).toBe("login");
    expect(out.value.nextStep.say).toContain(`Sign in again with ${LOGIN_CALL}, then call this again`);
    expect(out.value.trackUrl).toBe("https://console.extension.dev/acme/widget/submissions/safari");
    expect(out.value.nextStep.url).toBe(out.value.trackUrl);
    expect(out.hint).toContain(out.value.trackUrl);
    expect(out.hint).toContain(LOGIN_CALL);
    expect(calls).toEqual([]);
  });

  it("extension_release_status include stores answers the same refusal in its stores section and reads nothing", async () => {
    if (process.platform === "win32") return;

    const out = JSON.parse(await releaseStatus({ include: ["stores"], project: "acme/widget" }));
    const stores = out.value.stores;

    expect(out.ok).toBe(false);
    expect(stores.status).toBe("not-signed-in");
    expect(stores.error.code).toBe("E_AUTH_EXPIRED");
    expect(stores.error.message).toContain(`expired at ${EXPIRED_ISO}`);
    expect(stores.value.trackUrl).toBe("https://console.extension.dev/acme/widget/submissions");
    expect(stores.value.nextStep.say).toContain(LOGIN_CALL);
    expect(calls).toEqual([]);
  });

  it("with no project named, the default login's own expiry is the one refused", async () => {
    if (process.platform === "win32") return;

    const out = JSON.parse(await storeVersionStatus({ browsers: ["safari"] }));

    expect(out.status).toBe("not-signed-in");
    expect(out.error.message).toContain("The login for acme/widget expired at");
    expect(calls).toEqual([]);
  });

  it("EXTENSION_DEV_TOKEN covering the project lets the read go on", async () => {
    if (process.platform === "win32") return;

    process.env.EXTENSION_DEV_TOKEN = claimsToken("acme", "widget");
    const out = JSON.parse(await readStores({ project: "acme/widget" }));

    expect(out.status).not.toBe("not-signed-in");
    expect(calls.length).toBeGreaterThan(0);
  });

  it("a registry refusal under an expired login says the token expired and was not sent, never that the project is private", async () => {
    if (process.platform === "win32") return;

    const fetched: string[] = [];
    const fetchImpl = serve(fetched);
    const res = await fetchRegistryJson("https://registry.extension.land/acme/widget/_extension-dev/stores/health.json", fetchImpl, {
      ref: { workspace: "acme", project: "widget" },
      tokens: new RegistryAccessTokens({ fetchImpl }),
    });

    expect(res.ok).toBe(false);
    expect((res as { message: string }).message).toContain(`The stored login for acme/widget expired at ${EXPIRED_ISO} (9 h 29 min ago), so this server sent no token and the platform read the call as missing-token. Run ${LOGIN_CALL} to refresh it.`);
    expect((res as { message: string }).message).not.toContain("This project is private");
    expect(fetched).toHaveLength(1);
  });
});
