import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { directoryNotCreatedYet } from "../lib/process-manager";

const made: string[] = [];

afterEach(() => {
  for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function scratch(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-not-yet-"));
  made.push(dir);

  return dir;
}

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
