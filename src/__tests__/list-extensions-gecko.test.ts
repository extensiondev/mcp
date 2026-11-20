import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";

import { safariEnableProbes } from "../lib/safari-enable-probes";
import { readyContract } from "./fixtures/engine-answers";
import { writeCompiledUnattachedContract } from "./fixtures/ready-contract";
import { extensionsPlistXml, TEAM } from "./fixtures/safari-extensions-plist";

import type { RdpAddon } from "../lib/rdp";
import type * as RdpModule from "../lib/rdp";
import type * as CdpPortModule from "../lib/cdp-port";

let rdpAddons: RdpAddon[] = [];
let rdpError: Error | null = null;
let rdpPort: number | null = 9223;
const listAddonsCalls: number[] = [];

vi.mock("../lib/rdp", async (importOriginal) => {
  const actual = await importOriginal<typeof RdpModule>();

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
  const actual = await importOriginal<typeof CdpPortModule>();

  return {
    ...actual,
    resolveRdpPort: async () =>
      rdpPort == null ? null : { port: rdpPort, source: "contract" as const },
  };
});

const listExtensions = await import("../tools/list-extensions");

const tmpDirs: string[] = [];

function project(contract: Record<string, unknown> = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-list-gecko-"));
  tmpDirs.push(dir);
  const readyDir = path.join(dir, "dist", "extension-js", "firefox");
  fs.mkdirSync(readyDir, { recursive: true });
  fs.writeFileSync(
    path.join(readyDir, "ready.json"),
    JSON.stringify(readyContract("dev", "firefox", contract)),
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

    expect(result.error).toBeNull();
    expect(result.status).toBe("listed");
    expect(result.value.rdpPort).toBe(9223);
    expect(result.value.browser).toBe("firefox");
    expect(result.value.count).toBe(2);
    expect(result.value.ownExtensionId).toBe("probe@extension.dev");
    expect(result.value.extensions[0]).toEqual({
      id: "probe@extension.dev",
      name: "RDP Probe",
      version: "1.2.3",
      temporarilyInstalled: true,
      ownExtension: true,
      contexts: [],
      source: "rdp-root",
    });

    expect(result.value.extensions[1].id).toBe("uBlock0@raymondhill.net");
    expect(result.value.extensions[1].ownExtension).toBeUndefined();
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
      { id: "gmp-widevinecdm", name: "Widevine CDM" },
      { id: "keep@ext", name: "Keeper", isWebExtension: true },
    ];

    const dir = project({});

    const result = JSON.parse(
      await listExtensions.handler({ projectPath: dir, browser: "firefox" }),
    );

    expect(result.value.count).toBe(1);
    expect(result.value.extensions[0].id).toBe("keep@ext");
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

    const own = result.value.extensions.find(
      (e: { ownExtension?: boolean }) => e.ownExtension,
    );
    expect(own.id).toBe("generated-temp-id@temporary-addon");
    expect(own.name).toBe("My Project");
    expect(own.version).toBe("0.1.0");
    expect(own.source).toBe("session-contract");
    expect(own.ownExtensionInferred).toBe(true);
    expect(result.value.ownExtensionInferred).toBe(true);
    expect(result.warnings.join(" ")).toContain("That is an inference");
  });

  it("explains the engine upgrade when the contract has no rdpPort", async () => {
    rdpPort = null;
    const dir = project({});

    const result = JSON.parse(
      await listExtensions.handler({ projectPath: dir, browser: "firefox" }),
    );

    expect(result.error.message).toContain("RDP");
    expect(result.error.code).toBe("E_NO_SESSION");
    expect(result.hint).toContain("rdpPort");
    expect(result.hint).toContain("4.0.15");
    expect(listAddonsCalls).toEqual([]);
  });

  it("surfaces an RDP failure as the tool error after one attempt, since the port came from a live contract", async () => {
    rdpError = new Error("ECONNREFUSED 127.0.0.1:9223");
    const dir = project({});

    const result = JSON.parse(
      await listExtensions.handler({ projectPath: dir, browser: "firefox" }),
    );

    expect(result.status).toBe("rdp-failed");
    expect(result.error.message).toContain("Failed to list extensions over RDP");
    expect(result.error.message).toContain("ECONNREFUSED");
    expect(listAddonsCalls.length).toBe(1);
  });
});

describe("extension_list_extensions on Safari reads the Mac's own registrations", () => {
  const saved = { ...safariEnableProbes };
  const row = (mark: string, id: string, appex: string) => `${mark}    ${id}(1.2)\t3E3BBEFD-8E88-414A-B1B4-4BA28401048E\t2026-11-06 18:15:33 +0000\t${appex}`;

  afterEach(() => {
    Object.assign(safariEnableProbes, saved);
  });

  it("lists every registered Safari web extension with Safari's own switch, marks the project's build, and needs no session", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-list-safari-"));
    tmpDirs.push(dir);
    const appPath = path.join(dir, "dist", "safari-xcode", ".derived", "Build", "Products", "Release", "Leon.app");
    fs.mkdirSync(appPath, { recursive: true });
    writeCompiledUnattachedContract(dir, "safari", { extensionId: "com.acme.leon.Extension", extensionName: "Leon", binary: appPath });

    const own = path.join(appPath, "Contents", "PlugIns", "Leon Extension.appex");
    const notes = "/Applications/Notes Clipper.app/Contents/PlugIns/Notes Clipper Extension.appex";

    safariEnableProbes.platform = () => "darwin";
    safariEnableProbes.pluginkitList = () => `${row("+", "com.acme.notes.Extension", notes)}\n${row(" ", "com.acme.leon.Extension", own)}\n (2 plug-ins)\n`;
    safariEnableProbes.extensionsPlist = () => ({
      xml: extensionsPlistXml([
        { id: "com.acme.notes.Extension", identity: TEAM, enabled: true },
        { id: "com.acme.leon.Extension", identity: "UNSIGNED", enabled: false },
      ]),
      reason: "",
    });

    const result = JSON.parse(await listExtensions.handler({ projectPath: dir, browser: "safari" }));

    expect(result.ok).toBe(true);
    expect(result.status).toBe("listed");
    expect(result.value.count).toBe(2);
    expect(result.value.ownExtensionId).toBe("com.acme.leon.Extension");
    expect(result.value.extensions).toEqual([
      expect.objectContaining({ id: "com.acme.leon.Extension", name: "Leon", version: "1.2", ownExtension: true, enabled: false, path: own.replace(/\\/g, "/") }),
      expect.objectContaining({ id: "com.acme.notes.Extension", name: "Notes Clipper", version: "1.2", enabled: true, path: notes }),
    ]);

    expect(result.value.extensions[1].ownExtension).toBeUndefined();

    safariEnableProbes.extensionsPlist = () => ({ xml: null, reason: "Extensions.plist could not be read: Operation not permitted" });
    const unread = JSON.parse(await listExtensions.handler({ projectPath: dir, browser: "safari" }));

    expect(unread.status).toBe("listed");
    expect(unread.value.extensions.map((entry: { enabled: unknown }) => entry.enabled)).toEqual(["unknown", "unknown"]);
    expect(unread.warnings.join(" ")).toContain("Operation not permitted");
  });

  it("refuses off macOS and when pluginkit does not answer, without pointing at safaridriver", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-list-safari-"));
    tmpDirs.push(dir);

    safariEnableProbes.platform = () => "linux";

    safariEnableProbes.pluginkitList = () => {
      throw new Error("pluginkit must not run off macOS");
    };

    const offMac = JSON.parse(await listExtensions.handler({ projectPath: dir, browser: "safari" }));

    safariEnableProbes.platform = () => "darwin";
    safariEnableProbes.pluginkitList = () => null;
    const silent = JSON.parse(await listExtensions.handler({ projectPath: dir, browser: "safari" }));

    for (const result of [offMac, silent]) {
      expect(result.ok).toBe(false);
      expect(result.status).toBe("unsupported-browser");
      expect(result.hint).not.toContain("safaridriver");
      expect(result.hint).not.toMatch(/^Target a Chromium-family/);
    }

    expect(offMac.error.message).not.toBe(silent.error.message);
  });
});
