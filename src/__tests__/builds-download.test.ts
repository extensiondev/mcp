import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { handler as builds } from "../tools/builds";
import { writeCredentials } from "../lib/credentials";

const API = "http://localhost:3100";
const PROJECT_ID = "prj_leon";
const SHA = "7c80e15";
const FULL_SHA = `${SHA}0ff0ac1dae1c598428ce49ad43081c98`;
const TOKEN = "claims.sig-never-printed";
const EDGE_ZIP = Buffer.from("PK\u0003\u0004 the edge package the platform built");
const SOURCE_ZIP = Buffer.from("PK\u0003\u0004 the source archive");
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

const platform = vi.hoisted(() => ({
  relay: { status: 200, bytes: Buffer.alloc(0), headers: {} as Record<string, string>, body: null as unknown },
  report: { status: 200, body: null as unknown },
  calls: [] as Array<{ url: string; auth: string; accept: string }>,
}));

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("extension_builds download saves the platform's package through www", () => {
  let tmp: string;
  let project: string;
  let cache: string;
  let prevXdg: string | undefined;
  let prevCache: string | undefined;
  let prevApi: string | undefined;

  const cachedPath = (browser: string) => path.join(cache, "extension-dev", "artifacts", "acme", "leon", SHA, `${browser}.zip`);
  const projectEntries = () => fs.readdirSync(project).sort();

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "extdev-builds-download-"));
    project = path.join(tmp, "leon");
    cache = path.join(tmp, "cache");
    fs.mkdirSync(path.join(project, ".git"), { recursive: true });
    fs.writeFileSync(path.join(project, ".gitignore"), "node_modules/\ndist/\n");
    prevXdg = process.env.XDG_CONFIG_HOME;
    prevCache = process.env.XDG_CACHE_HOME;
    prevApi = process.env.EXTENSION_DEV_API_URL;
    delete process.env.EXTENSION_DEV_API_URL;
    process.env.XDG_CONFIG_HOME = path.join(tmp, "config");
    process.env.XDG_CACHE_HOME = cache;
    platform.calls = [];
    platform.relay = {
      status: 200,
      bytes: EDGE_ZIP,
      headers: { "x-artifact-sha256": sha256(EDGE_ZIP), "x-integrity-sha256": sha256(EDGE_ZIP), "x-integrity-report": "match" },
      body: null,
    };

    platform.report = { status: 200, body: { ok: true, browser: "edge", sha256: sha256(EDGE_ZIP), checks: [] } };

    writeCredentials({
      version: 1,
      token: TOKEN,
      workspaceSlug: "acme",
      projectSlug: "leon",
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      api: API,
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(input instanceof Request ? input.url : input));
        const headers = (init?.headers ?? {}) as Record<string, string>;
        platform.calls.push({ url: url.toString(), auth: String(headers.authorization ?? ""), accept: String(headers.accept ?? "") });

        if (url.hostname === "registry.extension.land") throw new Error("the registry answers 401 to a project token and must never be asked");

        if (url.pathname === "/api/cli/whoami") {
          return json({ login: "acme/leon", live: true, projectId: PROJECT_ID, workspaceSlug: "acme", projectSlug: "leon" });
        }

        const relay = /^\/api\/projects\/prj_leon\/builds\/([^/]+)\/artifacts\/([a-z]+\.zip)$/.exec(url.pathname);

        if (relay) {
          if (platform.relay.status !== 200) return json(platform.relay.body ?? { message: "refused" }, platform.relay.status);

          return new Response(platform.relay.bytes, {
            status: 200,
            headers: {
              "content-type": "application/zip",
              "content-length": String(platform.relay.bytes.byteLength),
              "content-disposition": `attachment; filename="${relay[2]}"`,
              ...platform.relay.headers,
            },
          });
        }

        if (/\/integrity\/[a-z]+$/.test(url.pathname)) return json(platform.report.body ?? { message: "no report" }, platform.report.status);

        throw new Error(`builds-download cells never reach the network (${url.pathname})`);
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prevXdg;
    if (prevCache === undefined) delete process.env.XDG_CACHE_HOME;
    else process.env.XDG_CACHE_HOME = prevCache;
    if (prevApi === undefined) delete process.env.EXTENSION_DEV_API_URL;
    else process.env.EXTENSION_DEV_API_URL = prevApi;

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("writes the edge package under the user's cache directory, keyed by workspace, project and build, and leaves the project's .gitignore byte-identical", async () => {
    if (process.platform === "win32") return;

    const ignoreBefore = fs.readFileSync(path.join(project, ".gitignore"));
    const entriesBefore = projectEntries();
    const raw = await builds({ action: "download", buildId: FULL_SHA, browser: "edge", projectPath: project, api: API });
    const out = JSON.parse(raw);
    const expectedPath = cachedPath("edge");

    expect(out.ok).toBe(true);
    expect(out.status).toBe("downloaded");
    expect(out.value).toMatchObject({
      action: "download",
      buildId: SHA,
      browser: "edge",
      path: expectedPath,
      bytes: EDGE_ZIP.byteLength,
      sha256: sha256(EDGE_ZIP),
      verified: true,
      report: "integrity-report",
    });

    expect(path.isAbsolute(out.value.path)).toBe(true);
    expect(out.value.path.startsWith(project)).toBe(false);
    expect(out.value.gitignored).toBeUndefined();
    expect(out.value.trackUrl).toMatch(/\/acme\/leon\/builds\/7c80e15$/);
    expect(out.value.sayToPerson).toBe(
      `Saved the platform's edge package for build ${SHA} at ${expectedPath}, byte-identical to what the integrity report describes (sha256 ${sha256(EDGE_ZIP)}). That is your cache directory, outside the project, whose files and .gitignore were not touched.`,
    );

    expect(out.hint).not.toContain(".gitignore was");

    expect(fs.readFileSync(expectedPath).equals(EDGE_ZIP)).toBe(true);
    expect(fs.readFileSync(path.join(project, ".gitignore")).equals(ignoreBefore)).toBe(true);
    expect(projectEntries()).toEqual(entriesBefore);
    expect(fs.existsSync(path.join(project, ".extension.dev"))).toBe(false);

    const relayCall = platform.calls.find((call) => call.url.includes("/artifacts/edge.zip"));
    expect(relayCall?.url).toBe(`${API}/api/projects/${PROJECT_ID}/builds/${FULL_SHA}/artifacts/edge.zip`);
    expect(relayCall?.auth).toBe(`Bearer ${TOKEN}`);
    expect(relayCall?.accept).toContain("application/zip");
    expect(platform.calls.some((call) => call.url.includes("registry.extension.land"))).toBe(false);
    expect(raw).not.toContain(TOKEN);
    expect(raw).not.toMatch(/github\.com|actions\/runs/);
  });

  it("needs no projectPath for the default destination, and a project with no .gitignore gets the file without one being created", async () => {
    if (process.platform === "win32") return;

    fs.rmSync(path.join(project, ".gitignore"));

    const entriesBefore = projectEntries();

    const bare = JSON.parse(await builds({ action: "download", buildId: SHA, browser: "edge", api: API }));

    expect(bare.ok).toBe(true);
    expect(bare.status).toBe("downloaded");
    expect(bare.value.path).toBe(cachedPath("edge"));
    expect(fs.readFileSync(bare.value.path).equals(EDGE_ZIP)).toBe(true);

    const withProject = JSON.parse(await builds({ action: "download", buildId: SHA, browser: "edge", projectPath: project, api: API }));

    expect(withProject.ok).toBe(true);
    expect(withProject.value.path).toBe(cachedPath("edge"));
    expect(fs.existsSync(path.join(project, ".gitignore"))).toBe(false);
    expect(projectEntries()).toEqual(entriesBefore);
  });

  it("refuses the file and says not to upload it when the bytes are not the ones the report describes", async () => {
    if (process.platform === "win32") return;

    platform.report = { status: 200, body: { ok: true, browser: "edge", sha256: "a".repeat(64) } };

    const out = JSON.parse(await builds({ action: "download", buildId: SHA, browser: "edge", projectPath: project, api: API }));

    expect(out.ok).toBe(false);
    expect(out.status).toBe("integrity-mismatch");
    expect(out.error).toMatchObject({ code: "E_PLATFORM", name: "BuildsArtifactMismatch" });
    expect(out.value).toMatchObject({ verified: false, sha256: sha256(EDGE_ZIP), expectedSha256: "a".repeat(64) });
    expect(out.value.sayToPerson).toContain("is not the file the integrity report describes");
    expect(out.value.sayToPerson).toContain("Do not upload it");
    expect(out.value.sayToPerson).toContain(`action: "recheck", buildId: "${SHA}"`);
    expect(fs.existsSync(out.value.path)).toBe(true);
  });

  it("answers no-report when neither the integrity report nor the relay names a digest", async () => {
    if (process.platform === "win32") return;

    platform.report = { status: 404, body: { message: "no report" } };
    platform.relay.headers = { "x-artifact-sha256": sha256(EDGE_ZIP), "x-integrity-report": "absent" };

    const out = JSON.parse(await builds({ action: "download", buildId: SHA, browser: "edge", projectPath: project, api: API }));

    expect(out.ok).toBe(true);
    expect(out.value).toMatchObject({ verified: "no-report", report: "none", sha256: sha256(EDGE_ZIP) });
    expect(out.value.sayToPerson).toContain("unverified");
    expect(out.warnings.join(" ")).toContain('action: "recheck"');
  });

  it("saves the source archive into the directory `to` names and verifies it by the digest the relay repeats from the build record", async () => {
    if (process.platform === "win32") return;

    const to = path.join(tmp, "elsewhere");
    platform.relay = {
      status: 200,
      bytes: SOURCE_ZIP,
      headers: { "x-artifact-sha256": sha256(SOURCE_ZIP), "x-integrity-sha256": sha256(SOURCE_ZIP), "x-integrity-report": "match" },
      body: null,
    };

    const ignoreBefore = fs.readFileSync(path.join(project, ".gitignore"));
    const out = JSON.parse(await builds({ action: "download", buildId: SHA, browser: "source", to, api: API }));

    expect(out.ok).toBe(true);
    expect(out.value).toMatchObject({ browser: "source", path: path.join(to, "source.zip"), verified: true, report: "build-record" });
    expect(out.value.gitignored).toBeUndefined();
    expect(out.value.sayToPerson).toContain("source archive");
    expect(out.value.sayToPerson).toContain("The project's files and .gitignore were not touched.");
    expect(fs.readFileSync(path.join(to, "source.zip")).equals(SOURCE_ZIP)).toBe(true);
    expect(fs.existsSync(cachedPath("source"))).toBe(false);
    expect(platform.calls.some((call) => /\/integrity\//.test(call.url))).toBe(false);

    const relative = JSON.parse(await builds({ action: "download", buildId: SHA, browser: "source", to: "packages/out", projectPath: project, api: API }));

    expect(relative.value.path).toBe(path.join(project, "packages", "out", "source.zip"));
    expect(path.isAbsolute(relative.value.path)).toBe(true);
    expect(fs.readFileSync(path.join(project, ".gitignore")).equals(ignoreBefore)).toBe(true);
  });

  it("writes nothing when the platform refuses the token with 401 or 403", async () => {
    if (process.platform === "win32") return;

    for (const [status, code] of [
      [401, "UNAUTHENTICATED"],
      [403, "TOKEN_PROJECT_MISMATCH"],
    ] as const) {
      platform.relay = { status, bytes: Buffer.alloc(0), headers: {}, body: { message: "refused", code } };

      const out = JSON.parse(await builds({ action: "download", buildId: SHA, browser: "edge", projectPath: project, api: API }));

      expect(out.ok, String(status)).toBe(false);
      expect(out.status, String(status)).toBe("refused");
      expect(out.error.code, String(status)).toBe("E_AUTH_DENIED");
      expect(out.error.platformCode, String(status)).toBe(code);
      expect(out.value.trackUrl, String(status)).toMatch(/\/builds\/7c80e15$/);
      expect(fs.existsSync(path.join(project, ".extension.dev")), String(status)).toBe(false);
      expect(fs.existsSync(cache), String(status)).toBe(false);
    }
  });

  it("answers not-found for a browser the build never produced", async () => {
    if (process.platform === "win32") return;

    platform.relay = { status: 404, bytes: Buffer.alloc(0), headers: {}, body: { message: "Build 7c80e15 has no safari.zip in the registry.", code: "BUILD_FILE_NOT_FOUND" } };

    const out = JSON.parse(await builds({ action: "download", buildId: SHA, browser: "safari", projectPath: project, api: API }));

    expect(out.ok).toBe(false);
    expect(out.status).toBe("not-found");
    expect(out.error).toMatchObject({ code: "E_BUILD_NOT_FOUND", platformCode: "BUILD_FILE_NOT_FOUND" });
    expect(out.hint).toContain('action: "get"');
  });

  it("refuses before asking the platform when the browser or the build is missing", async () => {
    if (process.platform === "win32") return;

    const noBrowser = JSON.parse(await builds({ action: "download", buildId: SHA, projectPath: project, api: API }));
    expect(noBrowser.status).toBe("bad-request");
    expect(noBrowser.error.message).toContain("chrome, edge, firefox, safari");

    const noBuild = JSON.parse(await builds({ action: "download", browser: "edge", projectPath: project, api: API }));
    expect(noBuild.status).toBe("bad-request");
    expect(platform.calls).toEqual([]);
  });
});
