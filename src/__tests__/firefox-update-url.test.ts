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

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { writeCredentials } from "../lib/credentials";
import { UPDATE_URL_NETWORK_NOTE, channelBrowsers, firefoxChannelFields, firefoxChannelSentence, manifestUpdateUrlOf, servedOfAnswer, updateManifestSentence, updateUrlNotSuggestedSentence } from "../lib/firefox-update-url";
import { channelXpiAddress, namesRegistryOrToken, updateManifestAddress } from "../lib/package-address";
import { noNetworkPromiseOf } from "../lib/store-md-network";
import { handler as publish } from "../tools/publish";
import { handler as promote } from "../tools/release-promote";
import { handler as submit } from "../tools/submit";
import { promoteAnswer, publishAnswer } from "./fixtures/platform-answers";

type Row = Record<string, unknown>;

const PROD = "https://www.extension.dev";
const PROJECT_ID = "prj_308";
const REF = { workspace: "acme", project: "widget" };
const UPDATES = "https://acme.extension.dev/widget/channels/stable/updates.json";
const XPI = "https://acme.extension.dev/widget/channels/stable/firefox.xpi";
const OTHER = "https://example.com/updates.json";
const OLD_WARNING =
  "This unlisted version sets no browser_specific_settings.gecko.update_url, so Firefox will not find its updates. Point update_url at an https update manifest you host, or distribute on the listed channel.";
const DO_IT_YOURSELF = /you host|host an update manifest|host it yourself/i;

function updateCheck(message: string, status = "warn"): Row {
  return { id: "firefox.update_url", label: "Update manifest", status, severity: "warning", stage: "review", message };
}

function firefoxReport(checks: Row[], warnings: string[] = checks.map((check) => String(check.id))): Row {
  return {
    store: "firefox",
    summary: { pass: 9, warn: warnings.length, fail: 0, canSubmit: true },
    checks,
    connection: { kind: "api-key", connectedAs: "cezar@example.com", healthy: true, itemId: "widget@acme.example", itemLinked: true },
    submissionMode: { id: "unlisted", label: "Unlisted", description: "Firefox versions will upload to the unlisted channel for limited distribution." },
    firefoxPreflight: { act: "upload", checks, blocking: [], warnings, lock: null, nextVersion: "0.1.0.1", channel: "unlisted" },
  };
}

describe("the Firefox update manifest address is built beside the package address", () => {
  it("names updates.json and firefox.xpi under the channel on the project's own domain, token-free", () => {
    expect(updateManifestAddress(REF, "stable", PROD)).toBe(UPDATES);
    expect(channelXpiAddress(REF, "stable", PROD)).toBe(XPI);
    expect(updateManifestAddress(REF, "beta", PROD)).toBe("https://acme.extension.dev/widget/channels/beta/updates.json");
    expect(updateManifestAddress(null, "stable", PROD)).toBe("");
    expect(updateManifestAddress(REF, "", PROD)).toBe("");
    expect(namesRegistryOrToken(UPDATES + XPI)).toEqual([]);
  });

  it("answers the firefox fields for a channel that serves firefox and nothing for chrome alone", () => {
    expect(firefoxChannelFields(REF, "stable", ["chrome", "firefox"], PROD)).toEqual({ firefox: { channel: "stable", updateManifestUrl: UPDATES, channelXpiUrl: XPI } });
    expect(firefoxChannelFields(REF, "stable", ["chrome"], PROD)).toEqual({});
    expect(channelBrowsers([{ channel: "chrome-stable", sha: "a" }, { channel: "firefox-stable", sha: "a" }, { channel: "beta", sha: "b" }], "stable", ["chrome"])).toEqual(["chrome", "firefox"]);
    expect(channelBrowsers([{ channel: "beta", sha: "b" }], "beta", ["chrome", "firefox"])).toEqual(["chrome", "firefox"]);
    expect(channelBrowsers([{ channel: "beta", sha: "b" }], "stable", ["chrome", "firefox"])).toEqual([]);
  });

  it("the channel sentence names the network request every install makes and the served word when it is in hand, never a console step", () => {
    const fields = firefoxChannelFields(REF, "stable", ["chrome", "firefox"], PROD);
    const plain = firefoxChannelSentence(fields);

    expect(plain).toContain(`update through ${UPDATES}, which the platform rewrites after every signing and whose update_link is ${XPI}, when the manifest names that update_url in browser_specific_settings.gecko.`);
    expect(plain).toContain(UPDATE_URL_NETWORK_NOTE);
    expect(plain).toContain("a network request to extension.dev");
    expect(plain).not.toContain("stays current");
    expect(plain).not.toMatch(/served now|not served yet/);
    expect(firefoxChannelSentence({})).toBe("");

    const notServed = servedOfAnswer({ updateManifest: { url: UPDATES, served: false, reason: "channel-not-public", checkedAt: "2026-10-31T12:00:00.000Z" } });
    const held = firefoxChannelFields(REF, "stable", ["firefox"], PROD, notServed);
    expect(held).toMatchObject({ firefox: { updateManifest: { url: UPDATES, served: false, reason: "channel-not-public" } } });
    expect(firefoxChannelSentence(held)).toContain(`The update manifest at ${UPDATES} is not served yet: no signed build is on that channel yet; the platform serves it once AMO signs the version`);
    expect(firefoxChannelSentence(held)).not.toMatch(/console/i);

    const served = servedOfAnswer({ firefox: { updateManifest: { url: UPDATES, served: true, checkedAt: "2026-10-31T12:00:00.000Z" } } });
    expect(firefoxChannelSentence(firefoxChannelFields(REF, "stable", ["firefox"], PROD, served))).toContain(`Firefox finds updates at ${UPDATES}, served now (checked 2026-10-31T12:00:00.000Z).`);
    expect(servedOfAnswer({ updateManifest: { url: UPDATES } })).toBeUndefined();
    expect(servedOfAnswer(null)).toBeUndefined();
  });

  it("reads the manifest's gecko update_url for the firefox target", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "extdev-update-url-manifest-"));
    fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ name: "Widget", version: "0.1.0", manifest_version: 3, browser_specific_settings: { gecko: { id: "widget@acme.example", update_url: OTHER } } }));

    expect(manifestUpdateUrlOf(dir)).toBe(OTHER);
    expect(manifestUpdateUrlOf("")).toBeNull();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("reads the update_url under the firefox: and gecko: prefixed key shapes of an unfolded manifest", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "extdev-update-url-prefixed-"));
    fs.mkdirSync(path.join(dir, "dist", "firefox"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "dist", "firefox", "manifest.json"),
      JSON.stringify({ name: "Widget", version: "0.1.0", manifest_version: 3, "gecko:browser_specific_settings": { "firefox:gecko": { id: "widget@acme.example", "gecko:update_url": UPDATES } } }),
    );

    expect(manifestUpdateUrlOf(dir)).toBe(UPDATES);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("extension_submit preflight: the firefox.update_url check names the platform's update manifest", () => {
  let tmp: string;
  let project: string;
  let routes: Record<string, () => { status?: number; body: unknown }>;
  const saved: Record<string, string | undefined> = {};
  const envKeys = ["XDG_CONFIG_HOME", "EXTENSION_DEV_API_URL", "EXTENSION_DEV_APPROVAL_GATE", "EXTENSION_DEV_TOKEN", "EXTENSION_DEV_REGISTRY_URL"];

  function manifest(updateUrl?: string): void {
    const gecko = { id: "widget@acme.example", ...(updateUrl ? { update_url: updateUrl } : {}) };
    fs.writeFileSync(path.join(project, "manifest.json"), JSON.stringify({ name: "Widget", version: "0.1.0", manifest_version: 3, browser_specific_settings: { gecko } }));
  }

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "extdev-update-url-"));
    project = path.join(tmp, "project");
    fs.mkdirSync(project);
    for (const key of envKeys) saved[key] = process.env[key];
    for (const key of envKeys) delete process.env[key];

    process.env.XDG_CONFIG_HOME = tmp;
    process.env.EXTENSION_DEV_API_URL = PROD;
    process.env.EXTENSION_DEV_APPROVAL_GATE = "0";
    writeCredentials({ version: 1, token: "claims.sig", workspaceSlug: "acme", projectSlug: "widget", expiresAt: Math.floor(Date.now() / 1000) + 3600, api: PROD });
    routes = {
      "GET /api/cli/whoami": () => ({ body: { login: "acme/widget", live: true, projectId: PROJECT_ID, workspaceSlug: "acme", projectSlug: "widget" } }),
      [`POST /api/projects/${PROJECT_ID}/stores/firefox/submissions/preflight`]: () => ({ body: firefoxReport([updateCheck(OLD_WARNING)]) }),
    };

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(input instanceof Request ? input.url : input));
        const method = String(init?.method ?? "GET").toUpperCase();
        const route = routes[`${method} ${url.pathname}`];
        const answer = route ? route() : { status: 404, body: { message: "not found" } };

        return new Response(JSON.stringify(answer.body), { status: answer.status ?? 200, headers: { "content-type": "application/json" } });
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();

    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("replaces the host-it-yourself warning with the updates.json address and drops the warning", async () => {
    const out = JSON.parse(await submit({ action: "preflight", browsers: ["firefox"], api: PROD }));
    const firefox = out.value.stores.firefox;

    expect(out.status).toBe("preflight-read");
    expect(firefox.updateManifest).toMatchObject({ channel: "stable", updateManifestUrl: UPDATES, channelXpiUrl: XPI, manifestUpdateUrl: null, suggested: true, say: updateManifestSentence(UPDATES) });
    expect(firefox.updateManifest.noNetworkPromise).toBeUndefined();
    expect(firefox.warnings.map((row: Row) => row.id)).not.toContain("firefox.update_url");
    expect(out.value.storePreflight.firefox.warnings).toEqual([]);
    expect(out.value.storePreflight.firefox.checks).toBeUndefined();
    expect(out.hint).toContain(updateManifestSentence(UPDATES));
    expect(updateManifestSentence(UPDATES)).toMatch(/^Option for self-distributed builds: put browser_specific_settings\.gecko\.update_url: /);
    expect(out.hint).toContain("Firefox will then check that address for updates from every install, a network request to extension.dev");
    expect(out.hint).not.toContain(`Put browser_specific_settings.gecko.update_url: ${UPDATES} in the manifest for the firefox target;`);
    expect(out.value.sayToPerson).toContain(UPDATES);
    expect(JSON.stringify(out)).not.toMatch(DO_IT_YOURSELF);
    expect(namesRegistryOrToken(JSON.stringify(out))).toEqual([]);
  });

  it("suggests no update_url when the project's STORE.md promises no network requests, and says why", async () => {
    fs.writeFileSync(path.join(project, "STORE.md"), "# Leon\n\n## Privacy and data use\n\n- Privacy policy URL: https://example.com/privacy\n\nThe extension makes no network requests at all. Everything stays in the browser.\n");
    manifest();

    const out = JSON.parse(await submit({ action: "preflight", browsers: ["firefox"], projectPath: project, api: PROD }));
    const firefox = out.value.stores.firefox;
    const expected = updateUrlNotSuggestedSentence("The extension makes no network requests at all.", UPDATES);

    expect(firefox.updateManifest).toMatchObject({ manifestUpdateUrl: null, suggested: false, noNetworkPromise: "The extension makes no network requests at all.", say: expected });
    expect(expected).toContain("a network request to extension.dev");
    expect(out.hint).toContain(expected);
    expect(out.hint).not.toContain("Option for self-distributed builds");
    expect(out.hint).not.toContain("Put browser_specific_settings");
    expect(firefox.warnings.map((row: Row) => row.id)).not.toContain("firefox.update_url");
    expect(out.value.storePreflight.firefox.warnings).toEqual([]);
    expect(JSON.stringify(out)).not.toMatch(DO_IT_YOURSELF);
  });

  it("keeps the platform's passing check verbatim when it suggests no update_url for an add-on also on AMO's listed channel", async () => {
    const listed = "This self-distributed version sets no browser_specific_settings.gecko.update_url, and this add-on is also on AMO's listed channel (0.1.0.1): Firefox asks AMO for updates of an add-on whose manifest names no update_url, so installs of the signed file follow the listed channel, and the platform suggests no update_url.";
    routes[`POST /api/projects/${PROJECT_ID}/stores/firefox/submissions/preflight`] = () => ({ body: firefoxReport([updateCheck(listed, "pass")], []) });

    const out = JSON.parse(await submit({ action: "preflight", browsers: ["firefox"], api: PROD }));
    const firefox = out.value.stores.firefox;

    expect(firefox.updateManifest).toMatchObject({ manifestUpdateUrl: null, suggested: false, say: listed });
    expect(out.hint).toContain(listed);
    expect(out.hint).not.toContain("Option for self-distributed builds");
    expect(out.value.storePreflight.firefox.warnings).toEqual([]);
  });

  it("relays the platform's own check text verbatim once it names the hosted manifest", async () => {
    const hosted = `Put browser_specific_settings.gecko.update_url: ${UPDATES} in the manifest for the firefox target; extension.dev rewrites it after every signing, listing each version at ${XPI}.`;
    routes[`POST /api/projects/${PROJECT_ID}/stores/firefox/submissions/preflight`] = () => ({ body: firefoxReport([updateCheck(hosted, "pass")], []) });

    const out = JSON.parse(await submit({ action: "preflight", browsers: ["firefox"], api: PROD }));

    expect(out.value.stores.firefox.updateManifest.say).toBe(hosted);
    expect(out.value.stores.firefox.updateManifest.manifestUpdateUrl).toBeNull();
    expect(out.hint).toContain(hosted);
  });

  it("echoes the manifest's update_url from the platform's passing check when no projectPath is given", async () => {
    const read = `Firefox will look for updates of this self-distributed version at ${UPDATES}.`;
    routes[`POST /api/projects/${PROJECT_ID}/stores/firefox/submissions/preflight`] = () => ({ body: firefoxReport([updateCheck(read, "pass")], []) });

    const out = JSON.parse(await submit({ action: "preflight", browsers: ["firefox"], api: PROD }));
    const firefox = out.value.stores.firefox;

    expect(firefox.updateManifest).toMatchObject({ manifestUpdateUrl: UPDATES, updateManifestUrl: UPDATES, say: read });
    expect(firefox.warnings.map((row: Row) => row.id)).not.toContain("firefox.update_url");
    expect(out.value.storePreflight.firefox.warnings).toEqual([]);
  });

  it("warns with both addresses when the platform's passing check names another update_url and no projectPath is given", async () => {
    const read = `Firefox will look for updates of this self-distributed version at ${OTHER}.`;
    routes[`POST /api/projects/${PROJECT_ID}/stores/firefox/submissions/preflight`] = () => ({ body: firefoxReport([updateCheck(read, "pass")], []) });

    const out = JSON.parse(await submit({ action: "preflight", browsers: ["firefox"], api: PROD }));
    const warning = out.value.stores.firefox.warnings.find((row: Row) => row.id === "firefox.update_url");

    expect(out.value.stores.firefox.updateManifest).toMatchObject({ manifestUpdateUrl: OTHER, updateManifestUrl: UPDATES });
    expect(warning).toMatchObject({ expected: UPDATES, actual: OTHER });
    expect(out.value.storePreflight.firefox.warnings).toEqual(["firefox.update_url"]);
  });

  it("keeps a warning naming both addresses when the manifest names a different update_url", async () => {
    manifest(OTHER);

    const out = JSON.parse(await submit({ action: "preflight", browsers: ["firefox"], projectPath: project, api: PROD }));
    const firefox = out.value.stores.firefox;
    const warning = firefox.warnings.find((row: Row) => row.id === "firefox.update_url");

    expect(firefox.updateManifest).toMatchObject({ manifestUpdateUrl: OTHER, updateManifestUrl: UPDATES });
    expect(warning).toMatchObject({ id: "firefox.update_url", expected: UPDATES, actual: OTHER });
    expect(warning.message).toContain(OTHER);
    expect(warning.message).toContain(UPDATES);
    expect(out.value.storePreflight.firefox.warnings).toEqual(["firefox.update_url"]);
    expect(out.value.storePreflight.firefox.checks[0]).toMatchObject({ id: "firefox.update_url", status: "warn", expected: UPDATES, actual: OTHER });
    expect(JSON.stringify(out)).not.toMatch(DO_IT_YOURSELF);
  });

  it("warns on a different update_url even when the platform's preflight is silent about it, and says nothing to warn about when the manifest already names the platform's address", async () => {
    routes[`POST /api/projects/${PROJECT_ID}/stores/firefox/submissions/preflight`] = () => ({ body: firefoxReport([], []) });
    manifest(OTHER);

    const silent = JSON.parse(await submit({ action: "preflight", browsers: ["firefox"], projectPath: project, api: PROD }));
    expect(silent.value.stores.firefox.warnings.map((row: Row) => row.id)).toEqual(["firefox.update_url"]);
    expect(silent.value.storePreflight.firefox.warnings).toEqual(["firefox.update_url"]);

    manifest(UPDATES);

    const matched = JSON.parse(await submit({ action: "preflight", browsers: ["firefox"], projectPath: project, api: PROD }));
    expect(matched.value.stores.firefox.warnings).toEqual([]);
    expect(matched.value.stores.firefox.updateManifest).toMatchObject({ manifestUpdateUrl: UPDATES, updateManifestUrl: UPDATES });
    expect(matched.value.stores.firefox.updateManifest.say).toBe(`The manifest names the platform's update_url ${UPDATES}; the platform rewrites updates.json after every signing.`);
  });
});

describe("a STORE.md promise of no network requests is read sentence by sentence", () => {
  it("finds the promise in its common spellings and ignores one with an exception", () => {
    expect(noNetworkPromiseOf("## Privacy and data use\n\n- Network requests: none\n")).toEqual({ line: "Network requests: none" });
    expect(noNetworkPromiseOf("It does not make any network requests. It stores notes locally.")).toEqual({ line: "It does not make any network requests." });
    expect(noNetworkPromiseOf("The extension never contacts a server and works entirely offline.")?.line).toContain("never contacts a server");
    expect(noNetworkPromiseOf("No data leaves your device.")).toEqual({ line: "No data leaves your device." });
    expect(noNetworkPromiseOf("<!-- no network requests -->\nIt syncs notes to our servers.")).toBeNull();
    expect(noNetworkPromiseOf("It makes no network requests except to sync your notes to our servers.")).toBeNull();
    expect(noNetworkPromiseOf("Network requests go to api.example.com for sync.")).toBeNull();
    expect(noNetworkPromiseOf("")).toBeNull();
  });
});

describe("extension_release_promote and extension_publish name the update manifest for a firefox channel and not for chrome", () => {
  const API = PROD;
  const PROJECT = "https://acme.extension.dev/widget";
  const saved: Record<string, string | undefined> = {};
  let tmp: string;

  function registry(channels: Record<string, { sha: string }>, queuedBrowsers: string[], visibility: "public" | "private" = "public", answer: Row = {}) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown) => {
        const href = String(url);
        const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

        if (href.endsWith("/api/cli/publish")) return json(publishAnswer({ visibility, buildSha: "abc1234" }));
        if (href.endsWith("/api/cli/release/promote")) return json(promoteAnswer({ queuedBrowsers, targetChannel: "stable", ...answer }));
        if (href.endsWith("/api/cli/whoami")) return json({ login: "acme/widget", projectId: "prj_1", workspaceSlug: "acme", projectSlug: "widget" });
        if (href.endsWith("/api/projects/prj_1/releases")) return json({ items: [{ id: "rel_1", channel: "stable", buildId: "abc1234", status: "completed" }] });
        if (href.endsWith("/channels.json")) return json(channels);
        if (href.endsWith("/meta.json")) return json({ name: "Widget", visibility });
        if (href.endsWith("/builds/index.json")) return json({ items: [] });

        return new Response("{}", { status: 404, headers: { "content-type": "application/json" } });
      }),
    );
  }

  beforeEach(() => {
    for (const key of ["XDG_CONFIG_HOME", "EXTENSION_DEV_API_URL", "EXTENSION_DEV_TOKEN", "EXTENSION_DEV_APPROVAL_GATE"]) saved[key] = process.env[key];

    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "extdev-update-url-channel-"));
    process.env.XDG_CONFIG_HOME = tmp;
    process.env.EXTENSION_DEV_API_URL = API;
    process.env.EXTENSION_DEV_TOKEN = `${Buffer.from(JSON.stringify({ u: "acme", p: "widget", exp: Math.floor(Date.now() / 1000) + 600 })).toString("base64url")}.sig`;
    process.env.EXTENSION_DEV_APPROVAL_GATE = "0";
  });

  afterEach(() => {
    vi.unstubAllGlobals();

    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("a promote that queued firefox answers value.firefox with the manifest address and says it; chrome alone gets none", async () => {
    registry({ "chrome-stable": { sha: "abc1234" }, "firefox-stable": { sha: "abc1234" } }, ["chrome", "firefox"]);
    const both = JSON.parse(await promote({ buildId: "abc1234", channel: "stable", browsers: ["chrome", "firefox"], api: API } as never));

    expect(both.status).toBe("promoted");
    expect(both.value.firefox).toEqual({ channel: "stable", updateManifestUrl: `${PROJECT}/channels/stable/updates.json`, channelXpiUrl: `${PROJECT}/channels/stable/firefox.xpi` });
    expect(both.hint).toContain(`${PROJECT}/channels/stable/updates.json`);
    expect(both.hint).toContain(UPDATE_URL_NETWORK_NOTE);
    expect(both.hint).not.toContain("stays current");
    expect(both.hint).not.toMatch(/served now|not served yet/);

    registry({ "chrome-stable": { sha: "abc1234" }, "firefox-stable": { sha: "abc1234" } }, ["chrome", "firefox"], "public", {
      updateManifest: { url: `${PROJECT}/channels/stable/updates.json`, served: false, reason: "channel-not-public", checkedAt: "2026-10-31T12:00:00.000Z" },
    });

    const unserved = JSON.parse(await promote({ buildId: "abc1234", channel: "stable", browsers: ["chrome", "firefox"], api: API } as never));

    expect(unserved.value.firefox.updateManifest).toMatchObject({ url: `${PROJECT}/channels/stable/updates.json`, served: false, reason: "channel-not-public" });
    expect(unserved.hint).toContain(`The update manifest at ${PROJECT}/channels/stable/updates.json is not served yet: no signed build is on that channel yet; the platform serves it once AMO signs the version`);
    expect(unserved.hint).not.toMatch(/console step/i);

    registry({ "chrome-stable": { sha: "abc1234" } }, ["chrome"]);
    const chrome = JSON.parse(await promote({ buildId: "abc1234", channel: "stable", browsers: ["chrome"], api: API } as never));

    expect(chrome.status).toBe("promoted");
    expect(chrome.value.firefox).toBeUndefined();
    expect(chrome.hint).not.toContain("updates.json");

    registry({ "chrome-stable": { sha: "abc1234" }, "firefox-stable": { sha: "abc1234" } }, ["chrome", "firefox"], "private");
    const withheld = JSON.parse(await promote({ buildId: "abc1234", channel: "stable", browsers: ["chrome", "firefox"], api: API } as never));

    expect(withheld.value.firefox).toBeUndefined();
    expect(withheld.value.channelUrlWithheld).toMatch(/private/);
  });

  it("a publish on a channel that serves firefox answers value.firefox; a chrome-only channel does not", async () => {
    registry({ "chrome-stable": { sha: "abc1234" }, "firefox-stable": { sha: "abc1234" } }, ["chrome", "firefox"]);
    const both = JSON.parse(await publish({ api: API }));

    expect(both.ok).toBe(true);
    expect(both.value.channelUrl).toBe(`${PROJECT}/channels/stable`);
    expect(both.value.firefox).toEqual({ channel: "stable", updateManifestUrl: `${PROJECT}/channels/stable/updates.json`, channelXpiUrl: `${PROJECT}/channels/stable/firefox.xpi` });
    expect(both.hint).toContain(`${PROJECT}/channels/stable/updates.json`);
    expect(both.hint).toContain(UPDATE_URL_NETWORK_NOTE);
    expect(both.hint).not.toContain("stays current");

    registry({ "chrome-stable": { sha: "abc1234" } }, ["chrome"]);
    const chrome = JSON.parse(await publish({ api: API }));

    expect(chrome.value.channelUrl).toBe(`${PROJECT}/channels/stable`);
    expect(chrome.value.firefox).toBeUndefined();
    expect(chrome.hint).not.toContain("updates.json");
  });
});
