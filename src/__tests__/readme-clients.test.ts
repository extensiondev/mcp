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

  it("gives one install command, with -y, and one-click badges for Cursor and VS Code", () => {
    const setup = renderReadmeSetup();
    expect(setup.match(/```bash/g)).toHaveLength(1);
    expect(setup).toContain("claude mcp add extension-dev -- npx -y @extension.dev/mcp --features=local,platform");
    expect(setup).toContain('"args": [\n        "-y",\n        "@extension.dev/mcp",');
    expect(setup).toContain("/plugin marketplace add extensiondev/skill\n/plugin install extension-dev@extensiondev");
    expect(setup).toContain("](https://cursor.com/en/install-mcp?name=extension-dev&config=");
    expect(setup).toContain("](https://insiders.vscode.dev/redirect?url=vscode%3Amcp%2Finstall%3F%7B%22name%22%3A%22extension-dev%22");
  });
});
