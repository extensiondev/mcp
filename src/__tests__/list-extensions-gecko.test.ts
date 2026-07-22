import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { RdpAddon } from "../lib/rdp";

// Firefox parity for extension_list_extensions (upstream entry 78 landed: the
// engine stamps rdpPort into ready.json). The Gecko path lists installed
// add-ons via the RDP root actor instead of erroring "not yet supported".
// These tests pin the mapping: system/hidden add-ons are filtered, the dev
// session's extension is flagged ownExtension (contract-name match first, lone
// temporary install as fallback), and a missing rdpPort explains the upgrade.

let rdpAddons: RdpAddon[] = [];
let rdpError: Error | null = null;
let rdpPort: number | null = 9223;
const listAddonsCalls: number[] = [];

vi.mock("../lib/rdp", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/rdp")>();
  return {
    ...actual,
    rdpListAddons: async (port: number) => {
      listAddonsCalls.push(port);
      if (rdpError) throw rdpError;
      return rdpAddons;
    },
  };
});

vi.mock("../lib/cdp-port", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/cdp-port")>();
  return {
    ...actual,
    resolveRdpPort: async () =>
      rdpPort == null ? null : { port: rdpPort, source: "contract" as const },
  };
});

const listExtensions = await import("../tools/list-extensions");

const tmpDirs: string[] = [];

// A project whose firefox ready.json stamps the identity fields the engine
// writes; the browser dir must exist for resolveSessionBrowser's sightings.
function project(contract: Record<string, unknown> = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-list-gecko-"));
  tmpDirs.push(dir);
  const readyDir = path.join(dir, "dist", "extension-js", "firefox");
  fs.mkdirSync(readyDir, { recursive: true });
  fs.writeFileSync(
    path.join(readyDir, "ready.json"),
    JSON.stringify({ status: "ready", ...contract }),
  );
  return dir;
}

beforeEach(() => {
  rdpAddons = [];
  rdpError = null;
  rdpPort = 9223;
  listAddonsCalls.length = 0;
});

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("extension_list_extensions on Gecko (RDP root listAddons)", () => {
  it("lists add-ons with rdp-root identity and flags the contract-named one", async () => {
    rdpAddons = [
      {
        id: "probe@extension.dev",
        name: "RDP Probe",
        version: "1.2.3",
        temporarilyInstalled: true,
        isWebExtension: true,
      },
      {
        id: "uBlock0@raymondhill.net",
        name: "uBlock Origin",
        version: "1.60.0",
        isWebExtension: true,
      },
    ];
    const dir = project({ extensionName: "RDP Probe" });

    const result = JSON.parse(
      await listExtensions.handler({ projectPath: dir, browser: "firefox" }),
    );

    expect(result.error).toBeUndefined();
    expect(result.rdpPort).toBe(9223);
    expect(result.browser).toBe("firefox");
    expect(result.count).toBe(2);
    expect(result.ownExtensionId).toBe("probe@extension.dev");
    // Own extension sorts first.
    expect(result.extensions[0]).toEqual({
      id: "probe@extension.dev",
      name: "RDP Probe",
      version: "1.2.3",
      temporarilyInstalled: true,
      ownExtension: true,
      contexts: [],
      source: "rdp-root",
    });
    expect(result.extensions[1].id).toBe("uBlock0@raymondhill.net");
    expect(result.extensions[1].ownExtension).toBeUndefined();
    expect(listAddonsCalls).toEqual([9223]);
  });

  it("filters system, hidden, and non-webextension add-ons", async () => {
    rdpAddons = [
      {
        id: "sys@mozilla.org",
        name: "System Thing",
        isWebExtension: true,
        isSystem: true,
      },
      {
        id: "ghost@mozilla.org",
        name: "Hidden Thing",
        isWebExtension: true,
        hidden: true,
      },
      { id: "legacy@old", name: "Legacy", isWebExtension: false },
      // GMP plugins (Widevine, OpenH264) carry NO isWebExtension field at all.
      { id: "gmp-widevinecdm", name: "Widevine CDM" },
      { id: "keep@ext", name: "Keeper", isWebExtension: true },
    ];
    const dir = project({});

    const result = JSON.parse(
      await listExtensions.handler({ projectPath: dir, browser: "firefox" }),
    );

    expect(result.count).toBe(1);
    expect(result.extensions[0].id).toBe("keep@ext");
  });

  it("falls back to the lone temporary install when the contract name mismatches", async () => {
    rdpAddons = [
      {
        id: "generated-temp-id@temporary-addon",
        temporarilyInstalled: true,
        isWebExtension: true,
      },
      { id: "other@ext", name: "Other", isWebExtension: true },
    ];
    const dir = project({
      extensionName: "My Project",
      extensionVersion: "0.1.0",
    });

    const result = JSON.parse(
      await listExtensions.handler({ projectPath: dir, browser: "firefox" }),
    );

    const own = result.extensions.find(
      (e: { ownExtension?: boolean }) => e.ownExtension,
    );
    expect(own.id).toBe("generated-temp-id@temporary-addon");
    // Identity backfilled from the contract when RDP exposes none.
    expect(own.name).toBe("My Project");
    expect(own.version).toBe("0.1.0");
    expect(own.source).toBe("session-contract");
  });

  it("explains the engine upgrade when the contract has no rdpPort", async () => {
    rdpPort = null;
    const dir = project({});

    const result = JSON.parse(
      await listExtensions.handler({ projectPath: dir, browser: "firefox" }),
    );

    expect(result.error).toContain("RDP");
    expect(result.hint).toContain("rdpPort");
    expect(result.hint).toContain("4.0.15");
    expect(listAddonsCalls).toEqual([]);
  });

  it("surfaces an RDP failure after retries as the tool error", async () => {
    rdpError = new Error("ECONNREFUSED 127.0.0.1:9223");
    const dir = project({});

    const result = JSON.parse(
      await listExtensions.handler({ projectPath: dir, browser: "firefox" }),
    );

    expect(result.error).toContain("Failed to list extensions over RDP");
    expect(result.error).toContain("ECONNREFUSED");
    expect(listAddonsCalls.length).toBe(3);
  });
});
