import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { handler as builds } from "../tools/builds";
import { writeCredentials } from "../lib/credentials";

const API = "http://localhost:3100";
const PROJECT_ID = "prj_rebeccat";
const SHA = "6b393ca";
const BUILD_ROUTE = `/api/projects/${PROJECT_ID}/builds/${SHA}`;

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

function finished(browsers: unknown[]): Record<string, unknown> {
  return {
    id: SHA,
    buildId: SHA,
    status: "success",
    conclusion: "success",
    commit: "6b393ca0e1f2a3b4c5d6e7f8091a2b3c4d5e6f70",
    duration: "4m 6s",
    startedAt: "2026-11-01T00:17:35Z",
    completedAt: "2026-11-01T00:21:41Z",
    browsers,
  };
}

const NAMES = ["chrome", "edge", "firefox", "safari"];

describe("ledger 358: extension_builds get labels a shared duration and keeps each package's own bytes", () => {
  let tmp: string;
  let prevXdg: string | undefined;
  let prevApi: string | undefined;
  let prevFetch: typeof fetch;
  let routes: Record<string, Route>;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "extdev-builds-figures-"));
    prevXdg = process.env.XDG_CONFIG_HOME;
    prevApi = process.env.EXTENSION_DEV_API_URL;
    delete process.env.EXTENSION_DEV_API_URL;
    process.env.XDG_CONFIG_HOME = tmp;
    prevFetch = global.fetch;
    routes = {
      "/api/cli/whoami": {
        body: { login: "cezaraugusto/rebeccat", live: true, projectId: PROJECT_ID, workspaceSlug: "cezaraugusto", projectSlug: "rebeccat" },
      },
      [`${BUILD_ROUTE}/usage`]: { body: { markdown: null, updatedAt: null } },
      [`${BUILD_ROUTE}/artifacts`]: { body: [] },
      ...Object.fromEntries(NAMES.map((name) => [`${BUILD_ROUTE}/integrity/${name}`, { body: { ok: true, checks: [] } }])),
    };

    global.fetch = (async (url: string) => {
      const route = routes[new URL(String(url)).pathname];

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

    global.fetch = prevFetch;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  async function get() {
    const out = JSON.parse(await builds({ action: "get", buildId: SHA, api: API }));
    expect(out.ok).toBe(true);

    return out;
  }

  it("marks every browser that repeats the whole build's duration as durationScope build and says per-browser time is not recorded", async () => {
    if (process.platform === "win32") return;

    routes[BUILD_ROUTE] = { body: finished(NAMES.map((name) => ({ name, status: "success", duration: "4m 6s", size: "35.3 MB" }))) };
    const out = await get();

    for (const row of out.value.build.browsers) expect(row).toMatchObject({ duration: "4m 6s", durationScope: "build" });

    expect(out.warnings).toContain(
      'Per-browser build time is not recorded for build 6b393ca: the duration on chrome, edge, firefox, safari (4m 6s) is the whole build\'s, marked durationScope "build".',
    );

    expect(out.warnings).toContain(
      "Every browser's size reads 35.3 MB, rounded to 0.1 MB, and the platform sent no exact bytes, so packages that differ by less than that read the same; the download action answers each package's bytes.",
    );
  });

  it("keeps a browser's own duration and exact bytes as they came, with no note", async () => {
    if (process.platform === "win32") return;

    routes[BUILD_ROUTE] = {
      body: finished([
        { name: "chrome", status: "success", duration: "0m 28s", durationScope: "browser", size: "35.3 MB", bytes: 37012345 },
        { name: "firefox", status: "success", duration: "0m 31s", size: "35.3 MB", bytes: 37013001 },
      ]),
    };

    const out = await get();
    const [chrome, firefox] = out.value.build.browsers;

    expect(chrome).toMatchObject({ duration: "0m 28s", durationScope: "browser", bytes: 37012345 });
    expect(firefox).toMatchObject({ duration: "0m 31s", bytes: 37013001 });
    expect(firefox.durationScope).toBeUndefined();
    expect(out.warnings.join(" ")).not.toContain("Per-browser build time");
    expect(out.warnings.join(" ")).not.toContain("rounded to 0.1 MB");
  });

  it("answers the platform's own build scope mark even when the text differs from the build's duration", async () => {
    if (process.platform === "win32") return;

    routes[BUILD_ROUTE] = { body: finished([{ name: "chrome", status: "success", duration: "4m 5s", durationScope: "build", size: "1.2 MB", bytes: 1258291 }]) };
    const out = await get();

    expect(out.value.build.browsers[0].durationScope).toBe("build");
    expect(out.warnings.join(" ")).toContain("the duration on chrome (4m 5s) is the whole build's");
  });
});
