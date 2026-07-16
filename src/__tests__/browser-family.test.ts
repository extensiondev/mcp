import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isChromiumFamily, isGeckoFamily } from "../lib/browser-family";
import { handler as validateManifest } from "../tools/manifest-validate";

describe("browser-family", () => {
  it("classifies every Extension.js browser name", () => {
    for (const name of ["chrome", "chromium", "edge", "chromium-based"]) {
      expect(isChromiumFamily(name)).toBe(true);
      expect(isGeckoFamily(name)).toBe(false);
    }
    for (const name of ["firefox", "gecko-based", "firefox-based"]) {
      expect(isGeckoFamily(name)).toBe(true);
      expect(isChromiumFamily(name)).toBe(false);
    }
  });
});

describe("manifest-validate chromium-family gate", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-manifest-"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  // Regression: the inline family list lacked "chromium", so
  // browsers: ["chromium"] silently ran ZERO family checks and reported the
  // manifest fine (same drift that made list-extensions refuse --browser
  // chromium sessions).
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
    expect(result.browserSupport.chromium.issues.join("\n")).toContain(
      "Manifest V2 is deprecated on Chromium",
    );
  });
});
