import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { findManagedBinary, detectBrowsers } from "../tools/detect-browsers";

const tmpDirs: string[] = [];
function cacheRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-managed-cache-"));
  tmpDirs.push(dir);
  return dir;
}

function plant(root: string, relative: string): string {
  const full = path.join(root, relative);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  return full;
}

const savedEnv = process.env.EXT_BROWSERS_CACHE_DIR;
afterEach(() => {
  if (savedEnv === undefined) delete process.env.EXT_BROWSERS_CACHE_DIR;
  else process.env.EXT_BROWSERS_CACHE_DIR = savedEnv;
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("the managed-cache search reaches the binary the engine really launches", () => {
  it("finds a Firefox Nightly six levels down inside its app bundle", () => {
    const root = cacheRoot();
    const exe = plant(
      root,
      "firefox/firefox/mac_arm-nightly_158.0a1/Firefox Nightly.app/Contents/MacOS/firefox",
    );

    expect(findManagedBinary("firefox", root)).toBe(exe);
  });

  it("finds Chrome for Testing inside its bundle", () => {
    const root = cacheRoot();
    const exe = plant(
      root,
      "chrome/chrome/mac_arm-151.0.7922.71/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
    );

    expect(findManagedBinary("chrome", root)).toBe(exe);
  });

  it("answers null for a browser directory that holds no executable", () => {
    const root = cacheRoot();
    fs.mkdirSync(path.join(root, "firefox", "firefox", "partial-download"), {
      recursive: true,
    });

    expect(findManagedBinary("firefox", root)).toBeNull();
  });

  it("reports the managed binary as what dev launches and names a shadowed system install", async () => {
    const root = cacheRoot();
    const exe = plant(
      root,
      "firefox/firefox/mac_arm-nightly_158.0a1/Firefox Nightly.app/Contents/MacOS/firefox",
    );
    process.env.EXT_BROWSERS_CACHE_DIR = root;

    const result = JSON.parse(await detectBrowsers(["firefox"]));
    const firefox = result.value.detected[0];

    expect(firefox.source).toBe("managed");
    expect(firefox.binaryPath).toBe(exe);
    if (firefox.systemBinaryPath) {
      expect(firefox.devLaunches).toContain("geckoBinary");
      expect(firefox.devLaunches).toContain(firefox.systemBinaryPath);
    } else {
      expect(firefox.devLaunches).toBeUndefined();
    }
  }, 15_000);
});
