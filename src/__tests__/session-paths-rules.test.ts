import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

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

describe("a spec file's temp folders", () => {
  it("are gone once the file finishes, whether its cells pass or fail", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-temp-sweep-"));
    made.push(dir);
    const record = path.join(dir, "made.txt");
    fs.mkdirSync(path.join(dir, "src"));

    for (const [name, end] of [["passes", ""], ["fails", "expect(1).toBe(2);"]]) {
      fs.writeFileSync(
        path.join(dir, "src", `${name}.test.ts`),
        [
          'import fs from "node:fs";',
          'import os from "node:os";',
          'import path from "node:path";',
          'import { expect, it } from "vitest";',
          'it("makes temp folders", () => {',
          '  const made = [fs.mkdtempSync(path.join(os.tmpdir(), "mcp-fake-cli-")), process.env.EXTENSION_MCP_SESSION_DIR];',
          `  fs.appendFileSync(${JSON.stringify(record)}, made.join("\\n") + "\\n");`,
          `  ${end}`,
          "});",
        ].join("\n"),
      );
    }

    const root = fileURLToPath(new URL("../..", import.meta.url));
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("VITEST")));

    const run = spawnSync(
      process.execPath,
      [path.join(root, "node_modules/vitest/vitest.mjs"), "run", "--dir", dir],
      { cwd: root, env, encoding: "utf8" },
    );

    expect(run.status, run.stdout + run.stderr).toBe(1);
    const left = fs.readFileSync(record, "utf8").split("\n").filter(Boolean);
    expect(left).toHaveLength(4);
    expect(left.filter((folder) => fs.existsSync(folder))).toEqual([]);
  }, 60_000);
});
