import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  PERSISTED_PROFILE_DIR_NAME,
  browserProfileRootDir,
} from "../lib/session-paths";
import { profileCarriesTabsOver } from "../lib/profile-carryover";

const tmpDirs: string[] = [];
function tmpProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-profile-carry-"));
  tmpDirs.push(dir);
  return dir;
}

function seedPersistedProfile(projectPath: string, browser: string): string {
  const dir = path.join(
    browserProfileRootDir(projectPath, browser),
    PERSISTED_PROFILE_DIR_NAME,
  );
  fs.mkdirSync(path.join(dir, "Default"), { recursive: true });
  fs.writeFileSync(path.join(dir, "Default", "Preferences"), "{}");
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("profileCarriesTabsOver", () => {
  it("says no for the throwaway managed profile of a first run", () => {
    expect(profileCarriesTabsOver(tmpProject(), "chrome")).toBe(false);
  });

  it("says yes once the persisted managed profile holds a previous run", () => {
    const project = tmpProject();
    seedPersistedProfile(project, "chrome");
    expect(profileCarriesTabsOver(project, "chrome")).toBe(true);
  });

  it("keeps the answer per browser", () => {
    const project = tmpProject();
    seedPersistedProfile(project, "chrome");
    expect(profileCarriesTabsOver(project, "edge")).toBe(false);
  });

  it("says yes for the real user profile, which is never this run's own", () => {
    expect(profileCarriesTabsOver(tmpProject(), "chrome", "false")).toBe(true);
  });

  it("says yes for an explicit profile path that already has state", () => {
    const project = tmpProject();
    const named = path.join(project, "my-profile");
    fs.mkdirSync(named, { recursive: true });
    fs.writeFileSync(path.join(named, "Preferences"), "{}");
    expect(profileCarriesTabsOver(project, "chrome", named)).toBe(true);
  });

  it("says no for an explicit profile path that does not exist yet", () => {
    const project = tmpProject();
    expect(
      profileCarriesTabsOver(project, "chrome", path.join(project, "unborn")),
    ).toBe(false);
  });

  it("ignores an empty profile argument", () => {
    expect(profileCarriesTabsOver(tmpProject(), "chrome", "   ")).toBe(false);
  });
});
