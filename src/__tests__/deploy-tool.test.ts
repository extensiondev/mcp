import { afterEach, describe, it, expect } from "vitest";
import {
  buildDeployArgs,
  buildPlatformArgs,
  isPlatformInvocation,
  schema,
  handler,
} from "../tools/deploy";
import { tools as ALL_TOOLS } from "../index";

afterEach(() => {
  delete process.env.EXTENSION_DEV_TOKEN;
});

describe("extension_deploy: buildDeployArgs", () => {
  it("adds --dry-run by default (no explicit dryRun)", () => {
    expect(buildDeployArgs({ projectPath: ".", chromeZip: "c.zip" })).toEqual([
      "--dry-run",
      "--chrome-zip",
      "c.zip",
    ]);
  });

  it("omits --dry-run only when dryRun is explicitly false", () => {
    expect(
      buildDeployArgs({ projectPath: ".", chromeZip: "c.zip", dryRun: false }),
    ).not.toContain("--dry-run");
  });

  it("maps every store's non-secret flags", () => {
    const argv = buildDeployArgs({
      projectPath: ".",
      dryRun: false,
      chromeZip: "chrome.zip",
      chromeExtensionId: "ext",
      chromePublisherId: "pub",
      stagedPublish: true,
      chromeDeployPercentage: 25,
      chromeSkipSubmitReview: true,
      firefoxZip: "ff.zip",
      firefoxSourcesZip: "src.zip",
      firefoxExtensionId: "my@addon",
      firefoxChannel: "unlisted",
      edgeZip: "edge.zip",
      edgeProductId: "prod",
      edgeSkipSubmitReview: true,
      outputJson: "out.json",
    });
    expect(argv).toEqual([
      "--chrome-zip",
      "chrome.zip",
      "--chrome-extension-id",
      "ext",
      "--chrome-publisher-id",
      "pub",
      "--chrome-staged-publish",
      "--chrome-deploy-percentage",
      "25",
      "--chrome-skip-submit-review",
      "--firefox-zip",
      "ff.zip",
      "--firefox-sources-zip",
      "src.zip",
      "--firefox-extension-id",
      "my@addon",
      "--firefox-channel",
      "unlisted",
      "--edge-zip",
      "edge.zip",
      "--edge-product-id",
      "prod",
      "--edge-skip-submit-review",
      "--output-json",
      "out.json",
    ]);
  });

  it("never emits a credential flag, whatever is passed", () => {
    const argv = buildDeployArgs({
      projectPath: ".",
      chromeZip: "c.zip",
      // @ts-expect-error not part of DeployToolArgs on purpose
      chromeClientSecret: "shh",
      // @ts-expect-error not part of DeployToolArgs on purpose
      firefoxJwtSecret: "shh",
      // @ts-expect-error not part of DeployToolArgs on purpose
      edgeApiKey: "shh",
    });
    const joined = argv.join(" ");
    expect(joined).not.toMatch(/secret|token|api-?key|client-secret|shh/i);
  });
});

describe("extension_deploy: platform mode", () => {
  it("detects platform mode from platform:true, browsers, or buildSha", () => {
    expect(isPlatformInvocation({ projectPath: ".", chromeZip: "c.zip" })).toBe(false);
    expect(isPlatformInvocation({ projectPath: ".", platform: true })).toBe(true);
    expect(isPlatformInvocation({ projectPath: ".", browsers: ["chrome"] })).toBe(true);
    expect(isPlatformInvocation({ projectPath: ".", buildSha: "abc1234" })).toBe(true);
  });

  it("builds platform argv with --platform and no store zips", () => {
    const argv = buildPlatformArgs({
      projectPath: ".",
      dryRun: false,
      browsers: ["chrome", "firefox"],
      buildSha: "abc1234",
      channel: "beta",
    });
    expect(argv).toEqual([
      "--platform",
      "--browsers",
      "chrome,firefox",
      "--build-sha",
      "abc1234",
      "--channel",
      "beta",
    ]);
    expect(argv.join(" ")).not.toMatch(/zip/);
  });

  it("dry-runs by default in platform mode", () => {
    expect(
      buildPlatformArgs({ projectPath: ".", browsers: ["chrome"], buildSha: "s" }),
    ).toContain("--dry-run");
  });
});

describe("extension_deploy: handler guards", () => {
  it("errors when direct mode has no store zip (no spawn)", async () => {
    const out = JSON.parse(await handler({ projectPath: "." }));
    expect(out.ok).toBe(false);
    expect(out.error.name).toBe("DeployInputError");
  });

  it("errors when platform mode is requested without a token (no spawn)", async () => {
    delete process.env.EXTENSION_DEV_TOKEN;
    const out = JSON.parse(
      await handler({ projectPath: ".", browsers: ["chrome"], buildSha: "abc1234" }),
    );
    expect(out.ok).toBe(false);
    expect(out.error.name).toBe("DeployAuthError");
  });

  it("errors when platform mode lacks browsers or buildSha (no spawn)", async () => {
    process.env.EXTENSION_DEV_TOKEN = "tok";
    const noBrowsers = JSON.parse(
      await handler({ projectPath: ".", platform: true, buildSha: "abc1234" }),
    );
    expect(noBrowsers.error.name).toBe("DeployInputError");
    const noSha = JSON.parse(
      await handler({ projectPath: ".", platform: true, browsers: ["chrome"] }),
    );
    expect(noSha.error.name).toBe("DeployInputError");
  });
});

describe("extension_deploy: registration", () => {
  it("is registered under the extension_deploy name", () => {
    expect(schema.name).toBe("extension_deploy");
    const names = ALL_TOOLS.map((t) => t.schema.name);
    expect(names).toContain("extension_deploy");
  });

  it("requires projectPath and does not accept any credential property", () => {
    const props = Object.keys(
      (schema.inputSchema as { properties: Record<string, unknown> }).properties,
    );
    expect(
      (schema.inputSchema as { required: string[] }).required,
    ).toContain("projectPath");
    for (const p of props) {
      expect(p).not.toMatch(/secret|token|apiKey|clientSecret|refreshToken|serviceAccount/i);
    }
  });
});
