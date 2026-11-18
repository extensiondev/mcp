import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { directoryNotCreatedYet, recordContractPids, registerSession, removeSession, removeSessionMarker, sessionMarkerPath, sessionSidecarPath } from "../lib/process-manager";

const made: string[] = [];

afterEach(() => {
  for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function scratch(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-not-yet-"));
  made.push(dir);

  return dir;
}

describe("897: a session marker is named from a SHA-256 of the session, and a session started under an older name keeps it", () => {
  const savedDir = process.env.EXTENSION_MCP_SESSION_DIR;

  afterEach(() => {
    if (savedDir === undefined) delete process.env.EXTENSION_MCP_SESSION_DIR;
    else process.env.EXTENSION_MCP_SESSION_DIR = savedDir;
  });

  function sessionDir(): { dir: string; project: string; named: string } {
    const dir = scratch();
    const project = path.join(dir, "project");
    process.env.EXTENSION_MCP_SESSION_DIR = dir;

    return { dir, project, named: crypto.createHash("sha256").update(`${path.resolve(project)}::chrome`).digest("hex").slice(0, 16) };
  }

  it("names the marker and its sidecars from the first 16 hex characters of the SHA-256", () => {
    const { dir, project, named } = sessionDir();

    expect(sessionMarkerPath(project, "chrome")).toBe(path.join(dir, `${named}.json`));
    expect(sessionSidecarPath(project, "chrome", "idle")).toBe(path.join(dir, `${named}.idle.json`));
    expect(registerSession({ projectPath: project, browser: "chrome", pid: 4242, command: "dev" })).toBeNull();
    expect(fs.readdirSync(dir)).toEqual([`${named}.json`]);

    removeSession(project, "chrome");
    removeSessionMarker(project, "chrome");

    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it("finds, updates and removes a marker an older server wrote under another name, and its sidecars with it", () => {
    const { dir, project, named } = sessionDir();
    const older = "0123456789abcdef";
    fs.writeFileSync(path.join(dir, `${older}.json`), JSON.stringify({ projectPath: project, browser: "chrome", pid: 4242 }));
    fs.writeFileSync(path.join(dir, `${older}.idle.json`), "{}");
    fs.writeFileSync(path.join(dir, "fedcba9876543210.json"), JSON.stringify({ projectPath: project, browser: "firefox", pid: 4343 }));
    fs.writeFileSync(path.join(dir, "torn000000000000.json"), "{");

    expect(sessionMarkerPath(project, "chrome")).toBe(path.join(dir, `${older}.json`));
    expect(sessionSidecarPath(project, "chrome", "idle")).toBe(path.join(dir, `${older}.idle.json`));
    expect(sessionMarkerPath(project, "edge")).not.toContain(older);

    recordContractPids(project, "chrome", { browserPid: 777 });

    expect(JSON.parse(fs.readFileSync(path.join(dir, `${older}.json`), "utf8"))).toMatchObject({ pid: 4242, browserPid: 777 });

    removeSessionMarker(project, "chrome");

    expect(fs.readdirSync(dir).sort()).toEqual(["fedcba9876543210.json", "torn000000000000.json"]);
    expect(sessionMarkerPath(project, "chrome")).toBe(path.join(dir, `${named}.json`));
  });
});

describe("a missing directory means none yet only when the nearest existing ancestor is a directory, so a path through a file is unreadable rather than empty", () => {
  it("answers none yet for a path whose parents are directories", () => {
    expect(directoryNotCreatedYet(path.join(scratch(), "sessions", "chrome"))).toBe(true);
  });

  it("answers no for a directory that exists", () => {
    expect(directoryNotCreatedYet(scratch())).toBe(false);
  });

  it("answers no for a path that runs through a file", () => {
    const dir = scratch();
    fs.writeFileSync(path.join(dir, "sessions"), "not a directory");

    expect(directoryNotCreatedYet(path.join(dir, "sessions", "chrome"))).toBe(false);
  });
});
