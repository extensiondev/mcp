import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { handler as shares, schema } from "../tools/shares";
import { TOOL_POLICY, disabledToolEnvelope } from "../lib/tool-policy";
import { writeCredentials } from "../lib/credentials";

const API = "http://localhost:3100";
const PROJECT_ID = "prj_probe";
const ZIP_PATH = "/api/local-registry/acme/widget/builds/603fc8a/chrome.zip";
const ARTIFACT_ID = `gen_${"ab".repeat(32)}`;

function crc32(bytes: Buffer): number {
  let crc = ~0;

  for (const byte of bytes) {
    crc ^= byte;
    for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }

  return ~crc >>> 0;
}

function zipOf(entries: Array<{ name: string; data?: string; deflate?: boolean }>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const raw = Buffer.from(entry.data ?? "");
    const body = entry.deflate ? zlib.deflateRawSync(raw) : raw;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(entry.deflate ? 8 : 0, 8);
    local.writeUInt32LE(crc32(raw), 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(entry.deflate ? 8 : 0, 10);
    central.writeUInt32LE(crc32(raw), 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += 30 + name.length + body.length;
  }

  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);

  return Buffer.concat([...locals, directory, end]);
}

const MANIFEST = JSON.stringify({ manifest_version: 3, name: "Widget", version: "0.1.0", action: { default_popup: "action/index.html" } });

type Call = { url: string; method: string; auth: string; body: any };

describe("extension_shares create shares a platform build as a public link", () => {
  let tmp: string;
  let prev: Record<string, string | undefined>;
  let prevFetch: typeof fetch;
  let calls: Call[];
  let zip: Buffer;
  let artifacts: unknown;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "extdev-share-build-"));
    prev = {
      XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
      EXTENSION_DEV_API_URL: process.env.EXTENSION_DEV_API_URL,
      EXTENSION_DEV_TOKEN: process.env.EXTENSION_DEV_TOKEN,
      EXTENSION_DEV_REGISTRY_URL: process.env.EXTENSION_DEV_REGISTRY_URL,
    };

    delete process.env.EXTENSION_DEV_API_URL;
    delete process.env.EXTENSION_DEV_TOKEN;
    delete process.env.EXTENSION_DEV_REGISTRY_URL;
    process.env.XDG_CONFIG_HOME = tmp;
    prevFetch = global.fetch;
    calls = [];
    zip = zipOf([
      { name: "manifest.json", data: MANIFEST, deflate: true },
      { name: "action/" },
      { name: "action/index.html", data: "<script src=index.js></script>" },
      { name: "action/index.js", data: "console.log('hi')", deflate: true },
    ]);

    artifacts = [
      { name: "chrome-extension.zip", browser: "chrome", type: "Extension package", downloadUrl: "https://registry.extension.land/acme/widget/builds/603fc8a/chrome.zip" },
      { name: "chrome.json", browser: "chrome", type: "Build metadata", downloadUrl: "https://registry.extension.land/acme/widget/builds/603fc8a/chrome.json" },
    ];

    global.fetch = (async (url: string, init?: RequestInit) => {
      const target = new URL(String(url));
      const headers = (init?.headers ?? {}) as Record<string, string>;
      const method = String(init?.method ?? "GET").toUpperCase();
      calls.push({ url: String(url), method, auth: String(headers.authorization ?? ""), body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const json = (body: unknown, status = 200) =>
        ({ ok: status < 300, status, headers: { get: () => null }, text: async () => JSON.stringify(body), json: async () => body }) as unknown as Response;

      if (target.pathname === "/api/cli/whoami") return json({ projectId: PROJECT_ID, workspaceSlug: "acme", projectSlug: "widget" });
      if (target.pathname === `/api/projects/${PROJECT_ID}/builds/603fc8a/artifacts`) return json(artifacts);
      if (target.pathname === "/api/access-grant") return json({ token: "grant", expiresAt: Math.floor(Date.now() / 1000) + 600 });

      if (target.pathname === ZIP_PATH) {
        if (target.searchParams.get("t") !== "grant") return json({ error: "unauthorized" }, 401);

        return new Response(zip, { status: 200, headers: { "content-type": "application/zip" } });
      }

      if (target.pathname === "/api/artifacts" && method === "POST") {
        return json({
          artifactId: ARTIFACT_ID,
          previewUrl: `http://preview.extension.localhost/?preview=${ARTIFACT_ID}`,
          zipUrl: `${API}/api/artifacts/${ARTIFACT_ID}/source.zip`,
          revokeUrl: `${API}/api/artifacts/${ARTIFACT_ID}`,
          expiresAt: "2026-10-18T00:00:00.000Z",
        });
      }

      return json({ message: "not found" }, 404);
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(prev)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }

    global.fetch = prevFetch;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function login() {
    writeCredentials({
      version: 1,
      token: "claims.sig",
      workspaceSlug: "acme",
      projectSlug: "widget",
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      api: API,
    });
  }

  it("offers create beside list and revoke, and counts it as shipping", () => {
    expect((schema.inputSchema.properties as any).action.enum).toEqual(["list", "create", "revoke"]);
    expect(typeof TOOL_POLICY.extension_shares.ships === "function" && TOOL_POLICY.extension_shares.ships({ action: "create" })).toBe(true);
    expect(disabledToolEnvelope("extension_shares", { action: "create", buildId: "603fc8a" }, { features: ["platform"], noShip: true })).toContain("tool-disabled");
  });

  it("downloads the build's zip from the server's own registry, unpacks it, and uploads it as a dist share", async () => {
    if (process.platform === "win32") return;

    login();

    const out = JSON.parse(await shares({ action: "create", buildId: "603fc8a", api: API }));
    const upload = calls.find((call) => call.url === `${API}/api/artifacts` && call.method === "POST");

    expect(calls.some((call) => call.url.startsWith("https://registry.extension.land"))).toBe(false);
    expect(upload?.auth).toBe("Bearer claims.sig");
    expect(upload?.body.kind).toBe("dist");
    expect(upload?.body.generation).toMatchObject({ name: "Widget", version: "0.1.0", browser: "chrome", manifestVersion: 3 });
    expect(upload?.body.generation.files.map((f: any) => f.path)).toEqual(["action/index.html", "action/index.js", "manifest.json"]);
    expect(upload?.body.generation.files.find((f: any) => f.path === "action/index.js").content).toBe("console.log('hi')");
    expect(out.ok).toBe(true);
    expect(out.status).toBe("shared");
    expect(out.value).toMatchObject({
      action: "create",
      buildId: "603fc8a",
      browser: "chrome",
      artifactId: ARTIFACT_ID,
      previewUrl: `http://preview.extension.localhost/?preview=${ARTIFACT_ID}`,
      serves: "platform-build",
    });

    expect(out.hint).toContain("extension_shares");
  });

  it("refuses a browser the build has no package for, naming the ones it has", async () => {
    if (process.platform === "win32") return;

    login();

    const out = JSON.parse(await shares({ action: "create", buildId: "603fc8a", browser: "firefox", api: API }));

    expect(out.ok).toBe(false);
    expect(out.status).toBe("not-found");
    expect(out.error.message).toContain("chrome");
    expect(calls.some((call) => call.url.endsWith("/api/artifacts"))).toBe(false);
  });

  it("refuses a zip entry that climbs out of the folder it unpacks into, and uploads nothing", async () => {
    if (process.platform === "win32") return;

    login();
    zip = zipOf([
      { name: "manifest.json", data: MANIFEST },
      { name: "../escape.js", data: "x" },
    ]);

    const out = JSON.parse(await shares({ action: "create", buildId: "603fc8a", api: API }));

    expect(out.ok).toBe(false);
    expect(out.error.message).toContain("../escape.js");
    expect(calls.some((call) => call.url.endsWith("/api/artifacts"))).toBe(false);
    expect(fs.existsSync(path.join(os.tmpdir(), "escape.js"))).toBe(false);
  });

  it("refuses create without a buildId before any request", async () => {
    login();

    const out = JSON.parse(await shares({ action: "create", api: API }));

    expect(out.ok).toBe(false);
    expect(out.error.code).toBe("E_BAD_REQUEST");
    expect(calls).toHaveLength(0);
  });
});
