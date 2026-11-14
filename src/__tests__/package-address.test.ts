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
import {
  artifactWithAddress,
  itemPackageUrl,
  namesRegistryOrToken,
  packageAddress,
  packageFileOf,
  printedPackageAddress,
} from "../lib/package-address";
import { carriesRegistryToken, carriesShareToken } from "../lib/publish-link";
import { connectionOf } from "../lib/store-connection";
import { handler as builds } from "../tools/builds";
import { handler as publish } from "../tools/publish";
import { handler as shares } from "../tools/shares";

type Row = Record<string, unknown>;

const PROD = "https://www.extension.dev";
const LOCAL = "http://localhost:3100";
const PROJECT_ID = "prj_306";
const SHA = "82c26be";
const JWT = `eyJ${"a".repeat(220)}.sig`;
const REGISTRY_ZIP = (browser: string, file = "zip") => `https://registry.extension.land/acme/widget/builds/${SHA}/${browser}.${file}`;
const TOKENED = `${REGISTRY_ZIP("chrome")}?t=${JWT}`;
const LOCAL_TOKENED = `${LOCAL}/api/local-registry/acme/widget/builds/${SHA}/chrome.zip?t=${JWT}`;
const PACKAGE = `https://acme.extension.dev/widget/builds/${SHA}/chrome.zip`;
const REF = { workspace: "acme", project: "widget" };
const NEW_ITEM = "https://chrome.google.com/webstore/devconsole";
const SETTINGS = "https://console.extension.dev/acme/widget/project-settings/stores";
const LINK_ITEM = `${SETTINGS}?connect=chrome&link=item`;
const LEAK = /registry\.extension\.land|[?&]t=/;

function notLinked(packageUrl: string | null): Row {
  return {
    store: "chrome",
    summary: { pass: 8, warn: 0, fail: 0, canSubmit: true },
    checks: [{ id: "credentials", label: "Store credentials", status: "pass", severity: "blocking", message: "" }],
    connection: {
      kind: "oauth",
      connectedAs: "cezar@example.com",
      healthy: true,
      itemId: null,
      itemLinked: false,
      newItemUrl: NEW_ITEM,
      ...(packageUrl ? { packageUrl } : {}),
      linkItemUrl: LINK_ITEM,
    },
  };
}

function linked(): Row {
  return {
    store: "chrome",
    summary: { pass: 9, warn: 0, fail: 0, canSubmit: true },
    checks: [],
    connection: { kind: "oauth", connectedAs: "cezar@example.com", healthy: true, itemId: "abcdefghijklmnopabcdefghijklmnop", itemLinked: true },
  };
}

function artifacts(): Row[] {
  return [
    { name: "chrome-extension.zip", browser: "chrome", type: "Extension package", downloadUrl: REGISTRY_ZIP("chrome") },
    { name: "firefox.xpi", browser: "firefox", type: "Signed package", downloadUrl: REGISTRY_ZIP("firefox", "xpi") },
    { name: "chrome.integrity.json", browser: "chrome", type: "Integrity", downloadUrl: `https://registry.extension.land/acme/widget/builds/${SHA}/artifact-integrity/chrome.json` },
  ];
}

describe("the package address helper", () => {
  it("reads the build sha and file out of a platform address, tokened or not, and out of a path", () => {
    expect(packageFileOf(TOKENED)).toEqual({ sha: SHA, file: "chrome.zip", browser: "chrome" });
    expect(packageFileOf(REGISTRY_ZIP("firefox", "xpi"))).toEqual({ sha: SHA, file: "firefox.xpi", browser: "firefox" });
    expect(packageFileOf(`/api/local-registry/acme/widget/builds/${SHA}/artifact-integrity/chrome.json`)).toEqual({ sha: SHA, file: "artifact-integrity/chrome.json", browser: "chrome" });
    expect(packageFileOf(`builds/${SHA}/chrome.zip`)).toEqual({ sha: SHA, file: "chrome.zip", browser: "chrome" });
    expect(packageFileOf("https://www.extension.dev/api/projects/prj/settings")).toBeNull();
    expect(packageFileOf("")).toBeNull();
  });

  it("builds the subdomain address from the workspace, project, sha and file, with the share grant as ?share=", () => {
    expect(packageAddress(REF, SHA, "chrome.zip", { api: PROD })).toBe(PACKAGE);
    expect(packageAddress(REF, SHA, "firefox.xpi", { api: PROD, share: "k3x9q" })).toBe(`https://acme.extension.dev/widget/builds/${SHA}/firefox.xpi?share=k3x9q`);
    expect(packageAddress(null, SHA, "chrome.zip", { api: PROD })).toBe("");
    expect(packageAddress(REF, "", "chrome.zip", { api: PROD })).toBe("");
  });

  it("maps a tokened registry address to the subdomain address and falls back to the sha and browser for a shape it cannot map", () => {
    expect(printedPackageAddress(TOKENED, { ref: REF, api: PROD })).toBe(PACKAGE);
    expect(printedPackageAddress("https://www.extension.dev/api/stores/chrome/package?token=x", { ref: REF, sha: SHA, browser: "chrome", api: PROD })).toBe(PACKAGE);
    expect(printedPackageAddress("", { ref: REF, sha: SHA, browser: "firefox", api: PROD })).toBe(`https://acme.extension.dev/widget/builds/${SHA}/firefox.zip`);
    expect(printedPackageAddress("", { ref: REF, api: PROD })).toBe("");
    expect(printedPackageAddress(LOCAL_TOKENED, { ref: REF, sha: SHA, browser: "chrome", api: LOCAL })).toBe(LOCAL_TOKENED);
  });

  it("answers the item package from a connection row's packageFile, the settings page when nothing names a build, and the platform's own address in local path mode", () => {
    expect(itemPackageUrl([{ packageFile: `builds/${SHA}/chrome.zip` }], { ref: REF, api: PROD }, SETTINGS)).toBe(PACKAGE);
    expect(itemPackageUrl([{ packageUrl: TOKENED }], { ref: REF, api: PROD }, SETTINGS)).toBe(PACKAGE);
    expect(itemPackageUrl([{}], { ref: REF, api: PROD }, SETTINGS)).toBe(SETTINGS);
    expect(itemPackageUrl([{ packageUrl: LOCAL_TOKENED }], { ref: REF, api: LOCAL }, SETTINGS)).toBe(LOCAL_TOKENED);
  });

  it("a connection record keeps the package as a path, never the tokened address, except in local path mode", () => {
    const record = connectionOf(notLinked(TOKENED), PROD);
    expect(record).toMatchObject({ packageFile: `builds/${SHA}/chrome.zip`, newItemUrl: NEW_ITEM, linkItemUrl: LINK_ITEM });
    expect(JSON.stringify(record)).not.toMatch(LEAK);
    expect(connectionOf(notLinked(LOCAL_TOKENED), LOCAL)).toMatchObject({ packageUrl: LOCAL_TOKENED });
  });

  it("a run command carrying share= counts as carrying the grant, and only ?t= as a registry token", () => {
    const short = [{ browser: "chrome", url: `${PACKAGE}?share=k3x9q` }];
    const long = [{ browser: "chrome", url: TOKENED }];
    expect(carriesShareToken(short)).toBe(true);
    expect(carriesShareToken(long)).toBe(true);
    expect(carriesShareToken([{ browser: "chrome", url: PACKAGE }])).toBe(false);
    expect(carriesRegistryToken(short)).toBe(false);
    expect(carriesRegistryToken(long)).toBe(true);
  });

  it("names what a guard scan found", () => {
    expect(namesRegistryOrToken(JSON.stringify({ packageUrl: TOKENED }))).toEqual(["registry.extension.land", "?t="]);
    expect(namesRegistryOrToken(JSON.stringify({ packageUrl: `${PACKAGE}?share=k3x9q` }))).toEqual([]);
  });
});

describe("every tool prints the build's extension.dev package address and no registry address", () => {
  let tmp: string;
  let routes: Record<string, (body: Row | undefined) => { status?: number; body: unknown }>;
  const saved: Record<string, string | undefined> = {};
  const envKeys = ["XDG_CONFIG_HOME", "EXTENSION_DEV_API_URL", "EXTENSION_DEV_APPROVAL_GATE", "EXTENSION_DEV_TOKEN", "EXTENSION_DEV_REGISTRY_URL"];

  function login(api: string): void {
    writeCredentials({ version: 1, token: "claims.sig", workspaceSlug: "acme", projectSlug: "widget", expiresAt: Math.floor(Date.now() / 1000) + 3600, api });
  }

  function world(api: string): void {
    process.env.EXTENSION_DEV_API_URL = api;
    login(api);
    routes = {
      "GET /api/cli/whoami": () => ({ body: { login: "acme/widget", live: true, projectId: PROJECT_ID, workspaceSlug: "acme", projectSlug: "widget" } }),
      [`GET /api/projects/${PROJECT_ID}/builds/${SHA}`]: () => ({ body: { buildId: SHA, status: "success", commit: SHA, browsers: [{ name: "chrome" }, { name: "firefox" }] } }),
      [`GET /api/projects/${PROJECT_ID}/builds/${SHA}/artifacts`]: () => ({ body: artifacts() }),
      [`GET /api/projects/${PROJECT_ID}/builds/${SHA}/usage`]: () => ({ body: {} }),
      [`GET /api/projects/${PROJECT_ID}/builds/${SHA}/integrity/chrome`]: () => ({ body: { ok: true, checks: [] } }),
      [`GET /api/projects/${PROJECT_ID}/builds/${SHA}/integrity/firefox`]: () => ({ body: { ok: true, checks: [] } }),
    };
  }

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "extdev-package-address-"));
    for (const key of envKeys) saved[key] = process.env[key];
    for (const key of envKeys) delete process.env[key];

    process.env.XDG_CONFIG_HOME = tmp;
    process.env.EXTENSION_DEV_APPROVAL_GATE = "0";
    routes = {};
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(input instanceof Request ? input.url : input));
        const method = String(init?.method ?? "GET").toUpperCase();
        const route = routes[`${method} ${url.pathname}`];
        const body = init?.body ? (JSON.parse(String(init.body)) as Row) : undefined;
        const answer = route ? route(body) : { status: 404, body: { message: "not found" } };

        return new Response(answer.body === null ? null : JSON.stringify(answer.body), { status: answer.status ?? 200, headers: { "content-type": "application/json" } });
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

  it("artifactWithAddress rewrites a package row only and passes a metadata, integrity or executable row through unchanged", () => {
    const scope = { ref: REF, sha: SHA, api: PROD };
    const integrity = `https://registry.extension.land/acme/widget/builds/${SHA}/artifact-integrity/chrome.json`;
    const metadata = `https://registry.extension.land/acme/widget/builds/${SHA}/chrome.json`;
    const executable = `https://registry.extension.land/acme/widget/builds/${SHA}/executables/widget-macos-arm64`;

    expect(artifactWithAddress({ name: "chrome-extension.zip", browser: "chrome", type: "Extension package", downloadUrl: REGISTRY_ZIP("chrome") }, scope)).toMatchObject({ downloadUrl: PACKAGE });
    expect(artifactWithAddress({ name: "chrome.integrity.json", type: "Integrity", downloadUrl: integrity }, scope)).toMatchObject({ downloadUrl: integrity });
    expect(artifactWithAddress({ name: "chrome.json", type: "Metadata", downloadUrl: metadata }, scope)).toMatchObject({ downloadUrl: metadata });
    expect(artifactWithAddress({ name: "widget-macos-arm64", type: "Executable", downloadUrl: executable }, scope)).toMatchObject({ downloadUrl: executable });
  });

  it("extension_shares create: a package the platform names at an unreadable path is refused without printing a registry address", async () => {
    world(PROD);
    routes[`GET /api/projects/${PROJECT_ID}/builds/${SHA}/artifacts`] = () => ({
      body: [{ name: "chrome-extension.zip", browser: "chrome", type: "Extension package", downloadUrl: "https://registry.extension.land/someone/else/chrome.zip?t=x" }],
    });

    const out = JSON.parse(await shares({ action: "create", buildId: SHA, api: PROD }));

    expect(out.status).toBe("unavailable");
    expect(out.error.name).toBe("SharesBuildPackageUnreadable");
    expect(out.error.message).toContain(`build ${SHA}'s chrome package`);
    expect(namesRegistryOrToken(JSON.stringify(out))).toEqual([]);
  });
});
