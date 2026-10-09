import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, it, expect, afterEach, beforeEach } from "vitest";

import {
  detectBrowsers,
  normalizeBrowserVersion,
  readBundledVersion,
} from "../tools/detect-browsers";
import { listManagedBrowsers } from "../tools/list-browsers";

const NIGHTLY = "firefox/firefox/mac_arm-nightly_158.0a1/Firefox Nightly.app/Contents";

const tmpDirs: string[] = [];
let root = "";

function write(relative: string, body: string, mode = 0o644): string {
  const full = path.join(root, relative);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, body, { mode });

  return full;
}

function plantNightly(versionOutput: string): string {
  return write(`${NIGHTLY}/MacOS/firefox`, `#!/bin/sh\necho "${versionOutput}"\n`, 0o755);
}

function plist(version: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0">\n<dict>\n  <key>CFBundleName</key>\n  <string>Firefox Nightly</string>\n  <key>CFBundleShortVersionString</key>\n  <string>${version}</string>\n</dict>\n</plist>\n`;
}

const savedEnv = process.env.EXT_BROWSERS_CACHE_DIR;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-browser-version-"));
  tmpDirs.push(root);
  process.env.EXT_BROWSERS_CACHE_DIR = root;
});

afterEach(() => {
  if (savedEnv === undefined) delete process.env.EXT_BROWSERS_CACHE_DIR;
  else process.env.EXT_BROWSERS_CACHE_DIR = savedEnv;

  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

async function firefoxFromDetect() {
  return JSON.parse(await detectBrowsers(["firefox"])).value.detected[0];
}

async function firefoxFromList() {
  const listed = JSON.parse(await listManagedBrowsers()).value.installed;

  return listed.find((b: { browser: string }) => b.browser === "firefox");
}

describe("a self-updated Nightly is reported by the version its binary carries", () => {
  // The stand-in binary is a shell script, which Windows cannot execute; the
  // plist and application.ini cases below cover the read on every platform.
  it.skipIf(process.platform === "win32")("reads 159.0a1 from --version in a folder named 158.0a1, in detect and in list", async () => {
    const exe = plantNightly("Mozilla Firefox 159.0a1");

    const detected = await firefoxFromDetect();
    expect(detected.binaryPath).toBe(exe);
    expect(detected.version).toBe("159.0a1");
    expect(detected.versionProbe).toBe("ok");

    const listed = await firefoxFromList();
    expect(listed.binaryPath).toBe(exe);
    expect(listed.version).toBe("159.0a1");
    expect(listed.path).toBe(path.join(root, "firefox"));
  }, 15_000);

  it("prefers the bundle's Info.plist over --version, the way the engine reads it", async () => {
    plantNightly("Mozilla Firefox 158.0a1");
    write(`${NIGHTLY}/Info.plist`, plist("159.0a1"));

    expect((await firefoxFromDetect()).version).toBe("159.0a1");
    expect((await firefoxFromList()).version).toBe("159.0a1");
  }, 15_000);

  it("reads application.ini when the bundle has no plist version", async () => {
    plantNightly("");
    write(`${NIGHTLY}/Resources/application.ini`, "[App]\nVendor=Mozilla\nName=Firefox\nVersion=159.0a1\nBuildID=20261008\n");

    const detected = await firefoxFromDetect();
    expect(detected.version).toBe("159.0a1");
    expect(detected.versionProbe).toBe("failed");
  }, 15_000);

  it("reads application.ini beside a Linux or Windows binary", () => {
    const exe = write("firefox/firefox/linux-nightly_158.0a1/firefox/firefox", "#!/bin/sh\n", 0o755);
    write("firefox/firefox/linux-nightly_158.0a1/firefox/application.ini", "[App]\nVersion=159.0a1\n");

    expect(readBundledVersion(exe)).toBe("159.0a1");
  });
});

describe("the version text keeps its prerelease suffix", () => {
  it.each([
    ["Mozilla Firefox 159.0a1", "159.0a1"],
    ["Mozilla Firefox 141.0b3", "141.0b3"],
    ["Mozilla Firefox 128.5.0esr", "128.5.0esr"],
    ["Mozilla Firefox 150.0", "150.0"],
    ["Google Chrome for Testing 151.0.7922.71 ", "151.0.7922.71"],
    ["Microsoft Edge 140.0.3485.54", "140.0.3485.54"],
    ["", null],
  ])("%s -> %s", (text, expected) => {
    expect(normalizeBrowserVersion(text)).toBe(expected);
  });
});
