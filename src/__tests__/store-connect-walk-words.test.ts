// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import fs from "node:fs";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { NO_AUTO_OPEN_ENV, setApprovalOpener } from "../lib/approval-open";
import { setConnectCheckPause } from "../lib/connect-existing";
import { installPlatformKernelHooks } from "../lib/platform-kernel-hooks";
import { createToolDispatcher, type ToolModule } from "../lib/tool-dispatch";
import * as submitTool from "../tools/submit";
import { API, PROJECT_ROUTE, useProjectRoutes } from "./fixtures/project-routes";

installPlatformKernelHooks();

type Row = Record<string, any>;

const CONFIG = `${PROJECT_ROUTE}/stores/config`;
const SESSION = (store: string) => `${PROJECT_ROUTE}/stores/${store}/connect-session`;
const POLL = (store: string) => `${PROJECT_ROUTE}/stores/${store}/poll`;
const PREFLIGHT = (store: string) => `${PROJECT_ROUTE}/stores/${store}/submissions/preflight`;
const PRODUCT = "e0df1eac-b29e-4fad-918e-87cbe3b2a1ad";
const AMO = "user:15559442:832";
const BEFORE = "2026-11-01T09:00:00.000Z";
const NOW = "2026-11-02T14:05:00.000Z";
const SECRET = "f".repeat(64);
const STORES = ["chrome", "edge", "firefox", "safari"] as const;
const WALK: Record<string, Row> = JSON.parse(fs.readFileSync(fileURLToPath(new URL("./fixtures/preflight-four-stores.json", import.meta.url)), "utf8"));

function session(store: string, status: "pending" | "connected", extra: Row = {}) {
  return { body: { ok: true, session: { id: "cs_7", store, status, userCode: "WXYZ-1234", actor: "acme", expiresAt: "2026-11-02T14:20:00.000Z", intervalSeconds: 0, ...extra } } };
}

async function call(args: Row): Promise<Row> {
  const dispatch = createToolDispatcher({ tools: [submitTool] as unknown as ToolModule[], options: { features: ["local", "platform"], noShip: false } });
  const frame = await dispatch({ name: "extension_submit", arguments: { api: API, ...args } });

  return JSON.parse(frame.content[0]?.text ?? "{}");
}

describe("the 2026-11-02 connect walk: what each store names, what is on file, and which stores read connected", () => {
  const platform = useProjectRoutes("extdev-connect-walk-");
  let restore: Array<() => void> = [];
  let prevNoOpen: string | undefined;
  let prevGate: string | undefined;

  beforeEach(() => {
    prevNoOpen = process.env[NO_AUTO_OPEN_ENV];
    prevGate = process.env.EXTENSION_DEV_APPROVAL_GATE;
    process.env[NO_AUTO_OPEN_ENV] = "1";
    process.env.EXTENSION_DEV_APPROVAL_GATE = "0";
    restore = [setApprovalOpener(() => true), setConnectCheckPause(async () => undefined)];
    platform.login();
  });

  afterEach(() => {
    for (const undo of restore) undo();
    if (prevNoOpen === undefined) delete process.env[NO_AUTO_OPEN_ENV];
    else process.env[NO_AUTO_OPEN_ENV] = prevNoOpen;
    if (prevGate === undefined) delete process.env.EXTENSION_DEV_APPROVAL_GATE;
    else process.env.EXTENSION_DEV_APPROVAL_GATE = prevGate;
  });

  it("ledger 382: an Edge connect names the product the key was checked against, never as an account", async () => {
    platform.routes[`GET ${SESSION("edge")}`] = () => session("edge", "connected", { connectedAs: PRODUCT, connectedAt: NOW });

    const out = await call({ action: "connect", store: "edge", connectSession: "cs_7", waitSeconds: 5 });

    expect(out.status).toBe("store-connected");
    expect(out.value.connectedAs).toBeNull();
    expect(out.value.product).toBe(PRODUCT);
    expect(out.value.sayToPerson).toContain(`Edge Add-ons is connected for product ${PRODUCT} (Edge names no account; the key was checked against that product)`);
    expect(JSON.stringify(out)).not.toContain(`as ${PRODUCT}`);
  });

  it("ledger 382: an Edge key that still passes says the product, and a saved product id is said as already filled on the page", async () => {
    platform.routes[`GET ${CONFIG}`] = () => ({ body: { edge: { storeId: PRODUCT, connection: { kind: "apiKey", source: "workspace", connectedAs: PRODUCT, checkedAt: NOW, healthy: true } } } });

    const passing = await call({ action: "connect", store: "edge" });

    expect(passing.status).toBe("already-connected");
    expect(passing.value.connectedAs).toBeNull();
    expect(passing.value.product).toBe(PRODUCT);
    expect(passing.value.sayToPerson).not.toContain(`as ${PRODUCT}`);

    platform.routes[`GET ${CONFIG}`] = () => ({ body: { edge: { storeId: PRODUCT, connection: { kind: null, healthy: null } } } });
    platform.routes[`POST ${SESSION("edge")}`] = () => session("edge", "pending");

    const page = await call({ action: "connect", store: "edge" });

    expect(page.status).toBe("connect-pending");
    expect(page.value.savedProduct).toBe(PRODUCT);
    expect(page.value.sayToPerson).toContain(`the Product ID is already filled with the saved product ${PRODUCT}`);
    expect(page.value.sayToPerson).not.toContain("give the Product ID");
  });

  it("ledger 383: the preflight summary reads the App Store not connected when its credentials check fails, and names the connect call", async () => {
    const reports: Record<string, Row> = structuredClone(WALK);
    const safari = reports.safari!;

    safari.checks = [...safari.checks, { id: "store.credentials_present", label: "Store credentials are saved", status: "fail", severity: "blocking", message: "Missing: store credentials" }];

    for (const store of STORES) platform.routes[`POST ${PREFLIGHT(store)}`] = () => ({ body: reports[store] });

    const out = await call({ action: "preflight", browsers: [...STORES] });
    const readiness = out.value.readiness;

    expect(readiness.connected).toEqual(["chrome", "edge", "firefox"]);
    expect(readiness.notConnected).toEqual(["safari"]);
    expect(readiness.personDecides.required).toContain("safari.api_key");
    expect(readiness.summary[3]).toBe(
      'Connected: the Chrome Web Store, Edge Add-ons and Firefox AMO. Not connected: the App Store; extension_submit {action: "connect", store: "safari"} opens its connect page.',
    );
  });

  it("ledger 384: replace over a workspace Firefox account says a working key is on file and that a project key would shadow it", async () => {
    platform.routes[`GET ${CONFIG}`] = () => ({ body: { firefox: { connection: { kind: "jwt", source: "workspace", connectedAs: AMO, checkedAt: BEFORE, healthy: true, jwtSecret: SECRET } } } });
    platform.routes[`POST ${SESSION("firefox")}`] = () => session("firefox", "pending");

    const out = await call({ action: "connect", store: "firefox", replace: true });

    expect(out.status).toBe("connect-pending");
    expect(platform.sent("POST", POLL("firefox"))).toHaveLength(0);
    expect(out.value.keyOnFile).toEqual({ source: "workspace", connectedAs: AMO, product: null, checkedAt: BEFORE, healthy: true });
    expect(out.value.sayToPerson.startsWith(`A working key is already on file: Firefox Add-ons reads connected through the workspace's account as ${AMO}, which covers this project, and the store accepted it at its last check, ${BEFORE}. A key saved on this page becomes this project's own and shadows the workspace's account for this project only.`)).toBe(true);
    expect(JSON.stringify(out)).not.toContain(SECRET);
  });

  it("ledger 384: a timed-out wait still says the key on file, and hands out preflight for the session's own store", async () => {
    platform.routes[`GET ${CONFIG}`] = () => ({
      body: {
        firefox: { connection: { kind: "jwt", source: "project", connectedAs: AMO, checkedAt: BEFORE, healthy: true } },
        safari: { connection: { kind: null, healthy: null } },
      },
    });

    platform.routes[`GET ${SESSION("firefox")}`] = () => session("firefox", "pending");
    platform.routes[`GET ${SESSION("safari")}`] = () => session("safari", "pending");

    const firefox = await call({ action: "connect", store: "firefox", connectSession: "cs_7", waitSeconds: 0 });
    const safari = await call({ action: "connect", store: "safari", connectSession: "cs_7", waitSeconds: 0 });

    expect(firefox.status).toBe("connect-pending");
    expect(firefox.value.sayToPerson).toContain(`A working key is already on file: Firefox Add-ons reads connected with this project's key as ${AMO}`);
    expect(firefox.value.nextStep.thenCall.args.browsers).toEqual(["firefox"]);
    expect(safari.value.keyOnFile).toBeUndefined();

    expect(safari.value.sayToPerson).toContain(
      `On the App Store key page, press the "+" beside "Active" (not Edit, which only revokes keys), name the key, give it App Manager access and use "Download API Key" in that dialog, because the .p8 is offered once; the Issuer ID is at the top of that page and the Key ID is in the new row.`,
    );

    expect(safari.value.sayToPerson).not.toContain("Revoke and regenerate");
    expect(firefox.value.sayToPerson).not.toContain("Download API Key");
    expect(safari.value.nextStep.thenCall.args.browsers).toEqual(["safari"]);
  });

  it("ledger 384: a workspace Firefox account that passed opens no page and says it covers the project (the ledger 376 read of stores/config)", async () => {
    platform.routes[`GET ${CONFIG}`] = () => ({ body: { firefox: { connection: { kind: "jwt", source: "workspace", connectedAs: AMO, checkedAt: BEFORE, healthy: true } } } });

    const out = await call({ action: "connect", store: "firefox" });

    expect(out.status).toBe("already-connected");
    expect(out.value.source).toBe("workspace");
    expect(out.value.sayToPerson).toContain(`through the workspace's account as ${AMO}, which covers this project`);
    expect(platform.sent("POST", SESSION("firefox"))).toHaveLength(0);
  });
});
