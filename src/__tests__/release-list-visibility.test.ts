import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readReleases } from "../tools/release-list";
import { asProjectVisibility } from "../lib/platform-visibility";
import { writeCredentials } from "../lib/credentials";

const API = "http://localhost:3100";
const ALPHA_ID = "prj_alpha";

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    text: async () => JSON.stringify(body),
    json: async () => body,
  } as unknown as Response;
}

const CHANNELS = { channels: { stable: { sha: "0c7471e0c7471e0c7471e0c7471e0c7471e0c7471e", audience: "public" } } };
const BUILDS = { items: [] };

describe("extension_release_status include releases answers the platform's project visibility", () => {
  let tmp: string;
  let saved: Record<string, string | undefined>;
  let prevFetch: typeof fetch;
  let calls: string[];
  let registry: Record<string, { body: unknown; status?: number }>;
  let platform: Record<string, { body: unknown; status?: number }>;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "extdev-visibility-read-"));
    saved = {};

    for (const key of ["XDG_CONFIG_HOME", "EXTENSION_DEV_API_URL", "EXTENSION_DEV_TOKEN", "EXTENSION_DEV_PROJECT"]) {
      saved[key] = process.env[key];
      delete process.env[key];
    }

    process.env.XDG_CONFIG_HOME = tmp;
    prevFetch = global.fetch;
    calls = [];
    registry = {
      "channels.json": { body: CHANNELS },
      "meta.json": { body: { name: "Alpha", visibility: "public" } },
      "builds/index.json": { body: BUILDS },
    };

    platform = { [`/api/projects/${ALPHA_ID}/visibility`]: { body: { projectId: ALPHA_ID, visibility: "private", registry: {}, effective: {} } } };

    global.fetch = (async (url: string, init?: RequestInit) => {
      const target = String(url);
      const headers = (init?.headers ?? {}) as Record<string, string>;
      calls.push(target);
      const pathname = new URL(target).pathname;

      if (pathname === "/api/cli/whoami") {
        return headers.authorization === "Bearer alpha.sig"
          ? jsonResponse({ live: true, projectId: ALPHA_ID, workspaceSlug: "acme", projectSlug: "alpha" })
          : jsonResponse({ message: "bad" }, 401);
      }

      const route = platform[pathname];
      if (route) return jsonResponse(route.body, route.status ?? 200);

      for (const [suffix, file] of Object.entries(registry)) {
        if (pathname.endsWith(`/${suffix}`)) return jsonResponse(file.body, file.status ?? 200);
      }

      return jsonResponse({ message: "not found" }, 404);
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }

    global.fetch = prevFetch;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function login() {
    writeCredentials({
      version: 1,
      token: "alpha.sig",
      workspaceSlug: "acme",
      projectSlug: "alpha",
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      api: API,
    });
  }

  it("takes projectVisibility from the platform's record and says when the registry disagrees", async () => {
    if (process.platform === "win32") return;

    login();

    const out = JSON.parse(await readReleases({ api: API }));

    expect(out.ok).toBe(true);
    expect(out.value.projectVisibility).toBe("private");
    expect(out.value.projectVisibilitySource).toBe("platform");
    expect(out.value.visibility).toBe("public");
    expect(out.value.channels[0].channelUrl).toContain("/channels/");
    expect(out.value.channelUrlWithheld).toBeUndefined();
    expect(out.warnings.join(" ")).toContain("records this project as private while the registry's meta.json says public");
    expect(calls.some((url) => new URL(url).pathname === `/api/projects/${ALPHA_ID}/visibility`)).toBe(true);
  });

  it("keeps channelUrlWithheld on a private project and says nothing when the two records agree", async () => {
    if (process.platform === "win32") return;

    login();
    registry["meta.json"] = { body: { name: "Alpha", visibility: "private" } };

    const out = JSON.parse(await readReleases({ api: API }));

    expect(out.value.projectVisibility).toBe("private");
    expect(out.value.projectVisibilitySource).toBe("platform");
    expect(out.value.channelUrlWithheld).toBeTruthy();
    expect(out.value.channels[0].channelUrl).toBeUndefined();
    expect(out.warnings.join(" ")).not.toContain("meta.json says");
  });

  it("falls back to the registry's meta.json when no login covers the project", async () => {
    if (process.platform === "win32") return;

    const out = JSON.parse(await readReleases({ workspace: "acme", project: "alpha", api: API }));

    expect(out.ok).toBe(true);
    expect(out.value.projectVisibility).toBe("public");
    expect(out.value.projectVisibilitySource).toBe("registry");
    expect(out.warnings.join(" ")).not.toContain("visibility record could not be read");
    expect(calls.some((url) => new URL(url).pathname.endsWith("/visibility"))).toBe(false);
  });

  it("names a platform read that failed and still answers the registry's copy", async () => {
    if (process.platform === "win32") return;

    login();
    platform[`/api/projects/${ALPHA_ID}/visibility`] = { body: { message: "boom" }, status: 500 };

    const out = JSON.parse(await readReleases({ api: API }));

    expect(out.ok).toBe(true);
    expect(out.value.projectVisibility).toBe("public");
    expect(out.value.projectVisibilitySource).toBe("registry");
    expect(out.warnings.join(" ")).toContain("visibility record could not be read");
    expect(out.warnings.join(" ")).toContain("500");
  });

  it("answers null when neither record could be read", async () => {
    if (process.platform === "win32") return;

    login();
    platform[`/api/projects/${ALPHA_ID}/visibility`] = { body: { message: "boom" }, status: 500 };
    registry["meta.json"] = { body: { message: "gone" }, status: 404 };

    const out = JSON.parse(await readReleases({ api: API }));

    expect(out.value.projectVisibility).toBeNull();
    expect(out.value.projectVisibilitySource).toBeNull();
    expect(out.warnings.join(" ")).toContain("could not be read either");
  });

  it("treats any value but public or private as no answer", () => {
    expect(asProjectVisibility(" Public ")).toBe("public");
    expect(asProjectVisibility("private")).toBe("private");
    expect(asProjectVisibility("unlisted")).toBeNull();
    expect(asProjectVisibility(undefined)).toBeNull();
  });
});
