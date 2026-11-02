// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { NO_AUTO_OPEN_ENV, setApprovalOpener } from "../lib/approval-open";
import { setConnectCheckPause } from "../lib/connect-existing";
import { storeReadinessOf } from "../lib/store-onboarding";
import { handler as submit } from "../tools/submit";
import { API, PROJECT_ROUTE, useProjectRoutes } from "./fixtures/project-routes";

type Row = Record<string, any>;

const CONFIG = `${PROJECT_ROUTE}/stores/config`;
const POLL = `${PROJECT_ROUTE}/stores/firefox/poll`;
const SESSION = (store: string) => `${PROJECT_ROUTE}/stores/${store}/connect-session`;
const CHROME_HEALTH = `${PROJECT_ROUTE}/stores/chrome/health`;
const BEFORE = "2026-10-30T09:00:00.000Z";
const NOW = "2026-11-02T14:05:00.000Z";
const SECRET = "f".repeat(64);
const AMO_401 = 'Invalid Firefox credentials: AMO answered 401 "Incorrect authentication credentials." (the JWT issuer or secret is wrong, or the secret was rotated).';

function config(store: string, connection: Row): { body: Row } {
  return { body: { [store]: { enabled: true, credentialsConfigured: true, connection: { ...connection, jwtSecret: SECRET } } } };
}

function firefox(extra: Row = {}): Row {
  return { kind: "jwt", source: "project", connectedAs: "user:17:42", connectedAt: "2026-10-01T10:00:00.000Z", checkedAt: BEFORE, healthy: true, ...extra };
}

function pending(store: string) {
  return { body: { ok: true, session: { id: "cs_9", store, status: "pending", userCode: "WXYZ-1234", actor: "acme", expiresAt: "2026-11-02T14:20:00.000Z", intervalSeconds: 0 } } };
}

describe("extension_submit connect recognizes a store that already has a working key instead of opening a page that replaces it", () => {
  const platform = useProjectRoutes("extdev-connect-existing-");
  const opened: string[] = [];
  let restore: Array<() => void> = [];
  let prevNoOpen: string | undefined;

  beforeEach(() => {
    opened.length = 0;
    prevNoOpen = process.env[NO_AUTO_OPEN_ENV];
    process.env[NO_AUTO_OPEN_ENV] = "1";
    restore = [
      setApprovalOpener((url) => {
        opened.push(url);

        return true;
      }),
      setConnectCheckPause(async () => undefined),
    ];

    platform.login();
    platform.routes[`POST ${SESSION("firefox")}`] = () => pending("firefox");
    platform.routes[`POST ${SESSION("chrome")}`] = () => pending("chrome");
  });

  afterEach(() => {
    for (const undo of restore) undo();
    if (prevNoOpen === undefined) delete process.env[NO_AUTO_OPEN_ENV];
    else process.env[NO_AUTO_OPEN_ENV] = prevNoOpen;
  });

  function checkAnswers(after: Row): void {
    let reads = 0;

    platform.routes[`GET ${CONFIG}`] = () => {
      reads += 1;

      return config("firefox", reads === 1 ? firefox() : after);
    };

    platform.routes[`POST ${POLL}`] = () => ({ body: { ok: true, dispatched: true, queued: false, store: "firefox" } });
  }

  it("answers already-connected with the account and the check that ran now, and opens no page or session for a key the store accepts", async () => {
    checkAnswers(firefox({ checkedAt: NOW }));

    const out = JSON.parse(await submit({ action: "connect", store: "firefox", api: API }));

    expect(out.status).toBe("already-connected");
    expect(out.value.connectedAs).toBe("user:17:42");
    expect(out.value.checkedAt).toBe(NOW);
    expect(out.value.checkedNow).toBe(true);
    expect(out.value.opened).toBe(false);
    expect(platform.sent("POST", POLL)).toHaveLength(1);
    expect(platform.sent("POST", SESSION("firefox"))).toHaveLength(0);
    expect(opened).toEqual([]);
    expect(out.value.sayToPerson).toBe(
      `Firefox Add-ons is already connected as user:17:42, and the store accepted the saved key when it was checked just now, ${NOW}. No connect page was opened and nothing was replaced. Say preflight and I read the store's readiness now. To put a different key in its place, ask for it and I call extension_submit {action: "connect", store: "firefox", replace: true}.`,
    );

    expect(JSON.stringify(out)).not.toContain(SECRET);
  });

  it("opens the page with the store's own refusal words when the saved key fails the check", async () => {
    checkAnswers(firefox({ checkedAt: NOW, healthy: false, reason: AMO_401 }));

    const out = JSON.parse(await submit({ action: "connect", store: "firefox", api: API }));

    expect(out.status).toBe("connect-pending");
    expect(platform.sent("POST", SESSION("firefox"))).toHaveLength(1);
    expect(out.value.connectUrl).toMatch(/\/connect\/firefox\?session=cs_9$/);
    expect(out.value.storeRefusal).toEqual({ message: AMO_401.replace(/\.$/, ""), checkedAt: NOW, checkedNow: true });
    expect(out.value.sayToPerson.startsWith(`The store refused the saved Firefox Add-ons key (user:17:42) when it was checked just now, ${NOW}: Invalid Firefox credentials: AMO answered 401`)).toBe(true);
    expect(JSON.stringify(out)).not.toContain(SECRET);
  });

  it("opens the page with no check when the store has no connection", async () => {
    platform.routes[`GET ${CONFIG}`] = () => ({ body: { firefox: { enabled: false, credentialsConfigured: false, connection: { kind: null, healthy: null } } } });

    const out = JSON.parse(await submit({ action: "connect", store: "firefox", api: API }));

    expect(out.status).toBe("connect-pending");
    expect(platform.sent("POST", SESSION("firefox"))).toHaveLength(1);
    expect(platform.sent("POST", POLL)).toHaveLength(0);
  });

  it("opens the page over a working key only with replace: true, checking nothing first and naming the key it replaces", async () => {
    checkAnswers(firefox({ checkedAt: NOW }));

    const out = JSON.parse(await submit({ action: "connect", store: "firefox", replace: true, api: API }));

    expect(out.status).toBe("connect-pending");
    expect(platform.sent("POST", SESSION("firefox"))).toHaveLength(1);
    expect(platform.sent("GET", CONFIG)).toHaveLength(1);
    expect(platform.sent("POST", POLL)).toHaveLength(0);
    expect(out.value.keyOnFile).toEqual({ source: "project", connectedAs: "user:17:42", product: null, checkedAt: BEFORE, healthy: true });
    expect(out.value.sayToPerson).toContain("A key saved on this page replaces it.");
    expect(JSON.stringify(out)).not.toContain(SECRET);
  });

  it("counts a workspace account that covers the project and passed its check as connected, with no page and no project check", async () => {
    platform.routes[`GET ${CONFIG}`] = () => config("firefox", firefox({ source: "workspace", connectedAs: "user:5:9", checkedAt: NOW }));

    const out = JSON.parse(await submit({ action: "connect", store: "firefox", api: API }));

    expect(out.status).toBe("already-connected");
    expect(out.value.source).toBe("workspace");
    expect(out.value.sayToPerson).toContain("already connected through the workspace's account as user:5:9, which covers this project");
    expect(platform.sent("POST", SESSION("firefox"))).toHaveLength(0);
    expect(platform.sent("POST", POLL)).toHaveLength(0);
  });

  it("says a Chrome check that could not run now and keeps the last passing check, opening no page", async () => {
    platform.routes[`GET ${CONFIG}`] = () => config("chrome", { kind: "oauth", source: "project", connectedAs: "owner@example.com", checkedAt: BEFORE, healthy: true });
    platform.routes[`GET ${CHROME_HEALTH}`] = () => ({ status: 403, body: { code: "PROJECT_TOKEN_REFUSED", message: "Project tokens are not accepted here." } });

    const out = JSON.parse(await submit({ action: "connect", store: "chrome", api: API }));

    expect(out.status).toBe("already-connected");
    expect(out.value.checkedNow).toBe(false);
    expect(out.value.checkedAt).toBe(BEFORE);
    expect(out.value.sayToPerson).toContain(`at its last check, ${BEFORE}; a new check could not run now: Project tokens are not accepted here.`);
    expect(platform.sent("POST", SESSION("chrome"))).toHaveLength(0);
  });

  it("reads a passing connection as satisfied in the milestone 1 readiness list, even when the requirement row says missing", () => {
    const view = (connection: Row | null) => ({
      ...(connection ? { connection } : {}),
      requirements: { items: [{ id: "firefox.api_credentials", status: "missing", required: true, satisfiedBy: "console-only" }] },
    });

    const passing = storeReadinessOf({ stores: { firefox: view({ kind: "jwt", source: "workspace", healthy: true }) }, asked: ["firefox"], projectPath: "" });
    const failing = storeReadinessOf({ stores: { firefox: view({ kind: "jwt", healthy: false }) }, asked: ["firefox"], projectPath: "" });

    expect(passing.connected).toEqual(["firefox"]);
    expect(passing.personDecides.required).not.toContain("firefox.api_credentials");
    expect(failing.connected).toEqual([]);
    expect(failing.personDecides.required).toContain("firefox.api_credentials");
  });
});
