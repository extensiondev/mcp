import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildIdFor, producerVersion, readBuildId } from "../lib/build-id";
import { serverVersion } from "../lib/producer-version";

import { version } from "../../package.json";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const quiet = ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false"];

function git(root: string, args: string[]): string {
  return execFileSync("git", [...quiet, ...args], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}

function repo(packageVersion: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-build-id-"));
  dirs.push(root);
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "x", version: packageVersion }));
  git(root, ["init", "-q"]);
  git(root, ["add", "."]);
  git(root, ["commit", "-q", "-m", "Start the package"]);

  return root;
}

const facts = {
  version: "10.18.1",
  headSha: "48f1eba",
  tagsAtHead: [] as string[],
  headSubject: "Fix a thing",
  committedVersion: "10.18.1" as string | null,
};

describe("a build that is not a release carries the short sha as semver build metadata", () => {
  it("answers the sha for a commit past the last release", () => {
    expect(buildIdFor(facts)).toBe("48f1eba");
  });

  it("answers nothing when HEAD carries the release tag of the package version", () => {
    expect(buildIdFor({ ...facts, tagsAtHead: ["v10.18.1"] })).toBe("");
    expect(buildIdFor({ ...facts, tagsAtHead: ["v10.18.0"] })).toBe("48f1eba");
  });

  it("answers nothing on the release rail, where the bump is built and published before it is committed", () => {
    expect(buildIdFor({ ...facts, version: "10.19.0", committedVersion: "10.18.1" })).toBe("");
    expect(buildIdFor({ ...facts, headSubject: "Release v10.18.1" })).toBe("");
  });

  it("answers nothing for a canary or a version that already carries metadata, and without git", () => {
    expect(buildIdFor({ ...facts, version: "10.19.0-canary.12.48f1eba" })).toBe("");
    expect(buildIdFor({ ...facts, version: "10.18.1+other" })).toBe("");
    expect(buildIdFor({ ...facts, headSha: "" })).toBe("");
  });

  it("reads the facts from the checkout, and stays bare where there is no repository", () => {
    const root = repo("1.2.3");

    expect(readBuildId(root)).toBe(git(root, ["rev-parse", "--short", "HEAD"]));

    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "x", version: "1.2.4" }));
    expect(readBuildId(root)).toBe("");

    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "x", version: "1.2.3" }));
    git(root, ["tag", "v1.2.3"]);
    expect(readBuildId(root)).toBe("");

    const bare = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-build-id-bare-"));
    dirs.push(bare);
    fs.writeFileSync(path.join(bare, "package.json"), JSON.stringify({ name: "x", version: "1.2.3" }));
    expect(readBuildId(bare)).toBe("");
  });

  it("stamps the producer version as <version>+<sha>, and bare without a build id", () => {
    expect(producerVersion("10.18.1", "48f1eba")).toBe("10.18.1+48f1eba");
    expect(producerVersion("10.18.1", "")).toBe("10.18.1");
    expect(serverVersion("48f1eba")).toBe(`${version}+48f1eba`);
    expect(serverVersion("")).toBe(version);
  });
});
