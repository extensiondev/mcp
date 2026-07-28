import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

import {
  PERSISTED_PROFILE_DIR_NAME,
  browserProfileRootDir,
  profileRemediation,
  profilesRootDir,
  sessionArtifactsRootDir,
} from "../lib/session-paths";

const PROJECT = "/tmp/mcp-managed-profile-project";
const BROWSERS = ["chrome", "chromium", "edge", "firefox"];
const RUN_DIR = "tidy-amber-otter";

const posix = (value: string) => value.split(path.sep).join("/");

function engineDistFiles(): string[] {
  const require = createRequire(import.meta.url);
  const dist = path.join(
    path.dirname(require.resolve("extension-develop/package.json")),
    "dist",
  );
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (/\.(mjs|cjs|js)$/.test(entry.name)) out.push(full);
    }
  };
  walk(dist);
  return out;
}

/* @invariant The test that did not exist. dist/extension-profile-<browser> was
   never checked against the engine, only against other copies of the same guess,
   so every fixture agreed with the code and the code agreed with nothing. This
   reads the engine artifact that is actually installed and asks it. */
describe("the managed profile root matches the engine that is installed", () => {
  it("hangs the profiles root off the engine's own session-artifacts helper", () => {
    expect(profilesRootDir(PROJECT)).toBe(
      path.join(sessionArtifactsRootDir(PROJECT), "profiles"),
    );
    expect(profilesRootDir(PROJECT)).toBe(
      path.resolve(PROJECT, "dist", "extension-js", "profiles"),
    );
  });

  it("names a segment the pinned engine's shipped code writes", () => {
    const hits = engineDistFiles().filter((file) =>
      fs.readFileSync(file, "utf8").includes("extension-js/profiles"),
    );
    expect(hits.length).toBeGreaterThan(0);
    expect(posix(profilesRootDir(PROJECT))).toContain("extension-js/profiles");
  });

  it("gives every browser its own directory under that root", () => {
    for (const browser of BROWSERS) {
      expect(browserProfileRootDir(PROJECT, browser)).toBe(
        path.join(profilesRootDir(PROJECT), `${browser}-profile`),
      );
    }
    expect(browserProfileRootDir(PROJECT, "chrome")).not.toBe(
      browserProfileRootDir(PROJECT, "firefox"),
    );
  });

  it("builds nothing in the retired flat shape", () => {
    for (const browser of BROWSERS) {
      expect(browserProfileRootDir(PROJECT, browser)).not.toContain(
        `extension-profile-${browser}`,
      );
      expect(browserProfileRootDir(PROJECT, browser)).not.toBe(
        path.join(PROJECT, "dist", `extension-profile-${browser}`),
      );
    }
  });

  /* @invariant The browser root is the deepest thing this package may claim to
     know. The run directory below it is "dev" for a persisted profile and three
     freshly drawn random words for an ephemeral one, so a helper that returned a
     full profile path would be inventing the one segment the engine alone can
     name. */
  it("stops one level above the run directory the engine names at random", () => {
    const root = browserProfileRootDir(PROJECT, "chrome");
    for (const run of [PERSISTED_PROFILE_DIR_NAME, RUN_DIR]) {
      expect(path.dirname(path.join(root, run))).toBe(root);
    }
  });

  it("covers every browser and every run directory with one process-match prefix", () => {
    const prefix = profilesRootDir(PROJECT) + path.sep;
    for (const browser of BROWSERS) {
      for (const run of [PERSISTED_PROFILE_DIR_NAME, RUN_DIR]) {
        const launched = path.join(
          browserProfileRootDir(PROJECT, browser),
          run,
        );
        expect(launched.startsWith(prefix)).toBe(true);
      }
    }
  });
});

describe("the profile-locked remediation names a path that can exist", () => {
  it("points a managed session at the directory the engine creates", () => {
    const advice = profileRemediation({
      projectPath: PROJECT,
      browser: "chrome",
    });
    expect(advice).toContain(browserProfileRootDir(PROJECT, "chrome"));
    expect(advice).not.toContain("extension-profile-");
  });

  /* @invariant Naming the root is only half of it. The advice has to say how to
     find the run directory inside, because a user who is told to remove a
     literal that turns out not to exist deletes nothing and concludes the tool
     is lying to them, which is what the old sentence did. */
  it("tells the caller to look inside rather than asserting a run directory", () => {
    const root = browserProfileRootDir(PROJECT, "chrome");
    const advice = profileRemediation({
      projectPath: PROJECT,
      browser: "chrome",
    });
    expect(advice).toMatch(/List /);
    expect(advice).toContain(`"${PERSISTED_PROFILE_DIR_NAME}"`);
    expect(advice).toMatch(/random/);
    const deeper = new RegExp(
      `${root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\${path.sep}\\S`,
    );
    expect(advice).not.toMatch(deeper);
  });

  it("sends an explicit profile back to the directory the caller passed", () => {
    const advice = profileRemediation({
      projectPath: PROJECT,
      browser: "chrome",
      profile: "./my-profile",
    });
    expect(advice).toContain(path.resolve(PROJECT, "my-profile"));
    expect(advice).not.toContain(browserProfileRootDir(PROJECT, "chrome"));
  });

  it("tells a system-profile session to close the browser, not to delete anything", () => {
    const advice = profileRemediation({
      projectPath: PROJECT,
      browser: "chrome",
      profile: "false",
    });
    expect(advice).not.toContain(profilesRootDir(PROJECT));
    expect(advice).toMatch(/Quit the chrome window/);
  });
});
