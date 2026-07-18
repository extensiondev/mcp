import { describe, it, expect } from "vitest";
import { buildDeployArgs, schema, handler } from "../tools/deploy";
import { tools as ALL_TOOLS } from "../index";

describe("extension_deploy: buildDeployArgs", () => {
  it("adds --dry-run by default (no explicit dryRun)", () => {
    expect(buildDeployArgs({ projectPath: ".", chromeZip: "c.zip" })).toEqual([
      "--dry-run",
      "--chrome-zip",
      "c.zip",
    ]);
  });

  it("adds --dry-run when dryRun is true", () => {
    expect(
      buildDeployArgs({ projectPath: ".", chromeZip: "c.zip", dryRun: true }),
    ).toContain("--dry-run");
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
    // Cast through unknown: even if a caller smuggles secret-looking keys, the
    // builder must ignore them - creds only ever come from the environment.
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

describe("extension_deploy: handler guard", () => {
  it("errors when no store zip is provided (no spawn)", async () => {
    const out = JSON.parse(await handler({ projectPath: "." }));
    expect(out.ok).toBe(false);
    expect(out.error.name).toBe("DeployInputError");
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
