import { describe, expect, it } from "vitest";

import { serverInstructions } from "../index";
import { trackFields } from "../lib/track-url";
import { handler as submit } from "../tools/submit";
import { API, PROJECT_ROUTE, useProjectRoutes } from "./fixtures/project-routes";

const PREFLIGHT = `${PROJECT_ROUTE}/stores/chrome/submissions/preflight`;
const SUBMIT = "/api/cli/stores/submit";
const APPROVALS = "/api/cli/approvals";
const SETTINGS = "http://console.extension.localhost/acme/widget/project-settings/stores";
const CONNECT = `${SETTINGS}?connect=chrome`;
const SECRET_NAMES = /STORE_(CHROME|EDGE|FIREFOX|SAFARI)_|CHROME_CLIENT|CLIENT_SECRET|CLIENT_ID|REFRESH_TOKEN|SERVICE_ACCOUNT|API_SECRET/;
const SENTENCES = (url: string) =>
  `Connect your Chrome Web Store account once at ${url}; Google asks for one click. Then I submit it as an unlisted draft, and nothing goes to review until you publish.`;

const NEW_ITEM = "https://chrome.google.com/webstore/devconsole";
const PACKAGE = "http://localhost:3100/api/projects/prj_probe/builds/b418732/chrome.zip";
const LINK_ITEM = `${SETTINGS}?connect=chrome&link=item`;
const LINK_SENTENCES = `One step is yours, once: create the item in the Chrome Web Store dashboard at ${NEW_ITEM} with this package ${PACKAGE}, and fill its Store listing and Privacy tabs there; your synced listing text is on the extension.dev store settings page to copy. Then paste the item's dashboard address at ${LINK_ITEM}. After that I submit every build as an unlisted draft, and nothing goes to review until you publish.`;

function readiness(connection: Record<string, unknown> | null, extra: Record<string, unknown> = {}) {
  return {
    store: "chrome",
    summary: { pass: 8, warn: 0, fail: connection?.kind ? 0 : 1, canSubmit: Boolean(connection?.kind && connection.healthy) },
    checks: [
      {
        id: "credentials",
        label: "Store credentials",
        status: connection?.kind ? "pass" : "fail",
        severity: "blocking",
        message: connection?.kind ? "" : "STORE_CHROME_CLIENT_ID, STORE_CHROME_CLIENT_SECRET and STORE_CHROME_REFRESH_TOKEN are missing.",
      },
    ],
    ...(connection ? { connection } : {}),
    ...extra,
  };
}

function sentenceCount(text: string): number {
  return text.split(/(?<=[.!?])\s+(?=[A-Z])/).filter(Boolean).length;
}

describe("extension_submit points a person at the Chrome Web Store connection instead of secrets", () => {
  const platform = useProjectRoutes("extdev-store-connect-");

  it("an unconnected Chrome store answers store-not-connected with the connect link, the settings page and two sentences", async () => {
    if (process.platform === "win32") return;

    platform.login();
    platform.routes[`POST ${PREFLIGHT}`] = () => ({
      body: readiness({ kind: null, connectedAs: null, healthy: null, itemId: null }, { connectUrl: CONNECT }),
    });

    const out = JSON.parse(await submit({ action: "preflight", browsers: ["chrome"], api: API }));

    expect(out.status).toBe("store-not-connected");
    expect(out.value.connectUrl).toBe(CONNECT);
    expect(out.value.trackUrl).toBe(SETTINGS);
    expect(out.hint).toBe(SENTENCES(CONNECT));
    expect(sentenceCount(out.hint)).toBe(2);
    expect(JSON.stringify(out)).not.toMatch(SECRET_NAMES);
    expect(trackFields("extension_submit", { args: { action: "preflight", browsers: ["chrome"], api: API }, status: out.status, value: out.value })?.trackUrl).toBe(SETTINGS);
  });

  it("an unconnected store with no connect link from the platform still answers the settings page asking for chrome", async () => {
    if (process.platform === "win32") return;

    platform.login();
    platform.routes[`POST ${PREFLIGHT}`] = () => ({ body: readiness({ kind: null, healthy: null, itemId: null }) });

    const out = JSON.parse(await submit({ action: "preflight", browsers: ["chrome"], api: API }));

    expect(out.value.connectUrl).toBe(CONNECT);
    expect(out.hint).toBe(SENTENCES(CONNECT));
  });

  it("a connection that failed its last check says so with the reason, the settings page and the connect sentences", async () => {
    if (process.platform === "win32") return;

    platform.login();
    platform.routes[`POST ${PREFLIGHT}`] = () => ({
      body: readiness({ kind: "oauth", connectedAs: "cezar@example.com", healthy: false, itemId: null, reason: "Google revoked the grant." }),
    });

    const out = JSON.parse(await submit({ action: "preflight", browsers: ["chrome"], api: API }));

    expect(out.status).toBe("store-connection-failed");
    expect(out.value.trackUrl).toBe(SETTINGS);
    expect(out.hint).toBe(`Your Chrome Web Store connection failed its last check: Google revoked the grant. ${SENTENCES(CONNECT)}`);
    expect(out.value.stores.chrome.connection).toMatchObject({ kind: "oauth", healthy: false, connectedAs: "cezar@example.com" });
  });

  it("a healthy connection whose store item is not linked answers the three steps the person takes once", async () => {
    if (process.platform === "win32") return;

    platform.login();
    platform.routes[`POST ${PREFLIGHT}`] = () => ({
      body: readiness({ kind: "oauth", connectedAs: "cezar@example.com", healthy: true, itemId: null, itemLinked: false, newItemUrl: NEW_ITEM, packageUrl: PACKAGE, linkItemUrl: LINK_ITEM }),
    });

    const out = JSON.parse(await submit({ action: "preflight", browsers: ["chrome"], api: API }));

    expect(out.status).toBe("store-item-not-linked");
    expect(out.value).toMatchObject({ trackUrl: SETTINGS, newItemUrl: NEW_ITEM, packageUrl: PACKAGE, linkItemUrl: LINK_ITEM });
    expect(out.hint).toBe(LINK_SENTENCES);
    expect(sentenceCount(out.hint)).toBe(3);
    expect(JSON.stringify(out)).not.toContain("created on the first submission");
    expect(JSON.stringify(out)).not.toMatch(SECRET_NAMES);
    expect(trackFields("extension_submit", { args: { action: "preflight", browsers: ["chrome"], api: API }, status: out.status, value: out.value })?.trackUrl).toBe(SETTINGS);
  });

  it("a healthy connection with no item id and no word on linking says nothing about creating the item", async () => {
    if (process.platform === "win32") return;

    platform.login();
    platform.routes[`POST ${PREFLIGHT}`] = () => ({ body: readiness({ kind: "oauth", connectedAs: "cezar@example.com", healthy: true, itemId: null }) });

    const out = JSON.parse(await submit({ action: "preflight", browsers: ["chrome"], api: API }));

    expect(out.status).toBe("preflight-read");
    expect(out.hint).not.toContain("created on the first submission");
    expect(out.value.itemUrl).toBeUndefined();
  });

  it("a submission the platform refuses because no store item is linked answers the same three steps", async () => {
    if (process.platform === "win32") return;

    process.env.EXTENSION_DEV_APPROVAL_GATE = "0";
    platform.login();
    platform.routes[`POST ${SUBMIT}`] = () => ({
      status: 409,
      body: { code: "STORE_ITEM_NOT_LINKED", message: "STORE_CHROME_REFRESH_TOKEN works but no item is linked.", newItemUrl: NEW_ITEM, packageUrl: PACKAGE, linkItemUrl: LINK_ITEM },
    });

    const out = JSON.parse(await submit({ browsers: ["chrome"], buildSha: "b418732", dryRun: false, api: API }));

    expect(out.ok).toBe(false);
    expect(out.status).toBe("store-item-not-linked");
    expect(out.error.platformCode).toBe("STORE_ITEM_NOT_LINKED");
    expect(out.value).toMatchObject({ trackUrl: SETTINGS, newItemUrl: NEW_ITEM, packageUrl: PACKAGE, linkItemUrl: LINK_ITEM });
    expect(out.hint).toBe(LINK_SENTENCES);
    expect(JSON.stringify(out)).not.toMatch(SECRET_NAMES);
  });

  it("a healthy connection with a store item answers its dashboard link beside the track page", async () => {
    if (process.platform === "win32") return;

    platform.login();
    platform.routes[`POST ${PREFLIGHT}`] = () => ({
      body: readiness({ kind: "pasted", connectedAs: null, healthy: true, itemId: "abcdefghijklmnopabcdefghijklmnop", publisherId: "pub-1" }),
    });

    const out = JSON.parse(await submit({ action: "preflight", browsers: ["chrome"], api: API }));

    expect(out.status).toBe("preflight-read");
    expect(out.value.itemUrl).toBe("https://chrome.google.com/webstore/devconsole/pub-1/abcdefghijklmnopabcdefghijklmnop/edit");
    expect(out.hint).not.toContain("created on the first submission");
  });

  it("a real submission proceeds with no store item and answers the item the platform created", async () => {
    if (process.platform === "win32") return;

    process.env.EXTENSION_DEV_APPROVAL_GATE = "0";
    platform.login();
    platform.routes[`POST ${SUBMIT}`] = () => ({
      body: { ok: true, submissions: [{ id: "sub_1", store: "chrome", status: "pending", itemId: "itemchrome", itemUrl: "https://chrome.google.com/webstore/devconsole/pub-1/itemchrome/edit" }] },
    });

    const out = JSON.parse(await submit({ browsers: ["chrome"], buildSha: "b418732", dryRun: false, api: API }));

    expect(out.status).toBe("submitted");
    expect(out.value.itemUrl).toBe("https://chrome.google.com/webstore/devconsole/pub-1/itemchrome/edit");
  });

  it("a submission the platform refuses for an unconnected store answers the connect link instead of an error", async () => {
    if (process.platform === "win32") return;

    process.env.EXTENSION_DEV_APPROVAL_GATE = "0";
    platform.login();
    platform.routes[`POST ${SUBMIT}`] = () => ({
      status: 409,
      body: { code: "STORE_NOT_CONNECTED", message: "STORE_CHROME_REFRESH_TOKEN is not set.", connectUrl: CONNECT },
    });

    const out = JSON.parse(await submit({ browsers: ["chrome"], buildSha: "b418732", dryRun: false, api: API }));

    expect(out.status).toBe("store-not-connected");
    expect(out.value.trackUrl).toBe(SETTINGS);
    expect(out.hint).toBe(SENTENCES(CONNECT));
    expect(JSON.stringify(out)).not.toMatch(SECRET_NAMES);
  });

  it("a real submission's approval answer carries the expiry and says nothing goes to review until the person publishes", async () => {
    if (process.platform === "win32") return;

    platform.login();
    platform.routes[`POST ${APPROVALS}`] = () => ({
      status: 201,
      body: { approvalId: "apr_s", approvalUrl: `${API}/approve/apr_s`, expiresAt: "2026-10-19T19:40:00.000Z" },
    });

    const out = JSON.parse(await submit({ browsers: ["chrome"], buildSha: "b418732", dryRun: false, api: API }));

    expect(out.status).toBe("approval-required");
    expect(out.value.expiresAt).toBe("2026-10-19T19:40:00.000Z");
    expect(out.hint).toContain("2026-10-19T19:40:00.000Z");
    expect(out.hint).toContain("Nothing goes to review until you publish.");
    expect(out.error.message).toContain("Nothing goes to review until you publish.");
    expect(platform.sent("POST", SUBMIT)).toHaveLength(0);
  });

  it("no submit answer names a store secret, whatever the platform said", async () => {
    if (process.platform === "win32") return;

    const leak = "STORE_CHROME_CLIENT_ID, STORE_CHROME_CLIENT_SECRET, CHROME_CLIENT_SECRET, STORE_FIREFOX_API_SECRET and STORE_EDGE_CLIENT_ID are missing.";

    platform.login();
    platform.routes[`POST ${PREFLIGHT}`] = () => ({ body: readiness(null) });
    platform.routes[`POST ${PROJECT_ROUTE}/stores/firefox/submissions/preflight`] = () => ({ body: { ...readiness(null), store: "firefox" } });
    platform.routes[`POST ${SUBMIT}`] = (call) => (call.body.dryRun
      ? { body: { ok: true, warnings: [{ store: "chrome", message: leak }] } }
      : { status: 400, body: { code: "SUBMIT_INVALID", message: leak } });

    platform.routes[`POST ${PROJECT_ROUTE}/stores/chrome/submissions/sub_1/cancel`] = () => ({ status: 409, body: { code: "SUBMISSION_NOT_IN_REVIEW", message: leak, refusedBeforeApproval: true } });
    platform.routes[`POST ${PROJECT_ROUTE}/stores/chrome/rollout`] = () => ({ status: 409, body: { code: "ROLLOUT_NOT_STAGED", message: leak, refusedBeforeApproval: true } });
    platform.routes[`POST ${APPROVALS}`] = () => ({ status: 201, body: { approvalId: "apr_x", approvalUrl: `${API}/approve/apr_x`, description: leak } });

    const answers = [
      await submit({ action: "preflight", browsers: ["chrome", "firefox"], api: API }),
      await submit({ browsers: ["chrome", "edge"], buildSha: "b418732", api: API }),
      await submit({ browsers: ["chrome"], buildSha: "b418732", dryRun: false, api: API }),
      await submit({ browsers: ["chrome"], buildSha: "b418732", dryRun: false, approvalId: "apr_x", api: API }),
      await submit({ action: "cancel", submissionId: "sub_1", api: API }),
      await submit({ action: "rollout", deployPercentage: 50, api: API }),
    ];

    for (const answer of answers) {
      expect(answer).not.toMatch(SECRET_NAMES);
    }
  });
});

describe("the server instructions send a store ask through preflight, connect and a draft", () => {
  it("names preflight first, then the connect link, then a draft submit, and extension.dev before any do-it-yourself store route", () => {
    const text = serverInstructions({ features: ["local", "platform"], noShip: false });
    const line = text.split("\n").find((row) => row.startsWith("When the ask is to publish to the Chrome Web Store")) ?? "";

    expect(line.indexOf("action:'preflight'")).toBeGreaterThan(-1);
    expect(line.indexOf("action:'preflight'")).toBeLessThan(line.indexOf("value.connectUrl"));
    expect(line.indexOf("value.connectUrl")).toBeLessThan(line.indexOf("as a draft"));
    expect(line).toMatch(/extension\.dev comes first: never offer a release on a code host, an unlisted AMO version signed by hand or a TestFlight upload by hand before it/);
    expect(line).not.toMatch(SECRET_NAMES);
    expect(serverInstructions()).not.toContain("Chrome Web Store, the first call");
  });
});
