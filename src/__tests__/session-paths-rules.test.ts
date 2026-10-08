import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { evalTokenPresent } from "../lib/session-paths";
import { writeEvalToken } from "./fixtures/ready-contract";

const made: string[] = [];

afterEach(() => {
  for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function project(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-eval-gate-"));
  made.push(dir);
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "gate", version: "0.0.0" }));
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ manifest_version: 3, name: "gate", version: "1.0" }));

  return dir;
}

describe("the eval gate on every route is the engine's own token file, written only for a session started with allowEval", () => {
  it("is closed when the engine wrote no token", () => {
    expect(evalTokenPresent(project(), "chrome")).toBe(false);
  });

  it("opens once the engine's token file exists at the root it writes under", () => {
    const dir = project();
    writeEvalToken(dir, "chrome");

    expect(evalTokenPresent(dir, "chrome")).toBe(true);
    expect(evalTokenPresent(dir, "firefox")).toBe(false);
  });
});
