import { describe, it, expect, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const cliCalls: string[][] = [];
vi.mock("../lib/exec", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/exec")>();
  return {
    ...actual,
    runExtensionCli: async (args: string[]) => {
      cliCalls.push(args);
      return { code: 0, stdout: "Build Status: success", stderr: "" };
    },
  };
});

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

const run = async (args: Parameters<typeof build.handler>[0]) =>
  JSON.parse(await build.handler(args));

afterEach(() => {
  cliCalls.length = 0;
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

  it("omits --force-regenerate when it was not asked for", async () => {
    const dir = project();
    distFor(dir, "safari");

    await run({ projectPath: dir, browser: "safari", forceRegenerate: false });

    expect(cliCalls[0]).not.toContain("--force-regenerate");
  });

  it("reports the identity read back out of the generated Xcode project", async () => {
    const dir = project();
    distFor(dir, "safari");
    xcodeProject(dir, "safari", "com.acme.readinglist");

    const result = await run({
      projectPath: dir,
      browser: "safari",
      bundleId: "com.acme.readinglist",
    });

    expect(result.value.safariApp).toMatchObject({
      appName: "Reading List",
      bundleId: "com.acme.readinglist",
    });
    expect(result.value.safariApp.xcodeProject).toContain("safari-xcode");
    expect((result.warnings ?? []).join(" ")).not.toContain("dev.extensionjs");
  });

  it("warns when the app was packaged under a bundle id the developer does not own", async () => {
    const dir = project();
    distFor(dir, "safari");
    xcodeProject(dir, "safari", "dev.extensionjs.Reading-List");

    const result = await run({ projectPath: dir, browser: "safari" });

    expect(result.ok).toBe(true);
    expect(result.value.safariApp.bundleId).toBe(
      "dev.extensionjs.Reading-List",
    );
    const warnings = (result.warnings ?? []).join(" ");
    expect(warnings).toContain("dev.extensionjs.Reading-List");
    expect(warnings).toContain("reject it for distribution");
  });

  it("says nothing about Safari when the target is not Safari", async () => {
    const dir = project();
    distFor(dir, "chrome");
    xcodeProject(dir, "chrome", "dev.extensionjs.Reading-List");

    const result = await run({ projectPath: dir, browser: "chrome" });

    expect(result.ok).toBe(true);
    expect(result.value.safariApp).toBeUndefined();
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
      forceRegenerate: true,
    });

    expect(result.value.options).toEqual([
      "appName",
      "bundleId",
      "forceRegenerate",
    ]);
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
