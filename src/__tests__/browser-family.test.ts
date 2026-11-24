import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { isChromiumFamily, isGeckoFamily } from "../lib/browser-family";
import { engineManifestView } from "../lib/engine-manifest-view";
import { chooseGuidedBrowser, type BrowserProbe } from "../lib/guided-browser";
import { parseLastUsed, parseLaunchServicesHttp, parseUserChoice } from "../lib/guided-connect";
import { handler as validateManifest } from "../tools/manifest-validate";
import { frozenEngineAnswers } from "./fixtures/emitted-manifest";

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
  it("answers what the engine's filterKeysForThisBrowser answered for every browser name, frozen from 4.2.0", () => {
    const { table } = frozenEngineAnswers();
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

    expect(Object.keys(table.answers)).toEqual(browsers);
    expect(Object.keys(table.manifest)).toContain("__proto__");

    for (const browser of browsers) {
      expect(JSON.stringify(engineManifestView(table.manifest, browser)), browser).toBe(
        JSON.stringify(table.answers[browser]),
      );
    }

    expect(engineManifestView(table.manifest, "firefox").name).toBe("firefox");
    expect(Object.keys(engineManifestView(table.manifest, "chrome"))).toContain("__proto__");
  });
});

const MAC_APPS: Record<string, string> = {
  chrome: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  edge: "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  firefox: "/Applications/Firefox.app/Contents/MacOS/firefox",
  safari: "/Applications/Safari.app/Contents/MacOS/Safari",
};

function probe(over: Partial<BrowserProbe> & { used?: Record<string, number>; installed?: string[]; managed?: Record<string, string> }): BrowserProbe {
  const installed = new Set(over.installed ?? Object.keys(MAC_APPS));

  return {
    platform: "darwin",
    systemBinary: (browser) => (installed.has(browser) ? (MAC_APPS[browser] ?? `/usr/bin/${browser}`) : null),
    managedBinary: (browser) => over.managed?.[browser] ?? null,
    lastUsed: (app) => Object.entries(over.used ?? {}).find(([browser]) => MAC_APPS[browser]?.startsWith(app))?.[1] ?? null,
    defaultBrowser: () => null,
    ...over,
  };
}

describe("the guided store connect picks a browser the MCP can load extension.dev tools into", () => {
  it("on macOS takes the most recently used app and never Safari, however recent", () => {
    const choice = chooseGuidedBrowser(probe({ used: { safari: 900, edge: 500, firefox: 300 } }));

    expect(choice).toMatchObject({ browser: "edge", binary: MAC_APPS.edge, install: null });
    expect(choice.why).toBe("Edge, the browser you used most recently.");
  });

  it("maps a Chrome person to the managed Chrome for Testing, and asks for its install when it is missing", () => {
    const cft = "/cache/chrome/mac_arm-142/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";

    expect(chooseGuidedBrowser(probe({ used: { chrome: 900, edge: 500 }, managed: { chrome: cft } }))).toMatchObject({ browser: "chrome", binary: cft, install: null });
    expect(chooseGuidedBrowser(probe({ used: { chrome: 900 } }))).toMatchObject({ browser: "chrome", binary: null, install: "chrome" });
    expect(chooseGuidedBrowser(probe({ used: { chrome: 900 } })).why).toContain("branded Chrome refuses a loaded extension");
  });

  it.each([
    ["darwin", "com.microsoft.edgemac", "edge"],
    ["win32", "MSEdgeHTM", "edge"],
    ["win32", "FirefoxURL-308046B0AF4A39CB", "firefox"],
    ["win32", "ChromeHTML", "chrome"],
    ["linux", "brave-browser.desktop", "brave"],
    ["linux", "firefox_firefox.desktop", "firefox"],
    ["linux", "vivaldi-stable.desktop", "vivaldi"],
  ] as const)("on %s takes the system default %s as %s", (platform, id, browser) => {
    const choice = chooseGuidedBrowser(probe({ platform, installed: [browser], defaultBrowser: () => id, managed: { chrome: "/cft" } }));

    expect(choice.browser).toBe(browser);
    expect(choice.why).toContain("your default browser");
  });

  it("falls back to Chromium when the default is Safari, unknown or not installed", () => {
    expect(chooseGuidedBrowser(probe({ platform: "win32", defaultBrowser: () => "SafariHTML", installed: ["chromium"] }))).toMatchObject({ browser: "chromium", binary: "/usr/bin/chromium", install: null });
    expect(chooseGuidedBrowser(probe({ platform: "linux", defaultBrowser: () => "firefox.desktop", installed: [] }))).toMatchObject({ browser: "chromium", binary: null, install: "chromium" });
    expect(chooseGuidedBrowser(probe({ used: {}, installed: [] })).browser).toBe("chromium");
  });

  it("reads the macOS last-used date and the Windows UserChoice the way the tools print them", () => {
    expect(parseLastUsed("2026-11-24 12:00:22 +0000")).toBe(Date.parse("2026-11-24T12:00:22Z"));
    expect(parseLastUsed("(null)")).toBeNull();
    expect(parseLaunchServicesHttp('(\n    {\n        LSHandlerRoleAll = "com.apple.safari";\n        LSHandlerURLScheme = https;\n    },\n    {\n        LSHandlerPreferredVersions = {\n            LSHandlerRoleAll = "-";\n        };\n        LSHandlerRoleAll = "com.google.chrome";\n        LSHandlerURLScheme = http;\n    }\n)')).toBe("com.google.chrome");
    expect(parseUserChoice("\r\nHKEY_CURRENT_USER\\...\\UserChoice\r\n    ProgId    REG_SZ    MSEdgeHTM\r\n")).toBe("MSEdgeHTM");
  });
});
