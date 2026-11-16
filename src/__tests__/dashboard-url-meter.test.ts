// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { memoryShelf, scratchShelf, withCallMemory } from "../lib/call-memory";
import { withRequestCredential } from "../lib/credential-scope";
import {
  DASHBOARD_URL_COMPOSED_EVENT,
  composedDashboardUrl,
  composedDashboardUrls,
  dashboardStoreOf,
  meterComposedDashboardUrls,
} from "../lib/dashboard-url-meter";
import { envelope } from "../lib/envelope";
import { AMO_API_KEY_PAGE } from "../lib/firefox-store";
import { chromeItemUrl, itemLinkUrls } from "../lib/store-connection";
import { readStoreSettingsChange } from "../lib/store-settings";

type Sent = { event: string; properties: Record<string, unknown> };

const ENV_KEYS = ["EXTENSION_DEV_API_URL", "EXTENSION_DEV_NO_TELEMETRY", "DO_NOT_TRACK", "EXTENSION_DEV_POSTHOG_KEY", "EXTENSION_DEV_POSTHOG_KEY_NONPRODUCTION"];
const saved: Record<string, string | undefined> = {};

let sent: Sent[] = [];
let posted: Array<Record<string, unknown>> = [];

const capture = async (event: string, properties: Record<string, unknown>) => {
  sent.push({ event, properties });

  return null;
};

beforeEach(() => {
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }

  sent = [];
  posted = [];
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }

  vi.unstubAllGlobals();
});

describe("a store dashboard address this server composes is counted once per answer", () => {
  it("knows the four dashboard hosts the release DX meter counts and nothing else", () => {
    expect(dashboardStoreOf("https://chrome.google.com/webstore/devconsole/abc/def/edit")).toEqual({ store: "chrome", host: "chrome.google.com" });
    expect(dashboardStoreOf("https://partner.microsoft.com/dashboard/microsoftedge/publishapi")).toEqual({ store: "edge", host: "partner.microsoft.com" });
    expect(dashboardStoreOf("https://addons.mozilla.org/developers/addon/api/key/")).toEqual({ store: "firefox", host: "addons.mozilla.org" });
    expect(dashboardStoreOf("https://appstoreconnect.apple.com/access/integrations/api")).toEqual({ store: "safari", host: "appstoreconnect.apple.com" });
    expect(dashboardStoreOf("https://api.appstoreconnect.apple.com/v1/apps")).toBeNull();
    expect(dashboardStoreOf("https://addons.mozilla.org/firefox/addon/pii-shield/")).toBeNull();
    expect(dashboardStoreOf("https://chromewebstore.google.com/detail/abc")).toBeNull();
    expect(dashboardStoreOf("https://acme.extension.dev/widget/builds/abc1234")).toBeNull();
  });

  it("901: knows Partner Center and App Store Connect only on the paths the product opens, read as the browser reads them", () => {
    const edge = { store: "edge", host: "partner.microsoft.com" };
    const safari = { store: "safari", host: "appstoreconnect.apple.com" };

    for (const page of ["https://partner.microsoft.com/dashboard/microsoftedge/publishapi", "https://partner.microsoft.com/dashboard/microsoftedge/overview", "https://partner.microsoft.com/dashboard/microsoftedge/903d21e4-0e5b-4507-95f2-4620fcf06f1c/packages/dashboard", "https://partner.microsoft.com/dashboard/microsoftedge", "https://PARTNER.microsoft.com/dashboard/microsoftedge/overview"]) {
      expect(dashboardStoreOf(page), page).toEqual(edge);
    }

    for (const page of ["https://appstoreconnect.apple.com/apps", "https://appstoreconnect.apple.com/apps/6826223107/distribution", "https://appstoreconnect.apple.com/access/integrations/api", "https://appstoreconnect.apple.com/access/integrations/api/"]) {
      expect(dashboardStoreOf(page), page).toEqual(safari);
    }

    for (const page of [
      "https://partner.microsoft.com",
      "https://partner.microsoft.com/",
      "https://partner.microsoft.com/dashboard",
      "https://partner.microsoft.com/dashboard/home",
      "https://partner.microsoft.com/dashboard/microsoftedgex",
      "https://partner.microsoft.com/redirect?url=https://example.test/dashboard/microsoftedge",
      "https://partner.microsoft.com//example.test/dashboard/microsoftedge",
      "https://partner.microsoft.com/go/dashboard/microsoftedge/overview",
      "https://partner.microsoft.com/dashboard/microsoftedge/../../redirect?url=https://example.test",
      "https://partner.microsoft.com/dashboard/microsoftedge/%2e%2e/%2E%2E/redirect",
      "https://partner.microsoft.com/dashboard/microsoftedge/..%2f..%2fredirect",
      "https://partner.microsoft.com/dashboard/microsoftedge/..%5C..%5Credirect",
      "https://partner.microsoft.com/dashboard/microsoftedge\\..\\..\\redirect",
      "https://partner.microsoft.com/dashboard%2Fmicrosoftedge/overview",
      "https://partner.microsoft.com/dashboard/\tmicrosoftedge/../../redirect",
      "https://partner.microsoft.com:8443/dashboard/microsoftedge/overview",
      "https://partner.microsoft.com.example.test/dashboard/microsoftedge/overview",
      "https://partner.microsoft.com@example.test/dashboard/microsoftedge/overview",
      "https://example.test/#https://partner.microsoft.com/dashboard/microsoftedge/overview",
      "http://partner.microsoft.com/dashboard/microsoftedge/overview",
      "https://appstoreconnect.apple.com",
      "https://appstoreconnect.apple.com/",
      "https://appstoreconnect.apple.com/login?targetUrl=https://example.test/apps",
      "https://appstoreconnect.apple.com/appsx",
      "https://appstoreconnect.apple.com/access/users",
      "https://appstoreconnect.apple.com/access/integrations",
      "https://appstoreconnect.apple.com/apps/../login?targetUrl=https://example.test",
      "https://appstoreconnect.apple.com/apps/%2e%2e/login",
      "https://appstoreconnect.apple.com/apps/..%2Flogin",
      "https://appstoreconnect.apple.com/apps\\..\\login",
      "https://appstoreconnect.apple.com//example.test/apps",
      "https://chrome.google.com/webstore/devconsole/../../url?q=https://example.test",
      "https://chrome.google.com/webstore/devconsole/..%2f..%2furl",
      "https://addons.mozilla.org/developers/../firefox/addon/x/",
      "https://addons.mozilla.org/developers/%2e%2e/firefox/addon/x/",
      "not an address",
    ]) {
      expect(dashboardStoreOf(page), page).toBeNull();
    }

    expect(dashboardStoreOf("https://chrome.google.com/webstore/devconsole/<publisherId>/<itemId>/edit")).toEqual({ store: "chrome", host: "chrome.google.com" });
    expect(dashboardStoreOf("https://chrome.google.com/webstore/devconsole")).toEqual({ store: "chrome", host: "chrome.google.com" });
    expect(dashboardStoreOf("https://addons.mozilla.org/developers/addon/api/key/")).toEqual({ store: "firefox", host: "addons.mozilla.org" });
  });

  it("counts an answer carrying a composed address, naming the tool, the status, the stores and the hosts", async () => {
    const productPage = composedDashboardUrl("https://partner.microsoft.com/dashboard/microsoftedge/prod-123/packages/dashboard");
    const keyPage = composedDashboardUrl("https://appstoreconnect.apple.com/access/integrations/api");

    const properties = await meterComposedDashboardUrls(
      {
        command: "extension_submit",
        status: "store-not-ready",
        value: { partnerCenterUrl: productPage, nextStep: { url: keyPage } },
        hint: `Create the product once at ${productPage}.`,
      },
      capture,
    );

    expect(properties).toEqual({
      tool: "extension_submit",
      status: "store-not-ready",
      stores: "edge,safari",
      dashboard_hosts: "partner.microsoft.com,appstoreconnect.apple.com",
      count: 2,
      composed_by: "mcp",
    });

    expect(sent).toEqual([{ event: DASHBOARD_URL_COMPOSED_EVENT, properties }]);
  });

  it("counts nothing for a dashboard address the platform sent, even one the composed address prefixes", async () => {
    const newItem = itemLinkUrls([], "https://console.extension.dev/acme/widget/settings");
    const received = `${newItem.newItemUrl}/pub-1/item-1/edit`;

    const properties = await meterComposedDashboardUrls(
      { command: "extension_submit", status: "preflight", value: { dashboardUrl: received, itemUrl: received }, hint: `The item's dashboard is ${received}.` },
      capture,
    );

    expect(properties).toBeNull();
    expect(sent).toEqual([]);
  });

  it("counts a composed address said at the end of a sentence and ignores an answer with no address", async () => {
    const keyPage = AMO_API_KEY_PAGE;

    const inSentence = await meterComposedDashboardUrls({ command: "extension_submit", status: "store-not-connected", hint: `Mozilla issues the two values once at ${keyPage}: the JWT issuer and the JWT secret.` }, capture);
    const none = await meterComposedDashboardUrls({ command: "extension_builds", status: "listed", value: { builds: [], buildsPageUrl: "https://console.extension.dev/acme/widget/builds" } }, capture);

    expect(inSentence).toMatchObject({ stores: "firefox", dashboard_hosts: "addons.mozilla.org", count: 1 });
    expect(none).toBeNull();
    expect(sent).toHaveLength(1);
  });

  it("counts the Chrome dashboard address form a store settings refusal names in its sentence", async () => {
    const form = "https://chrome.google.com/webstore/devconsole/<publisherId>/<itemId>/edit";
    const read = readStoreSettingsChange("chrome", { publisherId: "not a publisher id!" });
    const problem = "problem" in read ? String(read.problem) : "";

    expect(problem).toContain(`dashboard address (${form}), or that address itself`);
    expect(composedDashboardUrls()).toContain(form);

    const properties = await meterComposedDashboardUrls(
      { command: "extension_submit", status: "bad-request", error: { code: "E_BAD_REQUEST", name: "StoreSettingsInputError", message: problem } },
      capture,
    );

    expect(properties).toMatchObject({ tool: "extension_submit", status: "bad-request", stores: "chrome", dashboard_hosts: "chrome.google.com", count: 1 });
  });

  it("fires one PostHog event through the funnel channel from the envelope itself, and none while telemetry is off", async () => {
    process.env.EXTENSION_DEV_POSTHOG_KEY_NONPRODUCTION = "phc_test_only";
    process.env.EXTENSION_DEV_API_URL = "http://127.0.0.1:3100";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: { body?: string }) => {
        posted.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);

        return new Response("{}", { status: 200 });
      }),
    );

    const keyPage = composedDashboardUrl("https://partner.microsoft.com/dashboard/microsoftedge/publishapi");
    const out = JSON.parse(envelope({ ok: true, command: "extension_submit", status: "connect-pending", value: { storeKeyUrl: keyPage } }));

    await vi.waitFor(() => expect(posted).toHaveLength(1));

    expect(out.value.storeKeyUrl).toBe(keyPage);
    expect(posted[0]).toMatchObject({
      event: DASHBOARD_URL_COMPOSED_EVENT,
      properties: { tool: "extension_submit", status: "connect-pending", stores: "edge", dashboard_hosts: "partner.microsoft.com", count: 1, composed_by: "mcp", source: "@extension.dev/mcp", emitted_from: "node" },
    });

    process.env.DO_NOT_TRACK = "1";
    envelope({ ok: true, command: "extension_submit", status: "connect-pending", value: { storeKeyUrl: keyPage } });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(posted).toHaveLength(1);
  });

  it("827: keeps an address composed during a call for that call only, and still counts it in that call's answer", async () => {
    const item = { publisherId: "a1b2c3d4-0000-4000-8000-000000000827", itemId: "abcdefghijklmnopabcdefghijklmnop" };
    const first = await withCallMemory(undefined, async () => {
      const url = chromeItemUrl(item);
      const counted = await meterComposedDashboardUrls({ command: "extension_submit", status: "submitted", value: { url } }, capture);

      return { url, counted, known: composedDashboardUrls() };
    });

    expect(first.result.url).toContain(item.itemId);
    expect(first.result.counted).toMatchObject({ stores: "chrome", count: 1 });
    expect(first.result.known).toContain(first.result.url);
    expect(first.memory).toEqual({});
    expect(composedDashboardUrls()).not.toContain(first.result.url);
    expect(composedDashboardUrls()).toContain(AMO_API_KEY_PAGE);

    const second = await withCallMemory(undefined, async () => ({
      known: composedDashboardUrls(),
      counted: await meterComposedDashboardUrls({ command: "extension_submit", status: "submitted", value: { url: first.result.url } }, capture),
    }));

    expect(second.result.known).not.toContain(first.result.url);
    expect(second.result.counted).toBeNull();
  });

  it("827: a shelf read under a hosted request and outside a call throws by name, and a person's own machine keeps its module shelf", async () => {
    const isText = (value: unknown): value is string => typeof value === "string";
    const hosted = { token: "tok", api: "https://www.extension.dev", projects: [], expiresAt: null };

    memoryShelf("build-dispatches", isText).set("mine", "kept");

    expect(memoryShelf("build-dispatches", isText).get("mine")).toBe("kept");

    await withRequestCredential(hosted, async () => {
      expect(() => memoryShelf("build-dispatches", isText)).toThrow(/"build-dispatches" shelf was read outside a call/);
      expect(() => scratchShelf("create-sessions")).toThrow(/"create-sessions" shelf was read outside a call/);

      const inside = await withCallMemory(undefined, async () => {
        scratchShelf<string>("create-sessions").set("a", "b");

        return [...memoryShelf("build-dispatches", isText).set("k", "v").keys()];
      });

      expect(inside.result).toEqual(["k"]);
      expect(inside.memory).toEqual({ "build-dispatches": [["k", "v"]] });
    });
  });
});
