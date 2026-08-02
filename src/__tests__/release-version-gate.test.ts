import { describe, expect, it } from "vitest";
import fs from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

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
