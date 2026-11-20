import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";


import { isChromiumFamily, isGeckoFamily } from "../lib/browser-family";
import { handler as validateManifest } from "../tools/manifest-validate";

import type * as EngineManifestEntry from "extension-develop/manifest";

describe("browser-family", () => {
  it("classifies every Extension.js browser name", () => {
    for (const name of [
      "chrome",
      "chromium",
      "edge",
      "brave",
      "opera",
      "vivaldi",
      "yandex",
      "chromium-based",
    ]) {
      expect(isChromiumFamily(name)).toBe(true);
      expect(isGeckoFamily(name)).toBe(false);
    }

    for (const name of [
      "firefox",
      "waterfox",
      "librewolf",
      "zen",
      "floorp",
      "gecko-based",
      "firefox-based",
    ]) {
      expect(isGeckoFamily(name)).toBe(true);
      expect(isChromiumFamily(name)).toBe(false);
    }

    for (const name of ["safari", "webkit-based"]) {
      expect(isChromiumFamily(name)).toBe(false);
      expect(isGeckoFamily(name)).toBe(false);
    }
  });
});

describe("manifest-validate chromium-family gate", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-manifest-"));
  });

  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('runs the Chromium checks for browsers: ["chromium"]', async () => {
    const manifestPath = path.join(dir, "manifest.json");
    fs.writeFileSync(
      manifestPath,
      JSON.stringify({
        name: "mv2-holdout",
        version: "1.0.0",
        manifest_version: 2,
      }),
    );

    const result = JSON.parse(
      await validateManifest({ manifestPath, browsers: ["chromium"] }),
    );
    expect(result.value.browserSupport.chromium.issues.join("\n")).toContain(
      "Manifest V2 is deprecated on Chromium",
    );
  });
});

describe("the per-browser manifest view is the engine's rule, held without the engine entry that is going away", () => {
  afterEach(() => {
    vi.doUnmock("extension-develop/manifest");
    vi.resetModules();
  });

  it("answers what the engine's filterKeysForThisBrowser answers for every browser name, with the manifest entry gone", async () => {
    const engine = await vi.importActual<typeof EngineManifestEntry>("extension-develop/manifest");
    vi.resetModules();
    vi.doMock("extension-develop/manifest", () => {
      throw new Error("extension-develop/manifest is removed");
    });

    const { engineManifestView } = await import("../lib/engine-manifest-view");
    const manifest = JSON.parse(`{
      "name": "plain",
      "chromium:name": "family chromium",
      "chrome:name": "chrome",
      "edge:name": "edge",
      "gecko:name": "family gecko",
      "firefox:name": "firefox",
      "safari:name": "safari",
      "webkit:name": "webkit",
      "brave:only_here": true,
      "zen:only_here": true,
      "unknown:dropped": true,
      "__proto__": { "kept": "as a key" },
      "manifest_version": 3,
      "firefox:manifest_version": 2,
      "background": {
        "service_worker": "sw.js",
        "firefox:scripts": ["sw.js"],
        "chromium:type": "module"
      },
      "content_scripts": [
        { "matches": ["https://example.com/*"], "js": ["a.js"], "gecko:run_at": "document_start", "chrome:world": "MAIN" },
        "text",
        7,
        null
      ],
      "nested": { "https://example.com/": 1, "trailing:": 2, ":leading": 3, "firefox:chrome:twice": 4 },
      "firefox:after_gecko": "firefox",
      "gecko:after_gecko": "gecko",
      "gecko:before_firefox": "gecko",
      "firefox:before_firefox": "firefox"
    }`) as Record<string, unknown>;
    const browsers = [
      "chrome",
      "chromium",
      "edge",
      "brave",
      "opera",
      "vivaldi",
      "yandex",
      "chromium-based",
      "chromium-emulator",
      "firefox",
      "waterfox",
      "librewolf",
      "zen",
      "floorp",
      "gecko-based",
      "firefox-based",
      "safari",
      "webkit-based",
      "nothing-known",
    ];

    for (const browser of browsers) {
      const expected = engine.filterKeysForThisBrowser(
        manifest as Parameters<typeof engine.filterKeysForThisBrowser>[0],
        browser as Parameters<typeof engine.filterKeysForThisBrowser>[1],
      );

      expect(JSON.stringify(engineManifestView(manifest, browser)), browser).toBe(JSON.stringify(expected));
    }

    expect(engineManifestView(manifest, "firefox").name).toBe("firefox");
    expect(Object.keys(engineManifestView(manifest, "chrome"))).toContain("__proto__");
  });
});
