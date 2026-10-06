import { describe, expect, it } from "vitest";
import fs from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import { version } from "../index";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const require = createRequire(import.meta.url);

describe("the release version gate reads the bundle's own manifest", () => {
  it("exports the manifest version from the module the bundle is built from", () => {
    const pkg = require("../../package.json") as { version: string };
    expect(version).toBe(pkg.version);
  });

  it("asserts on the module's version export, not on a substring anywhere in the bundle", () => {
    const yml = fs.readFileSync(
      fileURLToPath(
        new URL("../../.github/workflows/release.yml", import.meta.url),
      ),
      "utf8",
    );
    expect(yml).not.toMatch(/grep -qF "\$VERSION" dist\/module\.js/);
    expect(yml).toContain('import("./dist/module.js")');
    expect(yml).toContain("m.version");
  });
});

/*. */
describe("the release rails fail closed", () => {
  const read = (rel: string) => fs.readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), "utf8");

  it("publishes to npm before it pushes the bump commit and the tag", () => {
    const yml = read(".github/workflows/release.yml");
    const publishAt = yml.indexOf("name: Publish to npm with provenance");
    const tagAt = yml.indexOf("name: Commit and tag release");
    expect(publishAt).toBeGreaterThan(-1);
    expect(tagAt).toBeGreaterThan(publishAt);
    expect(yml).toMatch(/if: steps\.published\.outputs\.already != 'true'/);
  });

  it("reads E404 as not published and every other npm view failure as unknown", () => {
    const yml = read(".github/workflows/release.yml");
    expect(yml).toMatch(/grep -q "E404"/);
    expect(yml).toMatch(/Could not read the registry/);
    expect(yml).not.toMatch(/npm view "\$PKG@\$VER" version --registry https:\/\/registry\.npmjs\.org\/ >\/dev\/null 2>&1; then/);
  });

  it("lets the nightly alert need every job it judges", () => {
    const yml = read(".github/workflows/ci.yml");
    const needs = /nightly-alert:[\s\S]*?needs: \[([^\]]+)\]/.exec(yml)?.[1] ?? "";
    expect(needs.split(",").map((s) => s.trim())).toContain("engine-pin");
  });

  it("gives the registry publish job longer than the wait it runs", () => {
    const script = read("scripts/publish-mcp-registry.sh");
    const attempts = Number(/NPM_WAIT_ATTEMPTS=(\d+)/.exec(script)?.[1]);
    const seconds = Number(/NPM_WAIT_SECONDS=(\d+)/.exec(script)?.[1]);
    const yml = read(".github/workflows/publish-mcp.yml");
    const timeout = Number(/timeout-minutes: (\d+)/.exec(yml)?.[1]);
    expect(timeout * 60).toBeGreaterThan(attempts * seconds);
  });

  it("fails the README width step when nothing was replaced", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-readme-width-"));
    const readme = path.join(dir, "README.md");
    fs.writeFileSync(readme, "<img src=\"logo.png\" width=\"99%\">\n");
    try {
      const result = spawnSync(process.execPath, [fileURLToPath(new URL("../../scripts/readme-logo-width.mjs", import.meta.url)), "npm"], {
        env: { ...process.env, README_LOGO_WIDTH_PATH: readme },
        encoding: "utf8",
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/nothing was rewritten/);
      fs.writeFileSync(readme, "<img src=\"logo.png\" width=\"15.5%\">\n");
      const ok = spawnSync(process.execPath, [fileURLToPath(new URL("../../scripts/readme-logo-width.mjs", import.meta.url)), "npm"], {
        env: { ...process.env, README_LOGO_WIDTH_PATH: readme },
        encoding: "utf8",
      });
      expect(ok.status).toBe(0);
      expect(fs.readFileSync(readme, "utf8")).toContain('width="20.7%"');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
