import { describe, it, expect, afterEach, vi } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// DevX fresh-eyes walk: extension_list_extensions returned anonymous entries,
// a list of opaque 32-char ids with nothing marking WHICH one is the extension
// the current dev session serves. The handler must resolve the own extension's
// identity from the session's ready contract (the engine stamps extensionName,
// extensionVersion, and the distPath it loaded) and flag it ownExtension, and
// must say WHY when another extension's identity cannot be resolved instead of
// silently listing a bare id.

let cdpTargets: Array<{ type: string; url: string }> = [];
// Extensions.getExtensionInfo behavior per id. Missing id = the domain throws,
// which is what a browser without unsafe extension debugging actually does.
let domainInfo: Record<string, { name: string; version: string }> = {};

vi.mock("../lib/cdp-port", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/cdp-port")>();
  return { ...actual, resolveCdpPort: async () => ({ port: 9222 }) };
});

vi.mock("../lib/cdp", () => {
  class CDPClient {
    static async discoverBrowserWsUrl() {
      return "ws://127.0.0.1:9222/devtools/browser/x";
    }
    async connect() {}
    async getTargets() {
      return cdpTargets;
    }
    async sendCommand(method: string, params?: Record<string, unknown>) {
      if (method === "Extensions.getExtensionInfo") {
        const info = domainInfo[String(params?.extensionId)];
        if (!info) throw new Error("Extension not found");
        return { extensionInfo: info };
      }
      return {};
    }
    disconnect() {}
  }
  return { CDPClient };
});

const listExtensions = await import("../tools/list-extensions");

// Chrome's unpacked-extension id: SHA-256 of the absolute dist path, first 16
// bytes, nibbles mapped onto a-p. Duplicated here on purpose so the test pins
// the algorithm independently of the implementation.
function expectedId(distPath: string): string {
  const d = crypto.createHash("sha256").update(distPath).digest();
  let id = "";
  for (let i = 0; i < 16; i++) {
    id += String.fromCharCode(97 + (d[i] >> 4));
    id += String.fromCharCode(97 + (d[i] & 0x0f));
  }
  return id;
}

const MANAGER_ID = "kgdaecdpfkikjncaalnmmnjjfpofkcbl";

function swTarget(id: string): { type: string; url: string } {
  return {
    type: "service_worker",
    url: `chrome-extension://${id}/background/service_worker.js`,
  };
}

const tmpDirs: string[] = [];
function project(
  contract: Record<string, unknown> = {},
  opts: { distManifest?: Record<string, unknown> | null } = {},
): { dir: string; distPath: string; id: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-list-ext-"));
  tmpDirs.push(dir);
  const distPath = path.join(dir, "dist", "chrome");
  const readyDir = path.join(dir, "dist", "extension-js", "chrome");
  fs.mkdirSync(readyDir, { recursive: true });
  fs.writeFileSync(
    path.join(readyDir, "ready.json"),
    JSON.stringify({
      schemaVersion: 2,
      status: "ready",
      command: "dev",
      browser: "chrome",
      pid: process.pid,
      cdpPort: 9222,
      distPath,
      ...contract,
    }),
  );
  if (opts.distManifest !== undefined && opts.distManifest !== null) {
    fs.mkdirSync(distPath, { recursive: true });
    fs.writeFileSync(
      path.join(distPath, "manifest.json"),
      JSON.stringify(opts.distManifest),
    );
  }
  return { dir, distPath, id: expectedId(distPath) };
}

afterEach(() => {
  cdpTargets = [];
  domainInfo = {};
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("list-extensions own-extension identity", () => {
  it("flags the session's extension and names it from the ready contract", async () => {
    const p = project({ extensionName: "My Ext", extensionVersion: "2.1.0" });
    cdpTargets = [swTarget(MANAGER_ID), swTarget(p.id)];

    const result = JSON.parse(
      await listExtensions.handler({ projectPath: p.dir }),
    );

    expect(result.ownExtensionId).toBe(p.id);
    const own = result.extensions.find(
      (e: Record<string, unknown>) => e.id === p.id,
    );
    expect(own).toMatchObject({
      ownExtension: true,
      name: "My Ext",
      version: "2.1.0",
      source: "session-contract",
    });
    expect(own.note).toBeUndefined();
  });

  it("sorts the own extension first", async () => {
    const p = project({ extensionName: "Zzz Last Alphabetically" });
    cdpTargets = [swTarget(MANAGER_ID), swTarget(p.id)];
    domainInfo[MANAGER_ID] = { name: "AAA Manager", version: "1.0" };

    const result = JSON.parse(
      await listExtensions.handler({ projectPath: p.dir }),
    );

    expect(result.extensions[0].id).toBe(p.id);
    expect(result.extensions[0].ownExtension).toBe(true);
  });

  it("keeps the Extensions-domain identity when the browser provides one", async () => {
    const p = project({ extensionName: "Contract Name" });
    cdpTargets = [swTarget(p.id)];
    domainInfo[p.id] = { name: "Browser Name", version: "3.0.0" };

    const result = JSON.parse(
      await listExtensions.handler({ projectPath: p.dir }),
    );

    expect(result.extensions[0]).toMatchObject({
      ownExtension: true,
      name: "Browser Name",
      version: "3.0.0",
      source: "extensions-domain",
    });
  });

  it("falls back to the built manifest when the contract predates the identity stamp", async () => {
    const p = project(
      {},
      { distManifest: { name: "Dist Manifest Ext", version: "0.9.0" } },
    );
    cdpTargets = [swTarget(p.id)];

    const result = JSON.parse(
      await listExtensions.handler({ projectPath: p.dir }),
    );

    expect(result.extensions[0]).toMatchObject({
      ownExtension: true,
      name: "Dist Manifest Ext",
      version: "0.9.0",
      source: "session-contract",
    });
  });

  it("does not surface a raw __MSG_ placeholder as the name", async () => {
    const p = project(
      {},
      { distManifest: { name: "__MSG_appName__", version: "0.9.0" } },
    );
    cdpTargets = [swTarget(p.id)];

    const result = JSON.parse(
      await listExtensions.handler({ projectPath: p.dir }),
    );

    const own = result.extensions[0];
    expect(own.ownExtension).toBe(true);
    expect(own.name).toBeUndefined();
    // Still honest about the unresolved name rather than silently id-only.
    expect(own.note).toContain("unresolved");
  });

  it("marks the own extension by contract-name match when the path-derived id misses", async () => {
    const p = project({
      distPath: "/somewhere/else/entirely",
      extensionName: "Renamed Load",
      extensionVersion: "1.2.3",
    });
    const liveId = "abcdefghijklmnopabcdefghijklmnop";
    cdpTargets = [swTarget(liveId), swTarget(MANAGER_ID)];
    domainInfo[liveId] = { name: "Renamed Load", version: "1.2.3" };

    const result = JSON.parse(
      await listExtensions.handler({ projectPath: p.dir }),
    );

    expect(result.ownExtensionId).toBe(liveId);
    const own = result.extensions.find(
      (e: Record<string, unknown>) => e.id === liveId,
    );
    expect(own.ownExtension).toBe(true);
  });

  it("explains WHY another extension stays id-only instead of listing a bare id", async () => {
    const p = project({ extensionName: "Mine" });
    cdpTargets = [swTarget(p.id), swTarget(MANAGER_ID)];

    const result = JSON.parse(
      await listExtensions.handler({ projectPath: p.dir }),
    );

    const other = result.extensions.find(
      (e: Record<string, unknown>) => e.id === MANAGER_ID,
    );
    expect(other.ownExtension).toBeUndefined();
    expect(other.name).toBeUndefined();
    expect(other.source).toBe("target-only");
    expect(other.note).toContain("never attached to");
  });

  it("flags nothing when no ready contract identifies the session", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-list-ext-"));
    tmpDirs.push(dir);
    cdpTargets = [swTarget(MANAGER_ID)];

    const result = JSON.parse(
      await listExtensions.handler({ projectPath: dir, browser: "chrome" }),
    );

    expect(result.ownExtensionId).toBeNull();
    expect(
      result.extensions.every(
        (e: Record<string, unknown>) => e.ownExtension === undefined,
      ),
    ).toBe(true);
  });
});
