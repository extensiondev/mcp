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

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { handler as builds } from "../tools/builds";
import { writeCredentials } from "../lib/credentials";

const API = "http://localhost:3100";
const PROJECT_ID = "prj_visionario";
const SHA = "6fb8b3e";
const COMMIT = "6fb8b3eb47037d076fe194f070b03ce247c537c0";
const PROJECT_ROUTE = `/api/projects/${PROJECT_ID}`;
const BUILD_ROUTE = `${PROJECT_ROUTE}/builds/${SHA}`;
const RECORDED = ["chrome", "edge", "firefox"];
const ALL = [...RECORDED, "safari"];
const PASSED = { ok: true, checks: [{ id: "zip-structure", ok: true }, { id: "manifest", ok: true }, { id: "sha256", ok: true }] };

type Route = { body?: unknown; status?: number };

function response(route: Route): Response {
  const status = route.status ?? 200;
  const body = JSON.stringify(route.body ?? null);

  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    text: async () => body,
    json: async () => JSON.parse(body),
  } as unknown as Response;
}

function artifactRows(browser: string) {
  return [
    { name: `${browser}-extension.zip`, browser, size: "18.0 MB", type: "Extension package", downloadUrl: `https://registry.extension.land/cezaraugusto/visionario/builds/${SHA}/${browser}.zip` },
    { name: `${browser}.json`, browser, size: "2.9 KB", type: "Build metadata", downloadUrl: `https://registry.extension.land/cezaraugusto/visionario/builds/${SHA}/${browser}.json` },
  ];
}

function recordRow(name: string, status = "success") {
  return { name, status, duration: "9s", durationScope: "browser", size: "18.0 MB" };
}

function detail(browsers: unknown[], extra: Record<string, unknown> = {}) {
  return {
    id: SHA,
    buildId: SHA,
    buildNumber: 16,
    status: "success",
    commit: COMMIT,
    duration: "2m 33s",
    startedAt: "2026-11-06T19:51:33Z",
    completedAt: "2026-11-06T19:54:06Z",
    browsers,
    ...extra,
  };
}

let tmp: string;
let prevXdg: string | undefined;
let prevApi: string | undefined;
let prevToken: string | undefined;
let prevFetch: typeof fetch;
let routes: Record<string, Route>;
let calls: string[];

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "extdev-builds-460-"));
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
      body: { login: "cezaraugusto/visionario", live: true, projectId: PROJECT_ID, workspaceSlug: "cezaraugusto", projectSlug: "visionario" },
    },
    [BUILD_ROUTE]: { body: detail(RECORDED.map((name) => recordRow(name))) },
    [`${BUILD_ROUTE}/usage`]: { body: { markdown: null, updatedAt: null } },
    [`${BUILD_ROUTE}/artifacts`]: { body: ALL.flatMap(artifactRows) },
    ...Object.fromEntries(ALL.map((name) => [`${BUILD_ROUTE}/integrity/${name}`, { body: PASSED }])),
    [`${PROJECT_ROUTE}/builds`]: {
      body: { items: [{ buildId: SHA, commit: COMMIT, status: "success", buildEnv: "production", channel: "stable" }] },
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
    projectSlug: "visionario",
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

async function get(args: Record<string, unknown> = {}) {
  const out = JSON.parse(await builds({ action: "get", buildId: SHA, api: API, ...args }));
  expect(out.ok).toBe(true);

  return out;
}

describe("460: extension_builds get never sums a build with an unrecorded browser as every integrity check passed", () => {
  it("names Safari as not recorded, with its payload built and signed at submit, when its package passed integrity", async () => {
    if (process.platform === "win32") return;

    const out = await get();
    const safari = out.value.build.browsers.find((row: { name: string }) => row.name === "safari");

    expect(out.hint).not.toContain("every integrity check passed");
    expect(out.hint).toContain("every integrity check of chrome, edge, firefox passed");
    expect(out.hint).toContain(
      "safari is not recorded in the build record: its payload is built and passed its integrity checks, and Safari is signed at submit, so a Safari submit can go ahead (see build.browsers)",
    );

    expect(safari).toMatchObject({ name: "safari", recorded: false, payloadBuilt: true, signedAtSubmit: true, submitReady: true, integrity: { ok: true, checks: 3 } });
    expect(safari.reason).toContain("no safari row, so no build status is recorded for it");
    expect(safari.reason).toContain("Safari is signed at submit, not in this build, so a Safari submit can go ahead with this build");
    expect(out.value.unchecked).toBeUndefined();
  });

  it("names Safari as not recorded with no integrity read, and never as passed, when its integrity result is missing", async () => {
    if (process.platform === "win32") return;

    routes[`${BUILD_ROUTE}/integrity/safari`] = { status: 404, body: { message: "not found" } };
    const out = await get();
    const safari = out.value.build.browsers.find((row: { name: string }) => row.name === "safari");

    expect(out.hint).not.toContain("every integrity check passed");
    expect(out.hint).not.toContain("submit can go ahead");
    expect(out.hint).toContain("integrity was not checked for safari (see unchecked)");
    expect(safari).toMatchObject({ name: "safari", recorded: false });
    expect(safari.submitReady).toBeUndefined();
    expect(safari.reason).toContain("no integrity result could be read for its package");
  });

  it("says a Safari row still running is still running, never passed, under a build that reads success", async () => {
    if (process.platform === "win32") return;

    routes[BUILD_ROUTE] = { body: detail([...RECORDED.map((name) => recordRow(name)), recordRow("safari", "building")]) };
    routes[`${BUILD_ROUTE}/artifacts`] = { body: RECORDED.flatMap(artifactRows) };
    delete routes[`${BUILD_ROUTE}/integrity/safari`];
    const out = await get();

    expect(out.hint).not.toContain("every integrity check passed");
    expect(out.hint).toContain("integrity was not checked for safari (see unchecked)");
    expect(out.value.unchecked).toEqual([
      { browser: "safari", reason: "it is still running (its row reads building); its artifacts and integrity arrive when it finishes" },
    ]);
  });

  it("surfaces env and channel from the build record when the record carries them, without reading the list", async () => {
    if (process.platform === "win32") return;

    routes[BUILD_ROUTE] = { body: detail(ALL.map((name) => recordRow(name)), { buildEnv: "staging", channel: "preview" }) };
    const out = await get();

    expect(out.value.build).toMatchObject({ env: "staging", channel: "preview" });
    expect(calls).not.toContain(`${PROJECT_ROUTE}/builds`);
  });

  it("fills env and channel from the build's list row when the detail record carries neither", async () => {
    if (process.platform === "win32") return;

    const out = await get();

    expect(out.value.build).toMatchObject({ env: "production", channel: "stable" });
    expect(calls).toContain(`${PROJECT_ROUTE}/builds`);
  });

  it("keeps the every integrity check passed wording when all four browsers are recorded and passed", async () => {
    if (process.platform === "win32") return;

    routes[BUILD_ROUTE] = { body: detail(ALL.map((name) => recordRow(name))) };
    const out = await get();

    expect(out.hint).toContain("Build #16 (6fb8b3e) is success; every integrity check passed.");
    expect(out.value.unchecked).toBeUndefined();

    for (const row of out.value.build.browsers) {
      expect(row.recorded).toBeUndefined();
      expect(row.reason).toBeUndefined();
    }
  });
});
