import { describe, expect, it } from "vitest";

import { actionFingerprint } from "../lib/approval-gate";
import { approvalVerdict } from "../lib/approval-policy";
import { STORE_SETTINGS_ACTION, modeToPatch, readStoreSettingsChange, storeSettingsDigest } from "../lib/store-settings";
import { TOOL_POLICY } from "../lib/tool-policy";
import { handler as submit, schema } from "../tools/submit";
import { API, PROJECT_ROUTE, useProjectRoutes } from "./fixtures/project-routes";

const CONFIG = `${PROJECT_ROUTE}/stores/config`;
const APPROVALS = "/api/cli/approvals";
const SETTINGS_PAGE = /\/acme\/widget\/project-settings\/stores$/;

const FIREFOX_PATCH = { enabled: true, sourceArchive: "repository" };

function scopeFor(store: "chrome" | "firefox" | "edge" | "safari", patch: Record<string, unknown>) {
  return { store, settingsDigest: storeSettingsDigest(store, patch) };
}

function approvalRequired(scope: Record<string, string>, fingerprint = actionFingerprint(STORE_SETTINGS_ACTION, scope)) {
  return {
    status: 403,
    body: { code: "APPROVAL_REQUIRED", message: "Needs an owner's approval.", approvalRequest: { action: STORE_SETTINGS_ACTION, scope, fingerprint } },
  };
}

describe("extension_submit configure-store changes a store's settings as a plain call under the owner's token and never takes a credential", () => {
  const platform = useProjectRoutes("extdev-store-configure-");

  it("offers configure-store with a storeSettings input, and it is a settings write, not a shipping act", () => {
    expect(schema.inputSchema.properties.action.enum).toContain("configure-store");
    expect(Object.keys((schema.inputSchema.properties as Record<string, any>).storeSettings.properties)).toEqual([
      "enabled",
      "submissionMode",
      "sourceArchive",
      "releaseChannel",
      "chromeItemId",
      "publisherId",
      "edgeProductId",
      "firefoxAddonGuid",
      "appStoreId",
      "bundleId",
      "firstSubmitted",
      "storeUrl",
    ]);

    for (const property of Object.values((schema.inputSchema.properties as Record<string, any>).storeSettings.properties) as Array<{ description?: string }>) {
      expect(typeof property.description).toBe("string");
    }

    expect((schema.inputSchema.properties as Record<string, any>).store.description).toContain("configure-store");

    const ships = TOOL_POLICY.extension_submit.ships as (args: Record<string, unknown>) => boolean;

    expect(ships({ action: "configure-store" })).toBe(false);
    expect(approvalVerdict(STORE_SETTINGS_ACTION)).toBe("plain");
    expect(approvalVerdict(STORE_SETTINGS_ACTION, { submissionMode: "listed" })).toBe("approval");
  });

  it("applies a plain change with an owner's token and no approval id, minting nothing and reading no approval", async () => {
    if (process.platform === "win32") return;

    platform.login();
    platform.routes[`PUT ${CONFIG}`] = () => ({ body: { ok: true, store: "firefox", changes: ["firefox: enable store publishing", 'firefox.sourceArchive: "none" -> "repository"'] } });

    const out = JSON.parse(await submit({ action: "configure-store", store: "firefox", storeSettings: FIREFOX_PATCH, api: API }));
    const puts = platform.sent("PUT", CONFIG);

    expect(puts).toHaveLength(1);
    expect(puts[0].body).toEqual({ firefox: FIREFOX_PATCH });
    expect(out.ok).toBe(true);
    expect(out.status).toBe("store-configured");
    expect(out.value).toMatchObject({
      action: "configure-store",
      store: "firefox",
      project: "acme/widget",
      changes: ["firefox: enable store publishing", 'firefox.sourceArchive: "none" -> "repository"'],
    });

    expect(out.value.trackUrl).toMatch(SETTINGS_PAGE);
    expect(out.value.nextStep.kind).toBe("preflight");
    expect(out.hint).toContain("no approval page was involved");
    expect(platform.calls.some((call) => call.path.startsWith(APPROVALS))).toBe(false);
  });

  it("is refused OWNER_REQUIRED when the token's minter is not an owner, before any approval is asked", async () => {
    if (process.platform === "win32") return;

    platform.login();
    platform.routes[`PUT ${CONFIG}`] = () => ({
      status: 403,
      body: { code: "OWNER_REQUIRED", message: "Changing store settings with a token is a workspace owner action, and this token was minted by an account that is not an owner of this workspace." },
    });

    const out = JSON.parse(await submit({ action: "configure-store", store: "firefox", storeSettings: FIREFOX_PATCH, api: API }));

    expect(out.ok).toBe(false);
    expect(out.error.platformCode).toBe("OWNER_REQUIRED");
    expect(platform.calls.some((call) => call.path.startsWith(APPROVALS))).toBe(false);
  });

  it("keeps a listed submission mode on the approve page: the platform asks, the approval names the audience change, and nothing is written", async () => {
    if (process.platform === "win32") return;

    platform.login();
    const patch = { dryRun: false, releaseChannel: "listed" };
    const scope = scopeFor("firefox", patch);
    platform.routes[`PUT ${CONFIG}`] = () => approvalRequired(scope);
    platform.routes[`POST ${APPROVALS}`] = () => ({
      status: 201,
      body: { approvalId: "apr_listed", approvalUrl: `${API}/device/approve/apr_listed`, changes: ['firefox.releaseChannel: "unlisted" -> "listed"'] },
    });

    const out = JSON.parse(await submit({ action: "configure-store", store: "firefox", storeSettings: { submissionMode: "listed" }, api: API }));
    const [post] = platform.sent("POST", APPROVALS);

    expect(post.body).toMatchObject({ action: STORE_SETTINGS_ACTION, scope, storeSettings: { firefox: patch } });
    expect(out.ok).toBe(false);
    expect(out.status).toBe("approval-required");
    expect(out.value).toMatchObject({ approvalId: "apr_listed", changes: ['firefox.releaseChannel: "unlisted" -> "listed"'] });
    expect(out.error.message).toContain("changes who can find the extension");
    expect(platform.sent("PUT", CONFIG)).toHaveLength(1);
  });

  it("refuses a storeSettings key that names a credential before any request, with the console connect page and the form's labels", async () => {
    platform.login();

    const out = JSON.parse(await submit({ action: "configure-store", store: "firefox", storeSettings: { jwtIssuer: "user:1:2", jwtSecret: "abc" }, api: API }));

    expect(out.ok).toBe(false);
    expect(out.status).toBe("credentials-console-only");
    expect(out.error.name).toBe("StoreCredentialsConsoleOnly");
    expect(out.value.refusedKeys).toEqual(["jwtIssuer", "jwtSecret"]);
    expect(out.value.connectUrl).toMatch(/\/acme\/widget\/project-settings\/stores\?connect=firefox$/);
    expect(out.value.trackUrl).toMatch(SETTINGS_PAGE);
    expect(out.value.workspaceStoreAccountsUrl).toMatch(/\/acme\/settings\/store-accounts$/);
    expect(out.value.nextStep).toMatchObject({ kind: "connect", url: out.value.workspaceStoreAccountsUrl });
    expect(out.hint).toContain("once for the whole workspace on its Store accounts page");
    expect(out.hint).toContain("the JWT issuer and the JWT secret, as the console form labels them");
    expect(out.hint).toContain("https://addons.mozilla.org/developers/addon/api/key/");
    expect(JSON.stringify(out)).not.toMatch(/STORE_|AMO_|FIREFOX_JWT|abc|user:1:2/);
    expect(platform.calls).toHaveLength(0);
  });

  it("names the Chrome connect, the Edge Publish API fields and the three App Store Connect values for the other stores", async () => {
    platform.login();

    const chrome = JSON.parse(await submit({ action: "configure-store", store: "chrome", storeSettings: { refreshToken: "x" }, api: API }));
    const edge = JSON.parse(await submit({ action: "configure-store", store: "edge", storeSettings: { clientId: "x" }, api: API }));
    const safari = JSON.parse(await submit({ action: "configure-store", store: "safari", storeSettings: { ascKeyP8: "x" }, api: API }));

    expect(chrome.hint).toContain("Connect Chrome Web Store");
    expect(edge.hint).toContain("the Publish API Client ID, the Publish API key and the Product ID (GUID)");
    expect(safari.hint).toContain("the App Store Connect issuer ID, the App Store Connect key ID and the App Store Connect private key (.p8)");
    expect([chrome, edge, safari].every((out) => out.status === "credentials-console-only")).toBe(true);
    expect(platform.calls).toHaveLength(0);
  });

  it("refuses a listing id, a raw mode flag, an unknown key, a foreign mode id and a Firefox-only key before any request", async () => {
    platform.login();
    const cases: Array<[string, Record<string, unknown>, RegExp]> = [
      ["firefox", { storeId: "{abc}" }, /"storeId".*a listing id goes in as chromeItemId, edgeProductId, firefoxAddonGuid or appStoreId.*stay a person at a keyboard in the console/],
      ["edge", { publisherId: "acme" }, /"publisherId" is a chrome store setting; edge does not have it/],
      ["chrome", { publisherId: "not a publisher!" }, /publisherId must be the Chrome Web Store publisher id, the token after \/devconsole\/ in the item's dashboard address/],
      ["chrome", { storeUrl: "https://chromewebstore.google.com/detail/abcdefghijklmnopabcdefghijklmnop" }, /storeUrl for chrome must be the item's address from the Chrome Web Store developer dashboard/],
      ["chrome", { chromeItemId: "abcdefghijklmnopabcdefghijklmnop", storeUrl: "https://chrome.google.com/webstore/devconsole/pub-1/bbcdefghijklmnopabcdefghijklmnop/edit" }, /names item bbcdefghijklmnopabcdefghijklmnop and chromeItemId names abcdefghijklmnopabcdefghijklmnop; pass one of them/],
      ["chrome", { publisherId: "pub-2", storeUrl: "https://chrome.google.com/webstore/devconsole/pub-1/bbcdefghijklmnopabcdefghijklmnop/edit" }, /names publisher pub-1 and publisherId names pub-2; pass one of them/],
      ["chrome", { bundleId: "com.acme.widget" }, /"bundleId" is a safari store setting; chrome does not have it/],
      ["safari", { bundleId: "widget" }, /bundleId must be a reverse-DNS identifier with two or more labels/],
      ["safari", { appStoreId: "id6826486337" }, /appStoreId must be the App Store id of the app record: the 6 to 15 digit Apple ID/],
      ["chrome", { appStoreId: "6826486337" }, /"appStoreId" is a safari store setting; chrome does not have it/],
      ["chrome", { skipPublish: true }, /"skipPublish".*console/],
      ["chrome", { foo: 1 }, /"foo", which is not a store setting; use enabled, submissionMode, sourceArchive, releaseChannel, chromeItemId, edgeProductId, firefoxAddonGuid/],
      ["firefox", { chromeItemId: "abcdefghijklmnopabcdefghijklmnop" }, /"chromeItemId" is a chrome store setting; firefox does not have it/],
      ["chrome", { chromeItemId: "not-an-item" }, /chromeItemId must be the item's 32-letter id, or the item's address from the Chrome Web Store developer dashboard/],
      ["edge", { edgeProductId: "12345" }, /edgeProductId must be the Product ID GUID from Partner Center/],
      ["firefox", { firefoxAddonGuid: "my-addon-slug" }, /firefoxAddonGuid "my-addon-slug" is not a Firefox add-on GUID.*An AMO slug or numeric id does not identify the add-on to Mozilla's blocklist\./],
      ["firefox", { firefoxAddonGuid: "1234567" }, /An AMO slug or numeric id does not identify the add-on to Mozilla's blocklist\./],
      ["chrome", { submissionMode: "listed" }, /submissionMode for chrome must be one of draft-until-public, draft, public, staged, dry-run; got "listed"/],
      ["edge", { sourceArchive: "repository" }, /"sourceArchive" is a Firefox store setting; edge does not have it/],
      ["firefox", { enabled: "yes" }, /enabled must be true or false/],
      ["firefox", { submissionMode: "listed", releaseChannel: "unlisted" }, /name different Firefox channels/],
      ["firefox", {}, /must name at least one of/],
    ];

    for (const [store, storeSettings, message] of cases) {
      const out = JSON.parse(await submit({ action: "configure-store", store, storeSettings, api: API }));

      expect(out.status, JSON.stringify(storeSettings)).toBe("bad-request");
      expect(out.error.message, JSON.stringify(storeSettings)).toMatch(message);
    }

    const noStore = JSON.parse(await submit({ action: "configure-store", storeSettings: { enabled: true }, api: API }));

    expect(noStore.status).toBe("bad-request");
    expect(noStore.error.message).toContain("configure-store needs store");
    expect(platform.calls).toHaveLength(0);
  });

  it("writes a store's listing id as a plain owner-token write in the store's own terms, and hashes it last", async () => {
    if (process.platform === "win32") return;

    platform.login();
    const cases: Array<[string, Record<string, unknown>, string, string]> = [
      ["chrome", { chromeItemId: "ABCDEFGHIJKLMNOPABCDEFGHIJKLMNOP" }, "abcdefghijklmnopabcdefghijklmnop", "chromeItemId"],
      ["chrome", { chromeItemId: "https://chrome.google.com/webstore/devconsole/12345678-1234-1234-1234-123456789abc/abcdefghijklmnopabcdefghijklmnop/edit" }, "abcdefghijklmnopabcdefghijklmnop", "chromeItemId"],
      ["edge", { edgeProductId: "12345678-1234-1234-1234-123456789ABC" }, "12345678-1234-1234-1234-123456789abc", "edgeProductId"],
      ["firefox", { firefoxAddonGuid: "widget@example.com", enabled: true }, "widget@example.com", "firefoxAddonGuid"],
      ["firefox", { firefoxAddonGuid: "{11111111-2222-3333-4444-555555555555}" }, "{11111111-2222-3333-4444-555555555555}", "firefoxAddonGuid"],
    ];

    for (const [store, storeSettings, storeId, key] of cases) {
      platform.calls.length = 0;
      platform.routes[`PUT ${CONFIG}`] = (call) => ({ body: { ok: true, store, changes: [`${store}.storeId: "" -> "${call.body[store].storeId}"`] } });

      const out = JSON.parse(await submit({ action: "configure-store", store, storeSettings, api: API }));
      const [put] = platform.sent("PUT", CONFIG);

      expect(put.body[store].storeId, JSON.stringify(storeSettings)).toBe(storeId);
      expect(out.status, JSON.stringify(storeSettings)).toBe("store-configured");
      expect(out.value.storeSettings[key]).toBe(storeId);
      expect(out.value.changes).toEqual([`${store}.storeId: "" -> "${storeId}"`]);
      expect(out.hint).toContain("no approval page was involved");
      expect(platform.calls.some((call) => call.path.startsWith(APPROVALS))).toBe(false);
    }

    const scope = scopeFor("firefox", { enabled: true, storeId: "widget@example.com" });

    expect(scope.settingsDigest).toBe(
      storeSettingsDigest("firefox", { storeId: "widget@example.com", enabled: true }),
    );

    expect(scope.settingsDigest).not.toBe(storeSettingsDigest("firefox", { enabled: true }));
  });

  it("records the owner's word that the Edge product was submitted once in Partner Center as a plain write through the store config route", async () => {
    if (process.platform === "win32") return;

    platform.login();
    platform.routes[`PUT ${CONFIG}`] = () => ({ body: { ok: true, store: "edge", changes: ["edge.firstSubmitted: false -> true"] } });

    const out = JSON.parse(await submit({ action: "configure-store", store: "edge", storeSettings: { firstSubmitted: true }, api: API }));
    const puts = platform.sent("PUT", CONFIG);

    expect(puts).toHaveLength(1);
    expect(puts[0].body).toEqual({ edge: { firstSubmitted: true } });
    expect(out.status).toBe("store-configured");
    expect(out.value.storeSettings).toEqual({ firstSubmitted: true });
    expect(out.value.changes).toEqual(["edge.firstSubmitted: false -> true"]);
    expect(out.value.trackUrl).toMatch(SETTINGS_PAGE);
    expect(out.value.nextStep.kind).toBe("preflight");
    expect(out.hint).toContain("no approval page was involved");
    expect(platform.calls.some((call) => call.path.startsWith(APPROVALS))).toBe(false);
    expect(JSON.stringify(out)).not.toMatch(/extension-user-land|\/actions\/runs\//);
  });

  it("hashes firstSubmitted last, the bytes the platform hashes, and refuses it off Edge or as anything but a boolean", async () => {
    const { createHash } = await import("node:crypto");
    const platformBytes = JSON.stringify({ store: "edge", settings: { publishAfter: true, firstSubmitted: true } });

    expect(storeSettingsDigest("edge", { firstSubmitted: true, publishAfter: true })).toBe(
      createHash("sha256").update(platformBytes).digest("hex"),
    );

    expect(readStoreSettingsChange("edge", { firstSubmitted: false })).toEqual({ patch: { firstSubmitted: false }, requested: { firstSubmitted: false } });
    expect(readStoreSettingsChange("chrome", { firstSubmitted: true })).toEqual({ problem: '"firstSubmitted" is an edge store setting; chrome does not have it.' });
    expect(readStoreSettingsChange("edge", { firstSubmitted: "yes" })).toEqual({ problem: "storeSettings.firstSubmitted must be true or false." });
  });

  it("writes the Edge listing URL as the canonical crx id link through the store config route, hashing storeUrl last", async () => {
    if (process.platform === "win32") return;

    const crx = "abcdefghijklmnopabcdefghijklmnop";
    const canonical = `https://microsoftedge.microsoft.com/addons/detail/${crx}`;

    platform.login();
    platform.routes[`PUT ${CONFIG}`] = () => ({ body: { ok: true, store: "edge", changes: [`edge.storeUrl: "" -> "${canonical}"`] } });

    const out = JSON.parse(
      await submit({ action: "configure-store", store: "edge", storeSettings: { storeUrl: `https://microsoftedge.microsoft.com/addons/detail/rebeccat/${crx}` }, api: API }),
    );
    const puts = platform.sent("PUT", CONFIG);

    expect(puts).toHaveLength(1);
    expect(puts[0].body).toEqual({ edge: { storeUrl: canonical } });
    expect(out.status).toBe("store-configured");
    expect(out.value.storeSettings).toEqual({ storeUrl: canonical });
    expect(out.value.changes).toEqual([`edge.storeUrl: "" -> "${canonical}"`]);
    expect(platform.calls.some((call) => call.path.startsWith(APPROVALS))).toBe(false);

    const { createHash } = await import("node:crypto");
    const platformBytes = JSON.stringify({ store: "edge", settings: { firstSubmitted: true, storeUrl: canonical } });

    expect(storeSettingsDigest("edge", { storeUrl: canonical, firstSubmitted: true })).toBe(createHash("sha256").update(platformBytes).digest("hex"));
  });

  it("refuses an Edge listing URL without a crx id, a Chrome store URL off the dashboard, and a store URL off Edge and Chrome, before anything is sent", () => {
    expect(readStoreSettingsChange("edge", { storeUrl: "" })).toEqual({ patch: { storeUrl: "" }, requested: { storeUrl: "" } });

    for (const storeUrl of ["https://microsoftedge.microsoft.com/addons/detail/903d21e4-0e5b-4507-95f2-4620fcf06f1c", "https://example.com/addons/detail/abcdefghijklmnopabcdefghijklmnop", 7]) {
      const read = readStoreSettingsChange("edge", { storeUrl });

      expect("problem" in read && read.problem, String(storeUrl)).toMatch(/must be the Edge Add-ons listing URL that ends in the 32-letter crx id/);
    }

    const chrome = readStoreSettingsChange("chrome", { storeUrl: "https://chromewebstore.google.com/detail/abc" });
    const firefox = readStoreSettingsChange("firefox", { storeUrl: "https://addons.mozilla.org/addon/widget" });

    expect("problem" in chrome && chrome.problem).toMatch(/storeUrl for chrome must be the item's address from the Chrome Web Store developer dashboard/);
    expect("problem" in firefox && firefox.problem).toMatch(/"storeUrl", which is a raw platform field/);
  });

  it("writes the Chrome publisher id, or both Chrome ids from the dashboard address, as a plain owner-token write, hashing publisherId last (ledger 317)", async () => {
    if (process.platform === "win32") return;

    platform.login();
    const item = "abcdefghijklmnopabcdefghijklmnop";
    const address = `https://chrome.google.com/webstore/devconsole/pub-1/${item.toUpperCase()}/edit`;
    const cases: Array<[Record<string, unknown>, Record<string, unknown>, Record<string, unknown>]> = [
      [{ publisherId: "pub-1" }, { publisherId: "pub-1" }, { publisherId: "pub-1" }],
      [{ publisherId: "https://chrome.google.com/webstore/devconsole/pub-1" }, { publisherId: "pub-1" }, { publisherId: "pub-1" }],
      [{ storeUrl: address }, { storeId: item, publisherId: "pub-1" }, { chromeItemId: item, publisherId: "pub-1" }],
      [{ chromeItemId: item, publisherId: "pub-1", enabled: true }, { storeId: item, publisherId: "pub-1", enabled: true }, { chromeItemId: item, publisherId: "pub-1", enabled: true }],
    ];

    for (const [storeSettings, patch, requested] of cases) {
      platform.calls.length = 0;
      platform.routes[`PUT ${CONFIG}`] = () => ({ body: { ok: true, store: "chrome", changes: ['chrome.publisherId: "" -> "pub-1"'] } });

      const out = JSON.parse(await submit({ action: "configure-store", store: "chrome", storeSettings, api: API }));
      const [put] = platform.sent("PUT", CONFIG);

      expect(put.body, JSON.stringify(storeSettings)).toEqual({ chrome: patch });
      expect(out.status, JSON.stringify(storeSettings)).toBe("store-configured");
      expect(out.value.storeSettings).toEqual(requested);
      expect(out.hint).toContain("no approval page was involved");
      expect(platform.calls.some((call) => call.path.startsWith(APPROVALS))).toBe(false);
    }

    const { createHash } = await import("node:crypto");
    const platformBytes = JSON.stringify({ store: "chrome", settings: { storeId: item, publisherId: "pub-1" } });

    expect(storeSettingsDigest("chrome", { publisherId: "pub-1", storeId: item })).toBe(createHash("sha256").update(platformBytes).digest("hex"));
    expect(readStoreSettingsChange("chrome", { publisherId: "" })).toMatchObject({ problem: expect.stringContaining("publisherId must be the Chrome Web Store publisher id") });
  });

  it("writes the Safari bundle id and App Store id as plain owner-token writes, hashing bundleId last, and no longer calls the bundle id console-only", async () => {
    if (process.platform === "win32") return;

    platform.login();
    platform.routes[`PUT ${CONFIG}`] = () => ({
      body: { ok: true, store: "safari", changes: ['safari.storeId: "" -> "6826486337"', 'safari.bundleId: "" -> "com.acme.widget"'] },
    });

    const out = JSON.parse(
      await submit({ action: "configure-store", store: "safari", storeSettings: { bundleId: "com.acme.widget", appStoreId: "6826486337" }, api: API }),
    );
    const [put] = platform.sent("PUT", CONFIG);

    expect(put.body).toEqual({ safari: { storeId: "6826486337", bundleId: "com.acme.widget" } });
    expect(out.status).toBe("store-configured");
    expect(out.value.storeSettings).toEqual({ appStoreId: "6826486337", bundleId: "com.acme.widget" });
    expect(out.value.changes).toEqual(['safari.storeId: "" -> "6826486337"', 'safari.bundleId: "" -> "com.acme.widget"']);
    expect(out.value.trackUrl).toMatch(SETTINGS_PAGE);
    expect(out.hint).toContain("no approval page was involved");
    expect(platform.calls.some((call) => call.path.startsWith(APPROVALS))).toBe(false);

    expect(storeSettingsDigest("safari", { storeId: "6826486337", bundleId: "com.acme.widget" })).toBe(
      storeSettingsDigest("safari", { bundleId: "com.acme.widget", storeId: "6826486337" }),
    );

    const description = (schema.inputSchema.properties as Record<string, any>).storeSettings.description as string;

    expect(description).toContain("for Safari bundleId");
    expect(description).not.toMatch(/bundle id: those stay in the console/);
  });

  it("writes a mode id as every field the platform derives it from", () => {
    expect(modeToPatch("chrome", "draft-until-public")).toEqual({ dryRun: false, skipPublish: null, stagedPublish: false });
    expect(modeToPatch("chrome", "draft")).toEqual({ dryRun: false, skipPublish: true, stagedPublish: false });
    expect(modeToPatch("chrome", "public")).toEqual({ dryRun: false, skipPublish: false, stagedPublish: false });
    expect(modeToPatch("chrome", "staged")).toEqual({ dryRun: false, skipPublish: null, stagedPublish: true });
    expect(modeToPatch("edge", "review")).toEqual({ dryRun: false, publishAfter: true });
    expect(modeToPatch("edge", "draft")).toEqual({ dryRun: false, publishAfter: false });
    expect(modeToPatch("firefox", "listed")).toEqual({ dryRun: false, releaseChannel: "listed" });
    expect(modeToPatch("safari", "draft")).toEqual({ dryRun: false });
    expect(modeToPatch("safari", "dry-run")).toEqual({ dryRun: true });

    const read = readStoreSettingsChange("firefox", { enabled: true, submissionMode: "listed", sourceArchive: "repository" });

    expect(read).toEqual({
      patch: { enabled: true, dryRun: false, releaseChannel: "listed", sourceArchive: "repository" },
      requested: { enabled: true, submissionMode: "listed", sourceArchive: "repository" },
    });

    expect(storeSettingsDigest("firefox", { sourceArchive: "repository", enabled: true })).toBe(storeSettingsDigest("firefox", { enabled: true, sourceArchive: "repository" }));
    expect(storeSettingsDigest("firefox", { enabled: true })).not.toBe(storeSettingsDigest("chrome", { enabled: true }));
  });

  it("honors the platform asking for an approval of a plain change, with the change the platform computed, and writes nothing", async () => {
    if (process.platform === "win32") return;

    platform.login();
    const scope = scopeFor("firefox", FIREFOX_PATCH);
    platform.routes[`PUT ${CONFIG}`] = () => approvalRequired(scope);
    platform.routes[`POST ${APPROVALS}`] = () => ({
      status: 201,
      body: {
        approvalId: "apr_cfg",
        approvalUrl: `${API}/device/approve/apr_cfg`,
        expiresAt: "2026-10-23T20:00:00.000Z",
        description: "Change the Firefox store settings of widget: Firefox store publishing: Off -> On; Firefox source archive: none -> repository",
        changes: ["Firefox store publishing: Off -> On", "Firefox source archive: none -> repository"],
      },
    });

    const out = JSON.parse(await submit({ action: "configure-store", store: "firefox", storeSettings: FIREFOX_PATCH, api: API }));
    const [put] = platform.sent("PUT", CONFIG);
    const [post] = platform.sent("POST", APPROVALS);

    expect(put.body).toEqual({ firefox: FIREFOX_PATCH });
    expect(post.body).toMatchObject({ action: STORE_SETTINGS_ACTION, scope, fingerprint: actionFingerprint(STORE_SETTINGS_ACTION, scope), storeSettings: { firefox: FIREFOX_PATCH } });
    expect(post.body.description).toContain("firefox.enabled: true; firefox.sourceArchive: \"repository\"");
    expect(out.ok).toBe(false);
    expect(out.status).toBe("approval-required");
    expect(out.value).toMatchObject({
      approvalId: "apr_cfg",
      approvalUrl: `${API}/device/approve/apr_cfg`,
      changes: ["Firefox store publishing: Off -> On", "Firefox source archive: none -> repository"],
    });

    expect(out.error.message).toContain("approvalId apr_cfg");
    expect(out.error.message).toContain("The platform asked a workspace owner");
    expect(out.hint).toContain(`${API}/device/approve/apr_cfg`);
    expect(platform.sent("PUT", CONFIG)).toHaveLength(1);
  });

  it("refuses when the platform hashes the change differently, without asking anyone", async () => {
    if (process.platform === "win32") return;

    platform.login();
    platform.routes[`PUT ${CONFIG}`] = () => approvalRequired(scopeFor("firefox", FIREFOX_PATCH), "0".repeat(64));

    const out = JSON.parse(await submit({ action: "configure-store", store: "firefox", storeSettings: FIREFOX_PATCH, api: API }));

    expect(out.status).toBe("configure-store-refused");
    expect(out.error.name).toBe("SettingsDigestMismatch");
    expect(platform.sent("POST", APPROVALS)).toHaveLength(0);
  });

  it("passes on the platform's no-change refusal before any approval is minted", async () => {
    if (process.platform === "win32") return;

    platform.login();
    platform.routes[`PUT ${CONFIG}`] = () => approvalRequired(scopeFor("firefox", { enabled: true }));
    platform.routes[`POST ${APPROVALS}`] = () => ({ status: 409, body: { code: "NO_CHANGE", message: "These store settings are already in place.", refusedBeforeApproval: true } });

    const out = JSON.parse(await submit({ action: "configure-store", store: "firefox", storeSettings: { enabled: true }, api: API }));

    expect(out.status).toBe("configure-store-refused");
    expect(out.error.platformCode).toBe("NO_CHANGE");
    expect(out.hint).toContain("already read this way");
  });

  it("applies an approved change once and answers what changed, the settings page and preflight as the next step", async () => {
    if (process.platform === "win32") return;

    platform.login();
    const scope = scopeFor("firefox", FIREFOX_PATCH);
    platform.routes["GET /api/cli/approvals/apr_cfg"] = () => ({
      body: { status: "approved", used: false, fingerprint: actionFingerprint(STORE_SETTINGS_ACTION, scope), expiresAt: new Date(Date.now() + 60_000).toISOString() },
    });

    platform.routes[`PUT ${CONFIG}`] = () => ({ body: { ok: true, store: "firefox", changes: ["Firefox store publishing: Off -> On", "Firefox source archive: none -> repository"] } });

    const out = JSON.parse(await submit({ action: "configure-store", store: "firefox", storeSettings: FIREFOX_PATCH, approvalId: "apr_cfg", api: API }));
    const puts = platform.sent("PUT", CONFIG);

    expect(puts).toHaveLength(1);
    expect(puts[0].body).toEqual({ firefox: FIREFOX_PATCH, approvalId: "apr_cfg" });
    expect(out.ok).toBe(true);
    expect(out.status).toBe("store-configured");
    expect(out.value).toMatchObject({
      action: "configure-store",
      store: "firefox",
      project: "acme/widget",
      storeSettings: { enabled: true, sourceArchive: "repository" },
      changes: ["Firefox store publishing: Off -> On", "Firefox source archive: none -> repository"],
    });

    expect(out.value.trackUrl).toMatch(SETTINGS_PAGE);
    expect(out.value.nextStep.kind).toBe("preflight");
    expect(out.hint).toContain('extension_submit (action: "preflight", browsers: ["firefox"])');
    expect(out.hint).toContain(out.value.trackUrl);
    expect(platform.sent("POST", APPROVALS)).toHaveLength(0);
  });

  it("falls back to the requested lines when the platform answers only ok", async () => {
    if (process.platform === "win32") return;

    platform.login();
    const scope = scopeFor("chrome", { dryRun: false, skipPublish: true, stagedPublish: false });
    platform.routes["GET /api/cli/approvals/apr_c"] = () => ({
      body: { status: "approved", used: false, fingerprint: actionFingerprint(STORE_SETTINGS_ACTION, scope), expiresAt: new Date(Date.now() + 60_000).toISOString() },
    });

    platform.routes[`PUT ${CONFIG}`] = () => ({ body: { ok: true } });

    const out = JSON.parse(await submit({ action: "configure-store", store: "chrome", storeSettings: { submissionMode: "draft" }, approvalId: "apr_c", api: API }));

    expect(out.status).toBe("store-configured");
    expect(out.value.changes).toEqual(['chrome.submissionMode: "draft"']);
    expect(platform.sent("PUT", CONFIG)[0].body).toEqual({ chrome: { dryRun: false, skipPublish: true, stagedPublish: false }, approvalId: "apr_c" });
  });

  it("with a pending approval says to approve and call again, and writes nothing", async () => {
    if (process.platform === "win32") return;

    platform.login();
    platform.routes["GET /api/cli/approvals/apr_p"] = () => ({ body: { status: "pending", used: false } });

    const out = JSON.parse(await submit({ action: "configure-store", store: "firefox", storeSettings: FIREFOX_PATCH, approvalId: "apr_p", api: API }));

    expect(out.status).toBe("approval-pending");
    expect(platform.sent("PUT", CONFIG)).toHaveLength(0);
  });

  it("with a used approval says to read the store's readiness first", async () => {
    if (process.platform === "win32") return;

    platform.login();
    const scope = scopeFor("firefox", FIREFOX_PATCH);
    platform.routes["GET /api/cli/approvals/apr_u"] = () => ({
      body: { status: "approved", used: true, fingerprint: actionFingerprint(STORE_SETTINGS_ACTION, scope), expiresAt: new Date(Date.now() + 60_000).toISOString() },
    });

    const out = JSON.parse(await submit({ action: "configure-store", store: "firefox", storeSettings: FIREFOX_PATCH, approvalId: "apr_u", api: API }));

    expect(out.error.name).toBe("ApprovalConsumed");
    expect(out.error.message).toContain('extension_submit (action: "preflight", browsers: ["firefox"])');
    expect(platform.sent("PUT", CONFIG)).toHaveLength(0);
  });

  it("says the platform does not take the change from a token yet when the route answers unauthenticated", async () => {
    if (process.platform === "win32") return;

    platform.login();
    platform.routes[`PUT ${CONFIG}`] = () => ({ status: 401, body: { code: "UNAUTHENTICATED", message: "Sign in" } });

    const out = JSON.parse(await submit({ action: "configure-store", store: "firefox", storeSettings: FIREFOX_PATCH, api: API }));

    expect(out.ok).toBe(false);
    expect(out.status).toBe("refused");
    expect(out.hint).toContain("does not take this change from a token yet");
    expect(out.hint).toContain(out.value.trackUrl);
    expect(out.value.trackUrl).toMatch(SETTINGS_PAGE);
    expect(platform.sent("POST", APPROVALS)).toHaveLength(0);
  });
});
