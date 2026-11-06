import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { handler as builds } from "../tools/builds";
import { handler as publish } from "../tools/publish";
import { writeCredentials } from "../lib/credentials";

const API = "http://localhost:3100";
const PROJECT_ID = "prj_rebeccat";
const SHA = "bc5fc4f";
const BUILD_ROUTE = `/api/projects/${PROJECT_ID}/builds/${SHA}`;
const RECORDED = ["chrome", "edge", "firefox"];

type Route = { body?: unknown; status?: number; raw?: string };

function response(route: Route): Response {
  const status = route.status ?? 200;
  const textBody = route.raw !== undefined ? route.raw : JSON.stringify(route.body ?? null);

  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    text: async () => textBody,
    json: async () => JSON.parse(textBody),
  } as unknown as Response;
}

function packageRow(browser: string, size: string) {
  return {
    name: `${browser}-extension.zip`,
    browser,
    size,
    type: "Extension package",
    downloadUrl: `https://registry.extension.land/cezaraugusto/rebeccat/builds/${SHA}/${browser}.zip`,
  };
}

const DETAIL = {
  id: SHA,
  buildId: SHA,
  status: "success",
  conclusion: "success",
  commit: "bc5fc4f84ac79a44b50f4300817597b96bdd4870",
  duration: "4m 6s",
  startedAt: "2026-11-05T20:40:00Z",
  completedAt: "2026-11-05T20:44:06Z",
  browsers: RECORDED.map((name) => ({ name, status: "success", duration: "4m 6s", size: "-" })),
};

const ARTIFACTS = [
  packageRow("chrome", "35.3 MB"),
  packageRow("edge", "35.3 MB"),
  packageRow("firefox", "35.4 MB"),
  packageRow("safari", "25.0 MB"),
  { name: "safari-metadata.json", browser: "safari", size: "1.2 KB", type: "Metadata", downloadUrl: `https://registry.extension.land/cezaraugusto/rebeccat/builds/${SHA}/safari-metadata.json` },
  { name: "source.zip", browser: "source", size: "2.0 MB", type: "Source archive", downloadUrl: `https://registry.extension.land/cezaraugusto/rebeccat/builds/${SHA}/source.zip` },
];

let tmp: string;
let prevXdg: string | undefined;
let prevApi: string | undefined;
let prevToken: string | undefined;
let prevFetch: typeof fetch;
let routes: Record<string, Route>;
let calls: string[];

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "extdev-builds-unrecorded-"));
  prevXdg = process.env.XDG_CONFIG_HOME;
  prevApi = process.env.EXTENSION_DEV_API_URL;
  prevToken = process.env.EXTENSION_DEV_TOKEN;
  delete process.env.EXTENSION_DEV_API_URL;
  delete process.env.EXTENSION_DEV_TOKEN;
  process.env.XDG_CONFIG_HOME = tmp;
  prevFetch = global.fetch;
  calls = [];
  routes = {
    "/api/cli/whoami": {
      body: { login: "cezaraugusto/rebeccat", live: true, projectId: PROJECT_ID, workspaceSlug: "cezaraugusto", projectSlug: "rebeccat" },
    },
    [BUILD_ROUTE]: { body: DETAIL },
    [`${BUILD_ROUTE}/usage`]: { body: { markdown: null, updatedAt: null } },
    [`${BUILD_ROUTE}/artifacts`]: { body: ARTIFACTS },
    ...Object.fromEntries(RECORDED.map((name) => [`${BUILD_ROUTE}/integrity/${name}`, { body: { ok: true, checks: [{ id: "zip-structure", ok: true }] } }])),
    "/api/cli/publish": {
      body: {
        shareUrl: `https://cezaraugusto.extension.dev/rebeccat/builds/${SHA}`,
        visibility: "public",
        buildSha: SHA,
        previewCommands: Object.fromEntries(
          [...RECORDED, "safari"].map((b) => [b, `npx -y extension@latest preview https://cezaraugusto.extension.dev/rebeccat/builds/${SHA}/${b}.zip --browser=${b}`]),
        ),
      },
    },
  };

  global.fetch = (async (url: string) => {
    const pathname = new URL(String(url)).pathname;
    calls.push(pathname);
    const route = routes[pathname];

    return route ? response(route) : response({ body: { message: "not found" }, status: 404 });
  }) as unknown as typeof fetch;

  writeCredentials({
    version: 1,
    token: "claims.sig",
    workspaceSlug: "cezaraugusto",
    projectSlug: "rebeccat",
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    api: API,
  });
});

afterEach(() => {
  if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = prevXdg;
  if (prevApi === undefined) delete process.env.EXTENSION_DEV_API_URL;
  else process.env.EXTENSION_DEV_API_URL = prevApi;
  if (prevToken === undefined) delete process.env.EXTENSION_DEV_TOKEN;
  else process.env.EXTENSION_DEV_TOKEN = prevToken;

  global.fetch = prevFetch;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("406: extension_builds get answers every browser the artifact list carries, or names it as unchecked", () => {
  async function get(args: Record<string, unknown> = {}) {
    const out = JSON.parse(await builds({ action: "get", buildId: SHA, api: API, ...args }));
    expect(out.ok).toBe(true);

    return out;
  }

  it("lists a Safari package the record has no row for as unchecked, with the reason, and does not claim every check passed", async () => {
    if (process.platform === "win32") return;

    const out = await get();
    const names = out.value.build.browsers.map((row: { name: string }) => row.name);

    expect(names).toEqual(["chrome", "edge", "firefox", "safari"]);
    expect(out.value.build.browsers[3]).toMatchObject({ name: "safari", recorded: false, size: "25.0 MB" });
    expect(Object.keys(out.value.integrity)).toEqual(RECORDED);
    expect(out.value.unchecked).toEqual([
      {
        browser: "safari",
        reason: "the platform's record of this build has no row for safari yet, while its artifact list carries a safari package, and its integrity result is missing (404)",
      },
    ]);

    expect(out.hint).not.toContain("every integrity check passed");
    expect(out.hint).toContain("integrity was not checked for safari (see unchecked)");
    expect(out.warnings).toContain(
      "The platform's record of build bc5fc4f has no row for safari while its artifact list carries a package for it, so that browser row is derived from the artifact with no build status.",
    );

    expect(calls).toContain(`${BUILD_ROUTE}/integrity/safari`);
  });

  it("reads Safari's integrity when the platform has it and names Safari as not recorded instead of saying every check passed", async () => {
    if (process.platform === "win32") return;

    routes[`${BUILD_ROUTE}/integrity/safari`] = { body: { ok: true, checks: [{ id: "zip-structure", ok: true }] } };
    const out = await get();

    expect(Object.keys(out.value.integrity)).toEqual([...RECORDED, "safari"]);
    expect(out.value.integrity.safari).toMatchObject({ ok: true, failed: [] });
    expect(out.value.unchecked).toBeUndefined();
    expect(out.hint).not.toContain("every integrity check passed");
    expect(out.hint).toContain("safari is not recorded in the build record");
    expect(out.value.build.browsers[3]).toMatchObject({ name: "safari", recorded: false, submitReady: true });
  });

  it("scopes a derived browser by the browser argument like a recorded one", async () => {
    if (process.platform === "win32") return;

    const safari = await get({ browser: "safari" });
    const chrome = await get({ browser: "chrome" });

    expect(safari.value.unchecked.map((row: { browser: string }) => row.browser)).toEqual(["safari"]);
    expect(Object.keys(safari.value.integrity)).toEqual([]);
    expect(Object.keys(chrome.value.integrity)).toEqual(["chrome"]);
    expect(chrome.value.unchecked).toBeUndefined();
    expect(chrome.hint).toContain("every integrity check passed");
  });

  it("changes nothing when the record and the artifact list name the same browsers", async () => {
    if (process.platform === "win32") return;

    routes[`${BUILD_ROUTE}/artifacts`] = { body: ARTIFACTS.filter((row) => row.browser !== "safari") };
    const out = await get();

    expect(out.value.build.browsers.map((row: { name: string }) => row.name)).toEqual(RECORDED);
    expect(out.value.unchecked).toBeUndefined();
    expect(out.hint).toContain("every integrity check passed");
    expect(out.warnings.join(" ")).not.toContain("has no row for");
  });
});

describe("406: extension_publish names a package with no integrity row as unchecked instead of dropping it", () => {
  async function publishBuild() {
    const out = JSON.parse(await publish({ buildSha: SHA, api: API }));
    expect(out.ok).toBe(true);

    return out;
  }

  it("puts Safari in artifacts.unchecked with the missing record row as the reason", async () => {
    if (process.platform === "win32") return;

    const out = await publishBuild();

    expect(out.value.artifacts).toMatchObject({ checked: true, good: RECORDED, failed: [], unchecked: ["safari"] });
    expect(out.value.artifacts.browsers.safari).toMatchObject({ status: null, integrity: "unread", recorded: false });
    expect(out.warnings).toContain(
      "Integrity was not checked for Safari: the platform's record of this build has no row for safari yet, while its artifact list carries a safari package, and no integrity result could be read for it, so nothing here vouches for that package.",
    );

    expect(Object.keys(out.value.previewCommands)).toEqual([...RECORDED, "safari"]);
  });

  it("counts Safari as good once its integrity reads passed", async () => {
    if (process.platform === "win32") return;

    routes[`${BUILD_ROUTE}/integrity/safari`] = { body: { ok: true, checks: [{ id: "zip-structure", ok: true }] } };
    const out = await publishBuild();

    expect(out.value.artifacts).toMatchObject({ checked: true, good: [...RECORDED, "safari"], failed: [], unchecked: [] });
    expect(out.value.artifacts.browsers.safari).toMatchObject({ integrity: "passed", recorded: false });
    expect(out.warnings.join(" ")).not.toContain("Integrity was not checked");
  });
});
