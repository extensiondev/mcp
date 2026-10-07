import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { renderReadmeSetup, spliceReadmeSetup } from "../clients/readme";

const readmePath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "README.md",
);

describe("the README setup is generated from src/clients", () => {
  it("matches the recipes (run pnpm readme:clients to regenerate)", () => {
    const readme = fs.readFileSync(readmePath, "utf8");
    const current = spliceReadmeSetup(readme);

    if (process.env.UPDATE_README === "1") {
      fs.writeFileSync(readmePath, current);

      return;
    }

    expect(readme).toBe(current);
  });

  it("never tells anyone to turn approvals off", () => {
    expect(renderReadmeSetup()).not.toMatch(/APPROVAL_GATE=0/);
  });
});
