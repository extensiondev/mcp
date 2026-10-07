import { describe, it, expect } from "vitest";

import { LAUNCHABLE_BROWSERS, REAL_BROWSERS } from "../lib/common-schema";
import { isGeckoFamily } from "../lib/browser-family";
import { detectBrowsers } from "../tools/detect-browsers";
import { toMcpSpeak } from "../lib/act";

describe("zen and floorp are browsers the server can name, the way waterfox is", () => {
  it("lists both in the browser enum the launch tools expose", () => {
    expect(LAUNCHABLE_BROWSERS).toContain("zen");
    expect(LAUNCHABLE_BROWSERS).toContain("floorp");
    expect(REAL_BROWSERS).toContain("zen");
    expect(REAL_BROWSERS).toContain("floorp");
    expect(isGeckoFamily("zen")).toBe(true);
    expect(isGeckoFamily("floorp")).toBe(true);
  });

  it("detects both as Gecko engines with RDP and no CDP, whether or not they are installed", async () => {
    const result = JSON.parse(await detectBrowsers(["zen", "floorp"]));
    const zen = result.value.detected.find((d: { browser: string }) => d.browser === "zen");
    const floorp = result.value.detected.find((d: { browser: string }) => d.browser === "floorp");

    expect(zen.engine).toBe("gecko");
    expect(floorp.engine).toBe("gecko");
    expect(zen.rdpSupport).toBe(true);
    expect(zen.cdpSupport).toBe(false);

    for (const row of [zen, floorp]) {
      if (row.binaryPath) {
        expect(row.binaryPath).toMatch(new RegExp(row.browser, "i"));
      } else {
        expect(row.source).toBe("not_found");
      }
    }
  }, 20_000);

  it("rewrites an engine hint naming --browser zen into the tool's own input", () => {
    expect(toMcpSpeak("extension dev --browser zen")).toContain('browser: "zen"');
    expect(toMcpSpeak("extension dev --browser=floorp")).toContain('browser: "floorp"');
  });
});
