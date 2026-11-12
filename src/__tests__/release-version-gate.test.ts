import fs from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

import { version } from "../index";

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

  it("publishes a canary under the canary tag and leaves main, tags, releases and the listing alone", () => {
    const yml = read(".github/workflows/release.yml");

    const step = (name: string) => {
      const start = yml.indexOf(`- name: ${name}\n`);
      expect(start).toBeGreaterThan(-1);
      const next = yml.indexOf("\n      - name: ", start + 1);

      return yml.slice(start, next === -1 ? undefined : next);
    };

    expect(yml).toMatch(/options: \[stable, canary\]/);
    expect(yml).toContain('echo "dist_tag=canary"');
    expect(yml).toContain('echo "dist_tag=latest"');
    expect(step("Publish to npm with provenance")).toContain("--tag ${{ steps.validate.outputs.dist_tag }}");

    for (const name of [
      "Extract release notes from CHANGELOG.md",
      "Authenticate the release push as the deploy key",
      "Commit and tag release",
      "Create GitHub release",
      "Publish the listing to the MCP registry",
    ]) {
      expect(step(name), name).toContain("if: inputs.channel == 'stable'");
    }
  });

  it("keeps a refused publish from tagging and reports it in the summary while the run stays red", () => {
    const yml = read(".github/workflows/release.yml");

    const step = (name: string) => {
      const start = yml.indexOf(`- name: ${name}\n`);
      expect(start).toBeGreaterThan(-1);
      const next = yml.indexOf("\n      - name: ", start + 1);

      return yml.slice(start, next === -1 ? undefined : next);
    };

    expect(step("Publish to npm with provenance")).toContain("continue-on-error: true");
    expect(step("Commit and tag release")).toContain("steps.publish.outcome != 'failure'");
    expect(step("Create GitHub release")).toContain("steps.tag.outcome == 'success'");
    expect(step("Create GitHub release")).toContain('gh release view "$TAG" >/dev/null 2>&1 || gh release create');
    expect(step("Publish the listing to the MCP registry")).toContain("steps.tag.outcome == 'success'");

    const report = step("Report the npm publish");
    expect(yml.indexOf("name: Report the npm publish")).toBeGreaterThan(yml.indexOf("name: Publish the listing to the MCP registry"));
    expect(report).toContain("npm publish refused (npm/cli#9969)");
    expect(report).toContain("scripts/stage-release.sh $VERSION");
    expect(report).toContain("release_commit=$BUILT_FROM");
    expect(report).toMatch(/exit 1\s*$/);
  });

  it("reads E404 as not published and every other npm view failure as unknown", () => {
    const yml = read(".github/workflows/release.yml");
    expect(yml).toMatch(/grep -q "E404"/);
    expect(yml).toMatch(/Could not read the registry/);
    expect(yml).not.toMatch(/npm view "\$PKG@\$VER" version --registry https:\/\/registry\.npmjs\.org\/ >\/dev\/null 2>&1; then/);
  });

  it("tracks no npm credential and no interpolated value at the repository root", () => {
    const npmrc = fileURLToPath(new URL("../../.npmrc", import.meta.url));

    if (fs.existsSync(npmrc)) {
      const text = fs.readFileSync(npmrc, "utf8");
      expect(text).not.toMatch(/\$\{[^}]*\}/);
      expect(text).not.toContain("_authToken");
    }

    for (const rel of ["release.yml", "ci.yml", "publish-mcp.yml", "sync-templates.yml"]) {
      expect(read(`.github/workflows/${rel}`), rel).not.toContain("NPM_TOKEN");
    }
  });

  it("publishes through the GitHub OIDC token and never through a tracked npm credential", () => {
    const yml = read(".github/workflows/release.yml");
    expect(yml).toMatch(/^permissions:\n(?: {2}.*\n)* {2}id-token: write$/m);
    const publishAt = yml.indexOf("name: Publish to npm with provenance");
    expect(publishAt).toBeGreaterThan(-1);
    expect(yml.slice(publishAt)).toMatch(/run: npm publish --provenance /);
    expect(yml).not.toMatch(/NODE_AUTH_TOKEN:\s*\$\{\{/);
    expect(yml).not.toContain(".npmrc");
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

  const stagedRelease = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-release-commit-"));
    const bin = path.join(dir, "bin");
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, "npm"), "#!/bin/sh\n[ -n \"$FAKE_GITHEAD\" ] && echo \"$FAKE_GITHEAD\"\nexit 0\n", { mode: 0o755 });
    const git = (...args: string[]) =>
      spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd: dir, encoding: "utf8" }).stdout.trim();
    git("init", "-q", "-b", "main");
    git("commit", "-q", "--allow-empty", "-m", "Built into the tarball");
    const built = git("rev-parse", "HEAD");
    git("commit", "-q", "--allow-empty", "-m", "Landed after staging");
    const later = git("rev-parse", "--short", "HEAD");
    const script = fileURLToPath(new URL("../../scripts/release-commit.sh", import.meta.url));
    const env = (extra: Record<string, string>) => ({
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      PKG: "@x/y",
      VERSION: "1.0.0",
      MAIN_REF: "main",
      GITHUB_OUTPUT: "",
      GITHUB_STEP_SUMMARY: "",
      RELEASE_COMMIT: "",
      FAKE_GITHEAD: "",
      ...extra,
    });
    const run = (extra: Record<string, string>) => spawnSync(script, [], { cwd: dir, encoding: "utf8", env: env(extra) });
    const runOnSocket = (extra: Record<string, string>) =>
      spawnSync(
        "python3",
        [
          "-I",
          "-c",
          [
            "import socket, subprocess, sys",
            "ours, theirs = socket.socketpair()",
            "child = subprocess.run([sys.argv[1]], stdout=theirs.fileno(), stderr=subprocess.PIPE)",
            "theirs.close()",
            "sys.stdout.write(ours.makefile('rb').read().decode())",
            "sys.stderr.write(child.stderr.decode())",
            "sys.exit(child.returncode)",
          ].join("\n"),
          script,
        ],
        { cwd: dir, encoding: "utf8", env: env(extra) },
      );
    const remove = () => fs.rmSync(dir, { recursive: true, force: true });

    return { built, later, run, runOnSocket, remove };
  };

  it.skipIf(process.platform === "win32")("tags the commit npm published on a resumed release and names what main gained since (the cell runs scripts/release-commit.sh through /bin/sh, which Windows has not)", () => {
    const yml = read(".github/workflows/release.yml");
    const resolveAt = yml.indexOf("name: Check out the commit npm published");
    expect(resolveAt).toBeGreaterThan(yml.indexOf("name: Check published version"));
    expect(resolveAt).toBeLessThan(yml.indexOf("name: Update package version"));
    expect(resolveAt).toBeLessThan(yml.indexOf("name: Extract release notes from CHANGELOG.md"));

    const { built, later, run, remove } = stagedRelease();

    try {
      const fromGitHead = run({ FAKE_GITHEAD: built });
      expect(fromGitHead.status, fromGitHead.stderr).toBe(0);
      expect(fromGitHead.stdout).toContain(`commit=${built}`);
      expect(fromGitHead.stdout).toContain(`${later} Landed after staging`);

      expect(run({ RELEASE_COMMIT: built }).stdout).toContain(`commit=${built}`);

      const neither = run({});
      expect(neither.status).not.toBe(0);
      expect(neither.stderr).toMatch(/release_commit/);
      expect(neither.stderr).toMatch(/gitHead/);

      const disagree = run({ FAKE_GITHEAD: built, RELEASE_COMMIT: later });
      expect(disagree.status).not.toBe(0);
      expect(disagree.stderr).toMatch(/different commits/);
    } finally {
      remove();
    }
  });

  it.skipIf(process.platform === "win32")("writes the summary to a standard output that is a socket when no step summary file is set (the cell needs /bin/sh and a python3 socketpair a child can inherit, which Windows has not)", () => {
    expect(read("scripts/release-commit.sh")).not.toMatch(/\/dev\/std(out|err)/);
    expect(read("scripts/stage-release.sh")).not.toMatch(/\/dev\/std(out|err)/);
    const { built, later, runOnSocket, remove } = stagedRelease();

    try {
      const onSocket = runOnSocket({ FAKE_GITHEAD: built });
      expect(onSocket.status, onSocket.stderr).toBe(0);
      expect(onSocket.stdout).toContain(`### @x/y@1.0.0 was built from`);
      expect(onSocket.stdout).toContain(`${later} Landed after staging`);
      expect(onSocket.stdout).toContain(`commit=${built}`);
    } finally {
      remove();
    }
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
      expect(result.stderr).toMatch(/holds neither/);
      fs.writeFileSync(readme, "<img src=\"logo.png\" width=\"15.5%\">\n");
      const ok = spawnSync(process.execPath, [fileURLToPath(new URL("../../scripts/readme-logo-width.mjs", import.meta.url)), "npm"], {
        env: { ...process.env, README_LOGO_WIDTH_PATH: readme },
        encoding: "utf8",
      });
      expect(ok.status).toBe(0);
      expect(fs.readFileSync(readme, "utf8")).toContain('width="20.7%"');
      const again = spawnSync(process.execPath, [fileURLToPath(new URL("../../scripts/readme-logo-width.mjs", import.meta.url)), "npm"], {
        env: { ...process.env, README_LOGO_WIDTH_PATH: readme },
        encoding: "utf8",
      });
      expect(again.status, "already at the npm width is done, not an error").toBe(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
