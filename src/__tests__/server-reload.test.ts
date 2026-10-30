import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createServer } from "../index";
import { credentialKey, writeCredentials } from "../lib/credentials";
import { ENVELOPE_SCHEMA } from "../lib/envelope";
import { RELOAD_CONTRACT, buildSpecifier, type BuildImporter } from "../lib/server-reload";
import { registerSession } from "../lib/process-manager";
import { createServerStamp, reloadedWarning, staleLocalWarning, staleSentence, type ServerStampReader } from "../lib/server-stamp";
import { noLocalCarryReason } from "../lib/stale-local";

import { version } from "../../package.json";

import type { ServerOptions } from "../lib/tool-policy";

const API = "http://localhost:3100";
const PROJECT_ID = "prj_probe";
const OPTIONS: ServerOptions = { features: ["local", "platform"], noShip: false };
const BUILT = "2026-10-23T22:27:06.000Z";
const REBUILT = "2026-10-23T23:37:13.000Z";
const REBUILT_AGAIN = "2026-10-24T01:46:15.000Z";

const BUILD_ROW = {
  id: "603fc8a",
  buildId: "603fc8a",
  commit: "603fc8ab0ff0ac1dae1c598428ce49ad43081c98",
  status: "success",
  buildEnv: "production",
  timestamp: "2026-10-11T16:45:37Z",
  branch: "main",
  browsers: ["chrome"],
  channel: "preview",
};

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    text: async () => JSON.stringify(body),
    json: async () => body,
  } as unknown as Response;
}

function fixtureBuild(answeredBy: string, carriesLocal = true): string {
  return [
    "let adopted = null;",
    "export function adoptHandover(state) { adopted = state; }",
    carriesLocal
      ? `export function handoverState() { return { ...adopted, trail: [...(adopted.trail ?? []), ${JSON.stringify(answeredBy)}] }; }`
      : `export function handoverState() { const { local, ...rest } = adopted; return { ...rest, trail: [...(adopted.trail ?? []), ${JSON.stringify(answeredBy)}] }; }`,
    `export function stampRebuilt() { return { version: "99.0.0+${answeredBy}", commit: ${JSON.stringify(answeredBy)}, builtAt: null, startedAt: "x", pid: 0 }; }`,
    'export function assertChecksRebuilt() { return ["background-worker-booted", "page-world-clean", "page-world-sealed"]; }',
    "export async function dispatchRebuilt(call) {",
    `  const value = { answeredBy: ${JSON.stringify(answeredBy)}, args: call.arguments, options: adopted.options, keptLogins: adopted.keptLogins, trail: adopted.trail ?? [], localSessions: adopted.local ? [...adopted.local.sessions.values()].map((s) => s.pid) : null };`,
    `  const text = JSON.stringify({ schema: ${JSON.stringify(ENVELOPE_SCHEMA)}, ok: true, command: call.name, status: "listed", value, error: null, warnings: [] });`,
    '  return { content: [{ type: "text", text }] };',
    "}",
    "",
  ].join("\n");
}

function writeBuild(file: string, source: string, at: string): void {
  fs.writeFileSync(file, source);
  fs.utimesSync(file, new Date(at), new Date(at));
}

function entryFile(dir: string): string {
  const file = path.join(dir, "module.js");
  writeBuild(file, fixtureBuild("build-one"), BUILT);

  return file;
}

async function connect(stamp: ServerStampReader, importBuild?: BuildImporter) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await createServer(OPTIONS, { stamp, ...(importBuild ? { importBuild } : {}) }).connect(serverTransport);
  const client = new Client({ name: "reload-probe", version: "0.0.0" });
  await client.connect(clientTransport);

  return async (name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: args });

    return { isError: result.isError === true, out: JSON.parse((result.content as Array<{ text: string }>)[0].text) };
  };
}

describe("a server that knows it was rebuilt reloads its platform code instead of refusing", () => {
  let tmp: string;
  let prevXdg: string | undefined;
  let prevApi: string | undefined;
  let fetchSpy: ReturnType<typeof vi.fn>;
  let importer: ReturnType<typeof vi.fn<BuildImporter>>;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "extdev-reload-"));
    prevXdg = process.env.XDG_CONFIG_HOME;
    prevApi = process.env.EXTENSION_DEV_API_URL;
    delete process.env.EXTENSION_DEV_API_URL;
    process.env.XDG_CONFIG_HOME = tmp;

    fetchSpy = vi.fn(async (url: string) => {
      const pathname = new URL(String(url)).pathname;

      if (pathname === "/api/cli/whoami") {
        return jsonResponse({ login: "acme/widget", live: true, projectId: PROJECT_ID, workspaceSlug: "acme", projectSlug: "widget" });
      }

      if (pathname === `/api/projects/${PROJECT_ID}/builds`) return jsonResponse({ items: [BUILD_ROW], latest: BUILD_ROW });

      return jsonResponse({ message: "not found" }, 404);
    });

    vi.stubGlobal("fetch", fetchSpy);
    importer = vi.fn<BuildImporter>((specifier) => import(specifier));

    writeCredentials({
      version: 1,
      token: "claims.sig",
      workspaceSlug: "acme",
      projectSlug: "widget",
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      api: API,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prevXdg;
    if (prevApi === undefined) delete process.env.EXTENSION_DEV_API_URL;
    else process.env.EXTENSION_DEV_API_URL = prevApi;

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("dispatches to the rebuilt registry with the handover, says so once, and chains the next rebuild through the active build", async () => {
    if (process.platform === "win32") return;

    const file = entryFile(tmp);
    const stamp = createServerStamp(file);
    const call = await connect(stamp, importer);

    const fresh = await call("extension_builds", { action: "list", api: API });

    expect(fresh.out.status).toBe("listed");
    expect(fresh.out.value.builds).toHaveLength(1);
    expect(fresh.out.warnings).toEqual([]);
    expect(importer).toHaveBeenCalledTimes(0);
    expect(fetchSpy.mock.calls.map((args) => new URL(String(args[0])).pathname)).toContain(`/api/projects/${PROJECT_ID}/builds`);
    const fetchedBefore = fetchSpy.mock.calls.length;

    writeBuild(file, fixtureBuild("build-two"), REBUILT);

    const first = await call("extension_builds", { action: "list", api: API });

    expect(first.isError).toBe(false);
    expect(first.out.value.answeredBy).toBe("build-two");
    expect(first.out.value.args).toEqual({ action: "list", api: API });
    expect(first.out.value.options).toEqual(OPTIONS);
    expect(first.out.value.keptLogins).toEqual([[expect.stringContaining("\n"), credentialKey("acme", "widget", API)]]);
    expect(first.out.value.trail).toEqual([]);
    expect(first.out.warnings).toEqual([reloadedWarning(REBUILT)]);
    expect(importer).toHaveBeenCalledTimes(1);
    expect(importer.mock.calls[0][0]).toBe(buildSpecifier(file, REBUILT, 1));
    expect(fetchSpy).toHaveBeenCalledTimes(fetchedBefore);

    const second = await call("extension_release_status", { api: API });

    expect(second.out.value.answeredBy).toBe("build-two");
    expect(second.out.value.args).toEqual({ api: API });
    expect(second.out.warnings).toEqual([]);
    expect(importer).toHaveBeenCalledTimes(1);

    writeBuild(file, fixtureBuild("build-three"), REBUILT_AGAIN);

    const third = await call("extension_builds", { action: "list", api: API });

    expect(third.out.value.answeredBy).toBe("build-three");
    expect(third.out.value.trail).toEqual(["build-two"]);
    expect(third.out.value.keptLogins).toHaveLength(1);
    expect(third.out.warnings).toEqual([reloadedWarning(REBUILT_AGAIN)]);
    expect(importer).toHaveBeenCalledTimes(2);
    expect(importer.mock.calls[1][0]).toBe(buildSpecifier(file, REBUILT_AGAIN, 2));

    const fourth = await call("extension_builds", { action: "list", api: API });

    expect(fourth.out.value.answeredBy).toBe("build-three");
    expect(fourth.out.warnings).toEqual([]);
    expect(fetchSpy).toHaveBeenCalledTimes(fetchedBefore);
  });

  it("answers E_SERVER_STALE with reloadError and the /mcp sentence when the new build is broken, shapeless, or there is no loader", async () => {
    if (process.platform === "win32") return;

    const file = entryFile(tmp);
    const stamp = createServerStamp(file);
    const call = await connect(stamp, importer);

    writeBuild(file, "export const half = ;\n", REBUILT);

    const broken = await call("extension_builds", { action: "list", api: API });

    expect(broken.isError).toBe(true);
    expect(broken.out.ok).toBe(false);
    expect(broken.out.status).toBe("server-stale");
    expect(broken.out.error.code).toBe("E_SERVER_STALE");
    expect(broken.out.error.message).toBe(staleSentence(REBUILT));
    expect(broken.out.value.reloadError).toMatch(/^import of the 2026-10-23T23:37:13\.000Z build failed: /);
    expect(broken.out.value.server).toEqual({ version, commit: null, startedAt: expect.any(String), pid: process.pid, builtAt: BUILT });
    expect(broken.out.value.action).toBe("list");
    expect(broken.out.value.trackUrl).toMatch(/\/acme\/widget\/builds$/);
    expect(broken.out.warnings).toEqual([]);
    expect(importer).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledTimes(0);

    writeBuild(file, "export const v = 1;\n", REBUILT);

    const shapeless = await call("extension_builds", { action: "list", api: API });

    expect(shapeless.out.status).toBe("server-stale");
    expect(shapeless.out.value.reloadError).toBe(`the ${REBUILT} build does not export the reload contract (${RELOAD_CONTRACT.join(", ")})`);
    expect(importer).toHaveBeenCalledTimes(2);
    expect(importer.mock.calls[1][0]).toBe(buildSpecifier(file, REBUILT, 2));

    writeBuild(file, fixtureBuild("build-two"), REBUILT);

    const mended = await call("extension_builds", { action: "list", api: API });

    expect(mended.out.value.answeredBy).toBe("build-two");
    expect(mended.out.warnings).toEqual([reloadedWarning(REBUILT)]);
    expect(importer).toHaveBeenCalledTimes(3);

    const bare = await connect(stamp);
    const unloadable = await bare("extension_builds", { action: "list", api: API });

    expect(unloadable.out.status).toBe("server-stale");
    expect(unloadable.out.error.message).toBe(staleSentence(REBUILT));
    expect(unloadable.out.value.reloadError).toBe("this server was started without a loader for a rebuilt build; the extension-mcp launcher provides one");
    expect(fetchSpy).toHaveBeenCalledTimes(0);
  });

  it("a fresh server never reloads", async () => {
    if (process.platform === "win32") return;

    const call = await connect(createServerStamp(entryFile(tmp)), importer);

    const { isError, out } = await call("extension_builds", { action: "list", api: API });

    expect(isError).toBe(false);
    expect(out.status).toBe("listed");
    expect(out.value.server).toEqual({ version, commit: null, startedAt: expect.any(String), pid: process.pid, builtAt: BUILT });
    expect(out.warnings).toEqual([]);
    expect(importer).toHaveBeenCalledTimes(0);

    const fetched = fetchSpy.mock.calls.map((args) => new URL(String(args[0])).pathname);

    expect(fetched).toContain(`/api/projects/${PROJECT_ID}/builds`);
    expect(fetched.every((pathname) => pathname === "/api/cli/whoami" || pathname === `/api/projects/${PROJECT_ID}/builds`)).toBe(true);
  });

  it("a local tool answers from the rebuilt build, which reads the sessions this process registered, and says so once", async () => {
    if (process.platform === "win32") return;

    const file = entryFile(tmp);
    const stamp = createServerStamp(file);
    const manifest = path.join(tmp, "manifest.json");
    fs.writeFileSync(manifest, JSON.stringify({ manifest_version: 3, name: "Probe", version: "1.0.0" }));
    const call = await connect(stamp, importer);
    registerSession({ pid: 424242, browser: "chrome", projectPath: path.join(tmp, "probe"), command: "dev" });

    writeBuild(file, fixtureBuild("build-two"), REBUILT);

    const first = await call("extension_manifest_validate", { manifestPath: manifest });

    expect(first.isError).toBe(false);
    expect(first.out.value.answeredBy).toBe("build-two");
    expect(first.out.value.args).toEqual({ manifestPath: manifest });
    expect(first.out.value.localSessions).toEqual([424242]);
    expect(first.out.warnings).toEqual([reloadedWarning(REBUILT)]);
    expect(importer).toHaveBeenCalledTimes(1);

    const second = await call("extension_wait", { projectPath: path.join(tmp, "probe") });

    expect(second.out.value.answeredBy).toBe("build-two");
    expect(second.out.warnings).toEqual([]);
    expect(importer).toHaveBeenCalledTimes(1);

    const added = await call("extension_added_by_the_rebuild", { any: 1 });

    expect(added.out.value.answeredBy).toBe("build-two");
    expect(added.out.value.args).toEqual({ any: 1 });
    expect(fetchSpy).toHaveBeenCalledTimes(0);
  });

  it("a build that cannot adopt this process's sessions leaves local tools on the loaded code and says so on every answer, while platform tools reload", async () => {
    if (process.platform === "win32") return;

    const file = entryFile(tmp);
    const stamp = createServerStamp(file);
    const manifest = path.join(tmp, "manifest.json");
    fs.writeFileSync(manifest, JSON.stringify({ manifest_version: 3, name: "Probe", version: "1.0.0" }));
    const call = await connect(stamp, importer);

    writeBuild(file, fixtureBuild("build-two", false), REBUILT);

    const warning = staleLocalWarning(BUILT, REBUILT, noLocalCarryReason(REBUILT));
    const server = { version, commit: null, startedAt: expect.any(String), pid: process.pid, builtAt: BUILT, stale: true, newerBuild: { version: "99.0.0+build-two", builtAt: REBUILT } };
    const first = await call("extension_manifest_validate", { manifestPath: manifest });

    expect(first.out.command).toBe("extension_manifest_validate");
    expect(first.out.value.answeredBy).toBeUndefined();
    expect(first.out.value.server).toEqual(server);
    expect(first.out.warnings.filter((w: string) => w === warning)).toHaveLength(1);
    expect(importer).toHaveBeenCalledTimes(1);

    const second = await call("extension_manifest_validate", { manifestPath: manifest });

    expect(second.out.value.server).toEqual(server);
    expect(second.out.warnings.filter((w: string) => w === warning)).toHaveLength(1);

    const platform = await call("extension_builds", { action: "list", api: API });

    expect(platform.out.value.answeredBy).toBe("build-two");
    expect(platform.out.warnings).toEqual([reloadedWarning(REBUILT)]);

    const unknown = await call("extension_added_by_the_rebuild", {});

    expect(unknown.out.status).toBe("unknown-tool");
    expect(unknown.out.value.server).toEqual({ version, commit: null, startedAt: expect.any(String), pid: process.pid, builtAt: BUILT });
    expect(importer).toHaveBeenCalledTimes(1);
  });

  it("a check this build does not know but the build on disk declares is refused as predating it, with the newer build named", async () => {
    if (process.platform === "win32") return;

    const file = entryFile(tmp);
    const stamp = createServerStamp(file);
    const call = await connect(stamp, importer);

    writeBuild(file, fixtureBuild("build-two", false), REBUILT);

    const predated = await call("extension_assert", { projectPath: tmp, expect: [{ assert: "page-world-sealed" }, { assert: "background-worker-booted" }] });

    expect(predated.isError).toBe(true);
    expect(predated.out.status).toBe("server-stale");
    expect(predated.out.error.code).toBe("E_SERVER_STALE");
    expect(predated.out.error.message).toBe(
      `This server predates the check page-world-sealed: it was built at ${BUILT}, the build on disk at ${REBUILT} declares it, and ${noLocalCarryReason(REBUILT)}; run /mcp and pick extension-dev, then assert again.`,
    );

    expect(predated.out.value.predates).toEqual(["page-world-sealed"]);
    expect(predated.out.value.server).toEqual({ version, commit: null, startedAt: expect.any(String), pid: process.pid, builtAt: BUILT, stale: true, newerBuild: { version: "99.0.0+build-two", builtAt: REBUILT } });
    expect(predated.out.value.reloadError).toBe(noLocalCarryReason(REBUILT));

    const unknownEverywhere = await call("extension_assert", { projectPath: tmp, expect: [{ assert: "no-such-check" }] });

    expect(unknownEverywhere.out.status).toBe("bad-request");
    expect(unknownEverywhere.out.error.message).toContain("no-such-check");
    expect(unknownEverywhere.out.value.server.stale).toBe(true);
    expect(unknownEverywhere.out.warnings).toContain(staleLocalWarning(BUILT, REBUILT, noLocalCarryReason(REBUILT)));
  });

  it("a failed reload leaves local tools on the loaded code with the reload error on every answer, and the verdict's producer stale", async () => {
    if (process.platform === "win32") return;

    const file = entryFile(tmp);
    const stamp = createServerStamp(file);
    const manifest = path.join(tmp, "manifest.json");
    fs.writeFileSync(manifest, JSON.stringify({ manifest_version: 3, name: "Probe", version: "1.0.0" }));
    const call = await connect(stamp, importer);

    writeBuild(file, "export const half = ;\n", REBUILT);

    const first = await call("extension_manifest_validate", { manifestPath: manifest });
    const reason = first.out.value.server.newerBuild && first.out.warnings.find((w: string) => w.startsWith("This answer came from"));

    expect(first.out.value.answeredBy).toBeUndefined();
    expect(first.out.value.server).toEqual({ version, commit: null, startedAt: expect.any(String), pid: process.pid, builtAt: BUILT, stale: true, newerBuild: { version: null, builtAt: REBUILT } });
    expect(reason).toMatch(/because import of the 2026-10-23T23:37:13\.000Z build failed: /);

    const verdict = await call("extension_assert", { projectPath: path.join(tmp, "nowhere"), expect: [{ assert: "background-worker-booted" }] });

    expect(verdict.out.value.producer).toEqual({ name: "@extension.dev/mcp", version, stale: true, newerBuild: { version: null, builtAt: REBUILT } });
    expect(verdict.out.value.server.stale).toBe(true);
    expect(verdict.out.warnings.some((w: string) => w.startsWith("This answer came from"))).toBe(true);

    const second = await call("extension_manifest_validate", { manifestPath: manifest });

    expect(second.out.warnings.some((w: string) => w.startsWith("This answer came from"))).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(0);
  });

  it("every refusal names the build that answered", async () => {
    if (process.platform === "win32") return;

    const call = await connect(createServerStamp(entryFile(tmp)), importer);
    const server = { version, commit: null, startedAt: expect.any(String), pid: process.pid, builtAt: BUILT };

    const unknown = await call("extension_nope", {});

    expect(unknown.out.status).toBe("unknown-tool");
    expect(unknown.out.value.server).toEqual(server);

    const invalid = await call("extension_manifest_validate", { manifestPath: 7 });

    expect(invalid.out.status).toBe("invalid-arguments");
    expect(invalid.out.value.server).toEqual(server);

    const refusedByTool = await call("extension_assert", { projectPath: tmp, expect: [{ assert: "no-such-check" }] });

    expect(refusedByTool.out.status).toBe("bad-request");
    expect(refusedByTool.out.value.server).toEqual(server);
    expect(importer).toHaveBeenCalledTimes(0);
  });
});
