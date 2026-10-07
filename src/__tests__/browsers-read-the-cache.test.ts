/* @invariant "installed", "available" and "installed" are
 * read off the cache and the binary, never off a directory, a return or a
 * silent probe; and the installer's prose never reaches the JSON-RPC stream. */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";

import type * as ExtensionInstallModule from "extension-install";

const installer = vi.hoisted(() => ({
  outputDuringCall: null as string | null | undefined,
  plant: true,
  calls: 0,
}));
vi.mock("extension-install", async (importOriginal) => {
  const actual = await importOriginal<typeof ExtensionInstallModule>();

  return {
    ...actual,
    extensionInstall: vi.fn(async ({ browser }: { browser: string }) => {
      installer.calls += 1;
      installer.outputDuringCall = process.env.EXTENSION_OUTPUT;
      if (installer.plant) plantBinary(browser);

      return undefined;
    }),
  };
});

const tmpDirs: string[] = [];
let root = "";

function plantBinary(browser: string): string {
  const name = browser === "firefox" ? "firefox" : "chrome";
  const full = path.join(root, browser, browser, "mac_arm-151.0.0.0", name);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, "#!/bin/sh\nexit 0\n", { mode: 0o755 });

  return full;
}

const savedEnv = process.env.EXT_BROWSERS_CACHE_DIR;
const savedOutput = process.env.EXTENSION_OUTPUT;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-browsers-cache-"));
  tmpDirs.push(root);
  process.env.EXT_BROWSERS_CACHE_DIR = root;
  delete process.env.EXTENSION_OUTPUT;
  installer.outputDuringCall = null;
  installer.plant = true;
  installer.calls = 0;
});

afterEach(() => {
  if (savedEnv === undefined) delete process.env.EXT_BROWSERS_CACHE_DIR;
  else process.env.EXT_BROWSERS_CACHE_DIR = savedEnv;
  if (savedOutput === undefined) delete process.env.EXTENSION_OUTPUT;
  else process.env.EXTENSION_OUTPUT = savedOutput;

  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const install = await import("../tools/install-browser");
const list = await import("../tools/list-browsers");
const detect = await import("../tools/detect-browsers");

describe("81b: install", () => {
  it("runs the installer with machine output on and restores the switch after", async () => {
    const out = JSON.parse(await install.installManagedBrowser("chrome"));
    expect(installer.calls).toBe(1);
    expect(installer.outputDuringCall).toBe("json");
    expect(process.env.EXTENSION_OUTPUT).toBeUndefined();
    expect(out.ok).toBe(true);
    expect(out.status).toBe("installed");
    expect(out.value.binaryPath).toMatch(/mac_arm-151/);
  });

  it("does not say installed when the installer returned and no binary landed", async () => {
    installer.plant = false;
    const out = JSON.parse(await install.installManagedBrowser("edge"));
    expect(out.ok).toBe(false);
    expect(out.status).toBe("install-unconfirmed");
    expect(out.error.message).toMatch(/no edge binary is in the managed cache/);
  });
});

describe("81d: list", () => {
  it("does not count a directory with no binary as installed", async () => {
    fs.mkdirSync(path.join(root, "chrome", "chrome", "mac_arm-151.0.0.0"), { recursive: true });
    fs.writeFileSync(path.join(root, "chrome", "chrome", "mac_arm-151.0.0.0", "partial.zip"), "half");
    const out = JSON.parse(await list.listManagedBrowsers());
    expect(out.value.installed).toEqual([]);
    expect(out.value.incomplete.map((i: { browser: string }) => i.browser)).toEqual(["chrome"]);
    expect(out.value.availableToInstall).toContain("chrome");
    expect(out.warnings.join("\n")).toMatch(/no chrome binary/);
  });

  it("lists a browser whose binary is present, with the binary path", async () => {
    const exe = plantBinary("firefox");
    const out = JSON.parse(await list.listManagedBrowsers());
    expect(out.value.installed.map((i: { browser: string }) => i.browser)).toEqual(["firefox"]);
    expect(out.value.installed[0].binaryPath).toBe(exe);
    expect(out.value.incomplete).toEqual([]);
  });
});

describe("81c: detect", () => {
  it("calls a binary that did not answer --version unverified, not available", async () => {
    plantBinary("chrome");
    const out = JSON.parse(await detect.detectBrowsers(["chrome"]));
    const chrome = out.value.detected.find((d: { browser: string }) => d.browser === "chrome");
    expect(chrome.source).toBe("managed");
    expect(chrome.version).toBeNull();
    expect(chrome.versionProbe).toBe("failed");
    expect(out.value.summary.available).not.toContain("chrome");
    expect(out.value.summary.unverified).toEqual(["chrome"]);
    expect(out.hint).not.toMatch(/All requested browsers are available/);
    expect(out.warnings.join("\n")).toMatch(/did not answer --version/);
  }, 20_000);
});
