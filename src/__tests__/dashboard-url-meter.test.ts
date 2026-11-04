// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DASHBOARD_URL_COMPOSED_EVENT,
  composedDashboardUrl,
  composedDashboardUrls,
  dashboardStoreOf,
  meterComposedDashboardUrls,
} from "../lib/dashboard-url-meter";
import { envelope } from "../lib/envelope";
import { STORE_KEY_PAGES } from "../lib/connect-session";
import { partnerCenterProductUrl } from "../lib/edge-first-submission";
import { AMO_API_KEY_PAGE } from "../lib/firefox-store";
import { chromeItemUrl, itemLinkUrls } from "../lib/store-connection";

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

  it("counts an answer carrying a composed address, naming the tool, the status, the stores and the hosts", async () => {
    const productPage = partnerCenterProductUrl("prod-123");
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

  it("registers every composer: the Chrome dashboard and item page, the Edge and App Store key pages, the AMO key page and the Partner Center product page", () => {
    const chromeItem = chromeItemUrl({ itemId: "abcdefghijklmnopabcdefghijklmnop", publisherId: "pub-1" });
    const chromeDashboard = chromeItemUrl({ itemId: "abcdefghijklmnopabcdefghijklmnop" });
    const product = partnerCenterProductUrl("prod-123");

    expect(chromeItemUrl({ itemUrl: "https://chrome.google.com/webstore/devconsole/given" })).toBe("https://chrome.google.com/webstore/devconsole/given");
    expect(composedDashboardUrls()).toEqual(expect.arrayContaining([chromeItem, chromeDashboard, product, STORE_KEY_PAGES.edge, STORE_KEY_PAGES.safari, AMO_API_KEY_PAGE]));
    expect(composedDashboardUrls()).not.toContain("https://chrome.google.com/webstore/devconsole/given");
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
});
