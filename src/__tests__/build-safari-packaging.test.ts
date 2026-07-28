import { describe, it, expect, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

interface CliResponse {
  code: number;
  stdout: string;
  stderr: string;
}

const cliCalls: string[][] = [];
let cliResponse: CliResponse = { code: 0, stdout: "", stderr: "" };
let cliResponder: ((args: string[]) => CliResponse) | null = null;

vi.mock("../lib/exec", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/exec")>();
  return {
    ...actual,
    runExtensionCli: async (args: string[]) => {
      cliCalls.push(args);
      return cliResponder ? cliResponder(args) : cliResponse;
    },
  };
});

const UNKNOWN_OUTPUT = "error: unknown option '--output'";

function engineTooOldFor(pretty: CliResponse): (args: string[]) => CliResponse {
  return (args) =>
    args.includes("--output")
      ? { code: 1, stdout: "", stderr: UNKNOWN_OUTPUT }
      : pretty;
}

const build = await import("../tools/build");

const tmpDirs: string[] = [];

const MANIFEST = {
  manifest_version: 3,
  name: "Reading List",
  version: "1.0.0",
  description: "A reading list",
};

function project(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-safari-"));
  tmpDirs.push(dir);
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "src", "manifest.json"),
    JSON.stringify(MANIFEST),
  );
  return dir;
}

function distFor(dir: string, browser: string): void {
  const dist = path.join(dir, "dist", browser);
  fs.mkdirSync(dist, { recursive: true });
  fs.writeFileSync(path.join(dist, "manifest.json"), JSON.stringify(MANIFEST));
}

function xcodeProject(dir: string, browser: string, bundleId: string): void {
  const appName = "Reading List";
  const proj = path.join(
    dir,
    "dist",
    `${browser}-xcode`,
    appName,
    `${appName}.xcodeproj`,
  );
  fs.mkdirSync(proj, { recursive: true });
  fs.writeFileSync(
    path.join(proj, "project.pbxproj"),
    [
      "buildSettings = {",
      `\tPRODUCT_BUNDLE_IDENTIFIER = "${bundleId}.Extension";`,
      "};",
      "buildSettings = {",
      `\tPRODUCT_BUNDLE_IDENTIFIER = "${bundleId}";`,
      "};",
    ].join("\n"),
  );
}

function persistSummary(
  dir: string,
  browser: string,
  summary: Record<string, unknown>,
): void {
  const target = path.join(dir, "dist", "extension-js", browser);
  fs.mkdirSync(target, { recursive: true });
  const file = path.join(target, "build-summary.json");
  fs.writeFileSync(file, JSON.stringify(summary));
  const ahead = new Date(Date.now() + 2000);
  fs.utimesSync(file, ahead, ahead);
}

function engineSaid(value: Record<string, unknown>, human = ""): CliResponse {
  return {
    code: 0,
    stdout: JSON.stringify({
      schema: 1,
      ok: true,
      command: "build",
      status: "built",
      value,
      error: null,
      warnings: [],
    }),
    stderr: human,
  };
}

function summariesOf(...summaries: Record<string, unknown>[]): CliResponse {
  return engineSaid({
    projectPath: ".",
    browsers: summaries.map((s) => s.browser),
    summaries,
  });
}

const run = async (args: Parameters<typeof build.handler>[0]) =>
  JSON.parse(await build.handler(args));

afterEach(() => {
  cliCalls.length = 0;
  cliResponder = null;
  cliResponse = { code: 0, stdout: "", stderr: "" };
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("extension_build drives the Safari web-extension conversion", () => {
  it("passes the packaging identity through to the CLI", async () => {
    const dir = project();
    distFor(dir, "safari");

    const result = await run({
      projectPath: dir,
      browser: "safari",
      appName: "Reading List",
      bundleId: "com.acme.readinglist",
      forceRegenerate: true,
    });

    expect(result.ok).toBe(true);
    expect(cliCalls).toHaveLength(1);
    const cli = cliCalls[0];
    expect(cli).toContain("--app-name");
    expect(cli[cli.indexOf("--app-name") + 1]).toBe("Reading List");
    expect(cli).toContain("--bundle-id");
    expect(cli[cli.indexOf("--bundle-id") + 1]).toBe("com.acme.readinglist");
    expect(cli).toContain("--force-regenerate");
  });

  it("asks the engine for the machine envelope rather than its human summary", async () => {
    const dir = project();
    distFor(dir, "chrome");

    await run({ projectPath: dir, browser: "chrome" });

    const cli = cliCalls[0];
    expect(cli).toContain("--output");
    expect(cli[cli.indexOf("--output") + 1]).toBe("json");
  });

  it("omits --force-regenerate when it was not asked for", async () => {
    const dir = project();
    distFor(dir, "safari");

    await run({ projectPath: dir, browser: "safari", forceRegenerate: false });

    expect(cliCalls[0]).not.toContain("--force-regenerate");
  });

  it("reports the identity the packager said it produced", async () => {
    const dir = project();
    distFor(dir, "safari");
    cliResponse = summariesOf({
      browser: "safari",
      safari: {
        appName: "Reading List",
        bundleId: "com.acme.readinglist",
        bundleIdDerived: false,
        appPath: "/tmp/Reading List.app",
        xcodeProjectPath: "/tmp/safari-xcode/Reading List.xcodeproj",
        macOsOnly: true,
      },
    });

    const result = await run({
      projectPath: dir,
      browser: "safari",
      bundleId: "com.acme.readinglist",
    });

    expect(result.value.safariApp).toEqual({
      appName: "Reading List",
      bundleId: "com.acme.readinglist",
      bundleIdDerived: false,
      appPath: "/tmp/Reading List.app",
      xcodeProjectPath: "/tmp/safari-xcode/Reading List.xcodeproj",
      macOsOnly: true,
    });
    expect((result.warnings ?? []).join(" ")).not.toContain(
      "reject it for distribution",
    );
  });

  it("picks the summary for the browser that was asked for", async () => {
    const dir = project();
    distFor(dir, "safari");
    cliResponse = summariesOf(
      { browser: "chrome", total_bytes: 11 },
      {
        browser: "safari",
        total_bytes: 22,
        safari: { appName: "Reading List", bundleId: "com.acme.readinglist" },
      },
    );

    const result = await run({ projectPath: dir, browser: "safari" });

    expect(result.value.totalBytes).toBe(22);
    expect(result.value.safariApp.bundleId).toBe("com.acme.readinglist");
  });

  it("warns when the packager says it derived the bundle id", async () => {
    const dir = project();
    distFor(dir, "safari");
    cliResponse = summariesOf({
      browser: "safari",
      safari: {
        appName: "Reading List",
        bundleId: "dev.extensionjs.Reading-List",
        bundleIdDerived: true,
      },
    });

    const result = await run({ projectPath: dir, browser: "safari" });

    expect(result.ok).toBe(true);
    expect(result.value.safariApp.bundleId).toBe("dev.extensionjs.Reading-List");
    const warnings = (result.warnings ?? []).join(" ");
    expect(warnings).toContain("dev.extensionjs.Reading-List");
    expect(warnings).toContain("reject it for distribution");
  });

  it("stays quiet about a dev.extensionjs id the developer actually owns", async () => {
    const dir = project();
    distFor(dir, "safari");
    cliResponse = summariesOf({
      browser: "safari",
      safari: {
        appName: "Reading List",
        bundleId: "dev.extensionjs.mine",
        bundleIdDerived: false,
      },
    });

    const result = await run({
      projectPath: dir,
      browser: "safari",
      bundleId: "dev.extensionjs.mine",
    });

    expect(result.ok).toBe(true);
    expect((result.warnings ?? []).join(" ")).not.toContain(
      "reject it for distribution",
    );
  });

  it("warns about a derived id that carries no dev.extensionjs prefix at all", async () => {
    const dir = project();
    distFor(dir, "safari");
    cliResponse = summariesOf({
      browser: "safari",
      safari: {
        appName: "Reading List",
        bundleId: "com.example.generated",
        bundleIdDerived: true,
      },
    });

    const result = await run({ projectPath: dir, browser: "safari" });

    const warnings = (result.warnings ?? []).join(" ");
    expect(warnings).toContain("com.example.generated");
    expect(warnings).toContain("reject it for distribution");
  });

  it("never reads project.pbxproj to invent an identity the engine did not report", async () => {
    const dir = project();
    distFor(dir, "safari");
    xcodeProject(dir, "safari", "com.stale.leftover");
    cliResponse = summariesOf({ browser: "safari", total_bytes: 10 });

    const result = await run({ projectPath: dir, browser: "safari" });

    expect(result.ok).toBe(true);
    expect(result.value.safariApp).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain("com.stale.leftover");
    expect((result.warnings ?? []).join(" ")).toContain(
      "reported no Safari app identity",
    );
  });

  it("says nothing about Safari when the target is not Safari", async () => {
    const dir = project();
    distFor(dir, "chrome");
    xcodeProject(dir, "chrome", "dev.extensionjs.Reading-List");
    cliResponse = summariesOf({
      browser: "chrome",
      safari: { appName: "Reading List", bundleIdDerived: true },
    });

    const result = await run({ projectPath: dir, browser: "chrome" });

    expect(result.ok).toBe(true);
    expect(result.value.safariApp).toBeUndefined();
    expect((result.warnings ?? []).join(" ")).not.toContain(
      "reject it for distribution",
    );
  });
});

describe("extension_build reads the build numbers off the engine, not off its prose", () => {
  it("carries the reported totals and output path into the envelope", async () => {
    const dir = project();
    distFor(dir, "chrome");
    cliResponse = summariesOf({
      browser: "chrome",
      output_path: path.join(dir, "dist", "chrome"),
      total_assets: 7,
      total_bytes: 123456,
      largest_asset_bytes: 60000,
      warnings_count: 1,
      warnings: ["asset size limit exceeded"],
    });

    const result = await run({ projectPath: dir, browser: "chrome" });

    expect(result.ok).toBe(true);
    expect(result.value.totalBytes).toBe(123456);
    expect(result.value.totalAssets).toBe(7);
    expect(result.value.largestAssetBytes).toBe(60000);
    expect(result.value.outputPath).toBe(path.join(dir, "dist", "chrome"));
    expect(result.value.engineBuildStatus).toBe("built");
    expect(result.warnings).toContain("asset size limit exceeded");
  });

  it("keeps the engine's human lines out of the parsed envelope but in the output tail", async () => {
    const dir = project();
    distFor(dir, "chrome");
    cliResponse = {
      ...summariesOf({ browser: "chrome", total_bytes: 5 }),
      stderr: "Build Status: success\nSize: 12 kB",
    };

    const result = await run({ projectPath: dir, browser: "chrome" });

    expect(result.value.totalBytes).toBe(5);
    expect(result.value.output).toContain("Size: 12 kB");
    expect(result.value.output).not.toContain('"schema"');
  });

  it("reports the engine's own failure message when the build fails", async () => {
    const dir = project();
    distFor(dir, "chrome");
    cliResponse = {
      code: 1,
      stdout: JSON.stringify({
        schema: 1,
        ok: false,
        command: "build",
        status: "build-failed",
        value: null,
        error: { code: "E_COMPILE", message: "Module not found: ./nope.js" },
        warnings: [],
      }),
      stderr: "",
    };

    const result = await run({ projectPath: dir, browser: "chrome" });

    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("E_BUILD_FAILED");
    expect(result.error.message).toBe("Module not found: ./nope.js");
  });
});

describe("extension_build against an engine older than the summaries contract", () => {
  it("falls back to the persisted build summary when the envelope has none", async () => {
    const dir = project();
    distFor(dir, "chrome");
    cliResponse = engineSaid({
      projectPath: ".",
      browsers: ["chrome"],
      mode: "production",
    });
    persistSummary(dir, "chrome", {
      browser: "chrome",
      total_assets: 3,
      total_bytes: 4096,
      largest_asset_bytes: 2048,
      warnings_count: 1,
      warnings: ["Deprecation: legacy API"],
    });

    const result = await run({ projectPath: dir, browser: "chrome" });

    expect(result.ok).toBe(true);
    expect(result.value.totalBytes).toBe(4096);
    expect(result.value.totalAssets).toBe(3);
    expect(result.value.largestAssetBytes).toBe(2048);
    expect(result.warnings).toContain("Deprecation: legacy API");
  });

  it("still finds the summary when the engine printed no envelope at all", async () => {
    const dir = project();
    distFor(dir, "chrome");
    cliResponse = {
      code: 0,
      stdout: "Build Status: success\nSize: 12 kB",
      stderr: "",
    };
    persistSummary(dir, "chrome", {
      browser: "chrome",
      total_bytes: 999,
      warnings_count: 0,
    });

    const result = await run({ projectPath: dir, browser: "chrome" });

    expect(result.ok).toBe(true);
    expect(result.value.totalBytes).toBe(999);
    expect(result.value.engineBuildStatus).toBeUndefined();
    expect(result.value.output).toContain("Build Status: success");
  });

  it("recovers the Safari identity from the persisted summary when the envelope has none", async () => {
    const dir = project();
    distFor(dir, "safari");
    cliResponse = engineSaid({ projectPath: ".", browsers: ["safari"] });
    persistSummary(dir, "safari", {
      browser: "safari",
      total_bytes: 10,
      safari: {
        appName: "Reading List",
        bundleId: "dev.extensionjs.Reading-List",
        bundleIdDerived: true,
      },
    });

    const result = await run({ projectPath: dir, browser: "safari" });

    expect(result.value.safariApp.bundleId).toBe("dev.extensionjs.Reading-List");
    expect((result.warnings ?? []).join(" ")).toContain(
      "reject it for distribution",
    );
  });

  it("names the absolute path it read when no summary is anywhere to be found", async () => {
    const dir = project();
    distFor(dir, "chrome");
    cliResponder = engineTooOldFor({ code: 0, stdout: "", stderr: "" });

    const result = await run({ projectPath: dir, browser: "chrome" });

    expect(result.ok).toBe(true);
    const warnings = (result.warnings ?? []).join(" ");
    expect(warnings).toContain(
      path.join(dir, "dist", "extension-js", "chrome", "build-summary.json"),
    );
    expect(warnings).toContain("The extension that was built is unaffected");
    expect(warnings).toContain("its layout may differ");
  });

  it("stays quiet about the path when the summary was found where it looked", async () => {
    const dir = project();
    distFor(dir, "chrome");
    cliResponder = engineTooOldFor({ code: 0, stdout: "", stderr: "" });
    persistSummary(dir, "chrome", { browser: "chrome", total_bytes: 64 });

    const result = await run({ projectPath: dir, browser: "chrome" });

    expect(result.value.totalBytes).toBe(64);
    expect((result.warnings ?? []).join(" ")).not.toContain(
      "build-summary.json",
    );
  });

  it("does not read the disk at all when the engine answered inline", async () => {
    const dir = project();
    distFor(dir, "chrome");
    cliResponse = summariesOf({ browser: "chrome", total_bytes: 8 });

    const result = await run({ projectPath: dir, browser: "chrome" });

    expect(result.value.totalBytes).toBe(8);
    expect((result.warnings ?? []).join(" ")).not.toContain(
      "build-summary.json",
    );
  });

  it("says the identity is unknown rather than guessing when nothing reported one", async () => {
    const dir = project();
    distFor(dir, "safari");
    cliResponse = engineSaid({ projectPath: ".", browsers: ["safari"] });

    const result = await run({ projectPath: dir, browser: "safari" });

    expect(result.ok).toBe(true);
    expect(result.value.safariApp).toBeUndefined();
    const warnings = (result.warnings ?? []).join(" ");
    expect(warnings).toContain("reported no Safari app identity");
    expect(warnings).toContain("predates the reporting contract");
  });
});

describe("extension_build survives an engine that has no --output flag at all", () => {
  it("retries once without the flag and still reports the build", async () => {
    const dir = project();
    distFor(dir, "chrome");
    cliResponder = engineTooOldFor({
      code: 0,
      stdout: "Build Status: success\nSize: 12 kB",
      stderr: "",
    });
    persistSummary(dir, "chrome", {
      browser: "chrome",
      total_assets: 4,
      total_bytes: 12288,
      warnings_count: 1,
      warnings: ["Deprecation: legacy API"],
    });

    const result = await run({ projectPath: dir, browser: "chrome" });

    expect(result.ok).toBe(true);
    expect(cliCalls).toHaveLength(2);
    expect(cliCalls[0]).toContain("--output");
    expect(cliCalls[1]).not.toContain("--output");
    expect(result.value.totalBytes).toBe(12288);
    expect(result.value.totalAssets).toBe(4);
    expect(result.value.engineRejectedJsonOutput).toBe(true);
    expect(result.warnings).toContain("Deprecation: legacy API");
    const warnings = (result.warnings ?? []).join(" ");
    expect(warnings).toContain("older than the one this server expects");
    expect(warnings).toContain("Upgrade the project's Extension.js");
  });

  it("keeps a flag the caller chose on the retry instead of dropping that too", async () => {
    const dir = project();
    distFor(dir, "safari");
    cliResponder = engineTooOldFor({ code: 0, stdout: "", stderr: "" });

    await run({ projectPath: dir, browser: "safari", macOsOnly: false });

    expect(cliCalls).toHaveLength(2);
    expect(cliCalls[1]).toContain("--macos-only");
    expect(cliCalls[1][cliCalls[1].indexOf("--macos-only") + 1]).toBe("false");
  });

  it("does not retry a genuine build failure", async () => {
    const dir = project();
    distFor(dir, "chrome");
    cliResponse = {
      code: 1,
      stdout: "",
      stderr: "Module not found: ./nope.js",
    };

    const result = await run({ projectPath: dir, browser: "chrome" });

    expect(cliCalls).toHaveLength(1);
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("E_BUILD_FAILED");
    expect(result.error.message).toBe("Module not found: ./nope.js");
    expect((result.warnings ?? []).join(" ")).not.toContain(
      "older than the one this server expects",
    );
  });

  it("does not retry when the refused flag is one the caller chose", async () => {
    const dir = project();
    distFor(dir, "safari");
    cliResponse = {
      code: 1,
      stdout: "",
      stderr: "error: unknown option '--macos-only'",
    };

    const result = await run({
      projectPath: dir,
      browser: "safari",
      macOsOnly: false,
    });

    expect(cliCalls).toHaveLength(1);
    expect(result.ok).toBe(false);
    expect(result.error.message).toContain("--macos-only");
  });

  it("does not retry a failure that merely mentions the word output", async () => {
    const dir = project();
    distFor(dir, "chrome");
    cliResponse = {
      code: 1,
      stdout: "",
      stderr: "ERROR in ./src/output.js: cannot resolve --output-path",
    };

    await run({ projectPath: dir, browser: "chrome" });

    expect(cliCalls).toHaveLength(1);
  });

  it("does not retry when the engine exited zero", async () => {
    const dir = project();
    distFor(dir, "chrome");
    cliResponse = { code: 0, stdout: "", stderr: UNKNOWN_OUTPUT };

    const result = await run({ projectPath: dir, browser: "chrome" });

    expect(cliCalls).toHaveLength(1);
    expect(result.value.engineRejectedJsonOutput).toBeUndefined();
  });

  it("retries exactly once, even when the second run fails the same way", async () => {
    const dir = project();
    distFor(dir, "chrome");
    cliResponse = { code: 1, stdout: "", stderr: UNKNOWN_OUTPUT };

    const result = await run({ projectPath: dir, browser: "chrome" });

    expect(cliCalls).toHaveLength(2);
    expect(result.ok).toBe(false);
    expect((result.warnings ?? []).join(" ")).toContain(
      "older than the one this server expects",
    );
  });
});

describe("extension_build refuses a Safari packaging option it cannot honour", () => {
  it("refuses the options on a non-Safari target instead of ignoring them", async () => {
    const dir = project();
    distFor(dir, "chrome");

    const result = await run({
      projectPath: dir,
      browser: "chrome",
      bundleId: "com.acme.readinglist",
    });

    expect(result.ok).toBe(false);
    expect(result.status).toBe("safari-only-option");
    expect(result.error.code).toBe("E_SAFARI_ONLY_OPTION");
    expect(result.value.options).toEqual(["bundleId"]);
    expect(cliCalls).toHaveLength(0);
  });

  it("names every offending option, not just the first", async () => {
    const dir = project();
    distFor(dir, "chrome");

    const result = await run({
      projectPath: dir,
      browser: "chrome",
      appName: "Reading List",
      bundleId: "com.acme.readinglist",
      macOsOnly: true,
      forceRegenerate: true,
    });

    expect(result.value.options).toEqual([
      "appName",
      "bundleId",
      "macOsOnly",
      "forceRegenerate",
    ]);
  });

  it("refuses macOsOnly: false on a non-Safari target, since false is a real request", async () => {
    const dir = project();
    distFor(dir, "chrome");

    const result = await run({
      projectPath: dir,
      browser: "chrome",
      macOsOnly: false,
    });

    expect(result.ok).toBe(false);
    expect(result.status).toBe("safari-only-option");
    expect(result.error.code).toBe("E_SAFARI_ONLY_OPTION");
    expect(result.value.options).toEqual(["macOsOnly"]);
    expect(cliCalls).toHaveLength(0);
  });

  it("lets forceRegenerate: false through on a non-Safari target", async () => {
    const dir = project();
    distFor(dir, "chrome");

    const result = await run({
      projectPath: dir,
      browser: "chrome",
      forceRegenerate: false,
    });

    expect(result.ok).toBe(true);
    expect(cliCalls).toHaveLength(1);
  });

  it("forwards both sides of macOsOnly to the engine", async () => {
    const dir = project();
    distFor(dir, "safari");

    for (const value of [true, false]) {
      cliCalls.length = 0;
      await run({ projectPath: dir, browser: "safari", macOsOnly: value });
      const cli = cliCalls[0];
      expect(cli).toContain("--macos-only");
      expect(cli[cli.indexOf("--macos-only") + 1]).toBe(String(value));
    }
  });

  it("omits --macos-only entirely when it was not asked for", async () => {
    const dir = project();
    distFor(dir, "safari");

    await run({ projectPath: dir, browser: "safari" });

    expect(cliCalls[0]).not.toContain("--macos-only");
  });

  it("offers macOsOnly on the tool schema, gated to Safari like the rest", async () => {
    const macOsOnly = (build.schema.inputSchema.properties as Record<
      string,
      { type?: string; description?: string }
    >).macOsOnly;

    expect(macOsOnly?.type).toBe("boolean");
    expect(macOsOnly?.description).toContain("Safari targets only");
  });

  it("rejects a bundle id Xcode would reject, before paying for a build", async () => {
    const dir = project();
    distFor(dir, "safari");

    for (const bad of ["notreversedns", "com.acme.", "1com.acme", "com..acme"]) {
      cliCalls.length = 0;
      const result = await run({
        projectPath: dir,
        browser: "safari",
        bundleId: bad,
      });

      expect(result.ok, `${bad} was accepted`).toBe(false);
      expect(result.status).toBe("invalid-bundle-id");
      expect(result.error.code).toBe("E_INVALID_BUNDLE_ID");
      expect(cliCalls).toHaveLength(0);
    }
  });

  it("accepts the reverse-DNS shapes Apple accepts", async () => {
    const dir = project();
    distFor(dir, "safari");

    for (const good of ["com.acme.readinglist", "dev.a.b.c", "com.a-b.c9"]) {
      cliCalls.length = 0;
      const result = await run({
        projectPath: dir,
        browser: "safari",
        bundleId: good,
      });

      expect(result.ok, `${good} was rejected`).toBe(true);
      expect(cliCalls).toHaveLength(1);
    }
  });
});

const ENGINE_IS_VALID_BUNDLE_ID_SOURCE =
  "^[A-Za-z][A-Za-z0-9-]*(\\.[A-Za-z][A-Za-z0-9-]*)+$";

describe("the local bundle-id validator stays the engine's validator", () => {
  it("is character for character the regex isValidBundleId applies", () => {
    expect(build.BUNDLE_ID_PATTERN.source).toBe(
      ENGINE_IS_VALID_BUNDLE_ID_SOURCE,
    );
    expect(build.BUNDLE_ID_PATTERN.flags).toBe("");
  });

  it("agrees with the engine's rules on every shape either side cares about", () => {
    const engine = new RegExp(ENGINE_IS_VALID_BUNDLE_ID_SOURCE);
    const cases = [
      "com.acme.readinglist",
      "dev.extensionjs.reading-list",
      "com.a-b.c9",
      "A.B",
      "a.b.c.d.e",
      "com.acme-",
      "notreversedns",
      "com.acme.",
      ".com.acme",
      "1com.acme",
      "com..acme",
      "com.9acme",
      "com.acme_list",
      "com.acme readinglist",
      "com.acme.readinglist\n",
      "",
    ];

    for (const candidate of cases) {
      expect(
        build.BUNDLE_ID_PATTERN.test(candidate),
        `disagreed on ${JSON.stringify(candidate)}`,
      ).toBe(engine.test(candidate));
    }
  });
});
