import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { userCacheDir } from "../lib/user-cache-dir";

const realPlatform = process.platform;
const saved = { XDG_CACHE_HOME: process.env.XDG_CACHE_HOME, LOCALAPPDATA: process.env.LOCALAPPDATA, USERPROFILE: process.env.USERPROFILE };

function onPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
}

describe("the user cache directory mirrors how the config directory is resolved", () => {
  afterEach(() => {
    onPlatform(realPlatform);

    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("honors XDG_CACHE_HOME on every platform but Windows", () => {
    process.env.XDG_CACHE_HOME = "/srv/cache";

    onPlatform("linux");
    expect(userCacheDir()).toBe(path.join("/srv/cache", "extension-dev"));

    onPlatform("darwin");
    expect(userCacheDir()).toBe(path.join("/srv/cache", "extension-dev"));
  });

  it("falls back to Library/Caches on macOS and .cache elsewhere", () => {
    delete process.env.XDG_CACHE_HOME;

    onPlatform("darwin");
    expect(userCacheDir()).toBe(path.join(os.homedir(), "Library", "Caches", "extension-dev"));

    onPlatform("linux");
    expect(userCacheDir()).toBe(path.join(os.homedir(), ".cache", "extension-dev"));
  });

  it("uses LOCALAPPDATA on Windows and ignores XDG_CACHE_HOME there", () => {
    process.env.XDG_CACHE_HOME = "/srv/cache";
    process.env.LOCALAPPDATA = "C:\\Users\\rebeccat\\AppData\\Local";

    onPlatform("win32");
    expect(userCacheDir()).toBe(path.join("C:\\Users\\rebeccat\\AppData\\Local", "extension-dev", "Cache"));

    delete process.env.LOCALAPPDATA;
    process.env.USERPROFILE = "C:\\Users\\rebeccat";
    expect(userCacheDir()).toBe(path.join("C:\\Users\\rebeccat", "AppData", "Local", "extension-dev", "Cache"));
  });
});
