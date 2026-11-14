import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { NO_AUTO_OPEN_ENV, setApprovalOpener } from "../lib/approval-open";
import { findSecretArguments } from "../lib/secret-arguments";
import { createToolDispatcher, type ToolModule } from "../lib/tool-dispatch";
import * as submitTool from "../tools/submit-local";
import { API, PROJECT_ROUTE, useProjectRoutes } from "./fixtures/project-routes";

const submit = submitTool.handler;
const SESSION_ROUTE = `${PROJECT_ROUTE}/stores/firefox/connect-session`;
const KEY_MATERIAL = /user:\d+:\d+|[0-9a-f]{64}|PRIVATE KEY|apiKey|jwtSecret/;

function pending(extra: Record<string, unknown> = {}) {
  return { body: { ok: true, session: { id: "cs_123", store: "firefox", status: "pending", userCode: "ABCD-EFGH", actor: "acme", expiresAt: "2026-11-01T12:15:00.000Z", intervalSeconds: 0, ...extra } } };
}

function connected() {
  return {
    body: {
      ok: true,
      session: { id: "cs_123", store: "firefox", status: "connected", userCode: "ABCD-EFGH", actor: "acme", expiresAt: "2026-11-01T12:15:00.000Z", intervalSeconds: 0, connectedAs: "user:17:42-display", connectedAt: "2026-11-01T12:03:00.000Z", jwtSecret: "a".repeat(64) },
    },
  };
}

describe("extension_submit connect hands a store key from the person's browser to the platform and reports only the account and time", () => {
  const platform = useProjectRoutes("extdev-store-connect-");
  const opened: string[] = [];
  let restoreOpener: () => void = () => undefined;
  let prevNoOpen: string | undefined;

  beforeEach(() => {
    opened.length = 0;
    prevNoOpen = process.env[NO_AUTO_OPEN_ENV];
    process.env[NO_AUTO_OPEN_ENV] = "1";
    restoreOpener = setApprovalOpener((url) => {
      opened.push(url);

      return true;
    });
  });

  afterEach(() => {
    restoreOpener();
    if (prevNoOpen === undefined) delete process.env[NO_AUTO_OPEN_ENV];
    else process.env[NO_AUTO_OPEN_ENV] = prevNoOpen;
  });

  it("opens a session bound to the project and store, and answers the console page, the short code and the store's key page with no body sent", async () => {
    platform.login();
    platform.routes[`POST ${SESSION_ROUTE}`] = () => pending();

    const out = JSON.parse(await submit({ action: "connect", store: "firefox", api: API }));

    expect(out.status).toBe("connect-pending");
    expect(platform.sent("POST", SESSION_ROUTE)).toHaveLength(1);
    expect(platform.sent("POST", SESSION_ROUTE)[0].body).toEqual({});
    expect(out.value.connectSession).toBe("cs_123");
    expect(out.value.userCode).toBe("ABCD-EFGH");
    expect(out.value.connectUrl).toMatch(/\/acme\/widget\/connect\/firefox\?session=cs_123$/);
    expect(out.value.codeUrl).toMatch(/\/acme\/widget\/connect\/firefox$/);
    expect(out.value.storeKeyUrl).toBe("https://addons.mozilla.org/developers/addon/api/key/");
    expect(out.value.sayToPerson).toContain("enter the code ABCD-EFGH");
    expect(out.value.sayToPerson).toContain("never through this chat");
    expect(out.value.opened).toBe(false);
    expect(out.value.openedNote).toBe(`No page was opened: ${NO_AUTO_OPEN_ENV} is set in this server's environment. Hand the person the urls in this answer instead of calling again for a window.`);
    expect(out.hint).toContain(out.value.openedNote);
    expect(opened).toEqual([]);
  });

  it("names the variable that kept the pages shut on a headless server, and opens the store's key page then the console page on a desktop", async () => {
    platform.login();
    platform.routes[`POST ${SESSION_ROUTE}`] = () => pending();
    for (const key of [NO_AUTO_OPEN_ENV, "CI", "SSH_CONNECTION", "SSH_TTY", "SSH_CLIENT", "EXTENSION_BROWSER_FLAGS"]) vi.stubEnv(key, "");
    vi.stubEnv("EXTENSION_HEADLESS", "1");

    const shut = JSON.parse(await submit({ action: "connect", store: "firefox", api: API }));

    expect(shut.status).toBe("connect-pending");
    expect(shut.value.opened).toBe(false);
    expect(shut.value.openedNote).toBe("No page was opened: EXTENSION_HEADLESS=1 is set in this server's environment. Hand the person the urls in this answer instead of calling again for a window.");
    expect(shut.hint).toContain(shut.value.openedNote);
    expect(shut.value.sayToPerson).toContain(`Open ${shut.value.connectUrl} to connect Firefox Add-ons`);
    expect(shut.value.sayToPerson).toContain(`AMO shows the JWT secret only when it generates the pair; if you do not hold it in a password manager, the button to press on the key page is "Revoke and regenerate credentials"`);
    expect(opened).toEqual([]);

    vi.stubEnv("EXTENSION_HEADLESS", "");
    vi.stubEnv("DISPLAY", ":0");

    const open = JSON.parse(await submit({ action: "connect", store: "firefox", api: API }));

    expect(open.value.opened).toBe(true);
    expect(open.value.openedNote).toBeUndefined();
    expect(open.value.sayToPerson).toContain("is open in your browser");
    expect(open.value.sayToPerson).toContain("and the new pair must be pasted into the connect page right away.");
    expect(opened).toEqual(["https://addons.mozilla.org/developers/addon/api/key/", open.value.connectUrl]);
    vi.unstubAllEnvs();
  });

  it("waits on the platform's record and answers only who the store named and when, dropping anything else the record carries", async () => {
    platform.login();

    let reads = 0;

    platform.routes[`GET ${SESSION_ROUTE}`] = () => {
      reads += 1;

      return reads < 3 ? pending() : connected();
    };

    const out = JSON.parse(await submit({ action: "connect", store: "firefox", connectSession: "cs_123", waitSeconds: 5, api: API }));

    expect(out.status).toBe("store-connected");
    expect(reads).toBe(3);
    expect(platform.sent("POST", SESSION_ROUTE)).toHaveLength(0);
    expect(platform.sent("GET", SESSION_ROUTE).every((call) => call.url.includes("session=cs_123"))).toBe(true);
    expect(out.value.connectedAs).toBe("user:17:42-display");
    expect(out.value.connectedAt).toBe("2026-11-01T12:03:00.000Z");
    expect(JSON.stringify(out)).not.toContain("a".repeat(64));
    expect(out.value.nextStep.kind).toBe("preflight");
  });

  it("keeps a refused key pending with the store's own words, and says an expired session connected nothing", async () => {
    platform.login();
    platform.routes[`GET ${SESSION_ROUTE}`] = () => pending({ lastRefusal: { message: "Invalid JWT issuer or secret.", at: "2026-11-01T12:01:00.000Z" } });

    const refused = JSON.parse(await submit({ action: "connect", store: "firefox", connectSession: "cs_123", api: API }));

    expect(refused.status).toBe("connect-pending");
    expect(refused.value.lastRefusal.message).toBe("Invalid JWT issuer or secret.");
    expect(refused.value.sayToPerson).toContain("The store refused the last key with: Invalid JWT issuer or secret.");
    expect(refused.value.openedNote).toBe("No page was opened: this call resumed connect session cs_123, whose page opened when the session began.");

    platform.routes[`GET ${SESSION_ROUTE}`] = () => ({ status: 404, body: { code: "CONNECT_SESSION_NOT_FOUND", message: "No such connect session." } });

    const expired = JSON.parse(await submit({ action: "connect", store: "firefox", connectSession: "cs_123", api: API }));

    expect(expired.status).toBe("connect-expired");
    expect(expired.hint).toContain('{action: "connect", store: "firefox"}');
  });

  it("refuses a connect with no single store before any request", async () => {
    platform.login();

    const out = JSON.parse(await submit({ action: "connect", browsers: ["chrome", "edge"], api: API }));

    expect(out.status).toBe("bad-request");
    expect(platform.calls.filter((call) => call.path.includes("connect-session"))).toHaveLength(0);
  });

  it("refuses a store key in any tool argument at dispatch, sends nothing and never repeats the key", async () => {
    platform.login();

    const dispatch = createToolDispatcher({ tools: [submitTool] as unknown as ToolModule[], options: { features: ["local", "platform"], noShip: false } });
    const pem = "-----BEGIN PRIVATE KEY-----\nMIGTAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBHkwdwIBAQQg\n-----END PRIVATE KEY-----";
    const calls = [
      { action: "preflight", browsers: ["safari"], version: pem, api: API },
      { action: "preflight", browsers: ["firefox"], projectPath: "user:17:42", version: "b".repeat(64), api: API },
      { action: "preflight", browsers: ["chrome"], version: "GOCSPX-abcdefghijklmnopqrstuvwx", api: API },
    ];

    for (const args of calls) {
      const frame = await dispatch({ name: "extension_submit", arguments: args });
      const out = JSON.parse(frame.content[0]?.text ?? "{}");

      expect(out.status).toBe("credentials-console-only");
      expect(out.error.name).toBe("SecretArgumentRefused");
      expect(out.value.rotate).toBe(true);
      expect(out.value.connectCall).toContain('action: "connect"');
      expect(JSON.stringify(out)).not.toMatch(KEY_MATERIAL);
    }

    expect(platform.calls).toHaveLength(0);
  });

  it("leaves ordinary arguments alone: a build sha, a lone checksum, and storeSettings keys, which configure-store refuses with its own form labels", () => {
    expect(findSecretArguments({ buildSha: "c".repeat(40), checksum: "d".repeat(64), approvalId: "apr_iA1Zx", expression: "document.title" })).toEqual([]);
    expect(findSecretArguments({ storeSettings: { jwtSecret: "abc" } })).toEqual([]);
    expect(findSecretArguments({ storeSettings: { storeUrl: "user:1:2" } }).map((hit) => hit.kind)).toEqual(["amo-jwt-issuer"]);
    expect(findSecretArguments({ notes: { apiKey: "x1" } }).map((hit) => hit.path)).toEqual(["notes.apiKey"]);
  });
});
