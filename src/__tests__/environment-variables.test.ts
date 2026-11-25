import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { ENVIRONMENT_VARIABLES, internalVariablesLine, userVariables } from "../lib/environment-variables";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (rel: string) => fs.readFileSync(path.join(root, rel), "utf8");

describe("the environment variables the server reads", () => {
  it("declares every environment variable the source reads in one list, the registry entry, the README and the install file name each one a person sets, and the README names the internal ones (ledger 1144)", () => {
    const files = execFileSync("git", ["ls-files", "--", "src", "bin", "module.ts"], { cwd: root, encoding: "utf8" })
      .split("\n")
      .filter((file) => /\.(ts|js|mjs)$/.test(file) && !file.includes("__tests__") && file !== "src/lib/environment-variables.ts");
    const seen = new Set<string>();

    for (const file of files) {
      const text = fs.readFileSync(path.join(root, file), "utf8");
      for (const match of text.matchAll(/\benv\??\.((?:EXTENSION|EXT)_[A-Z0-9_]+|DO_NOT_TRACK)\b/g)) seen.add(match[1]);
      for (const match of text.matchAll(/["'`]((?:EXTENSION|EXT)_[A-Z0-9_]*[A-Z0-9]|DO_NOT_TRACK)["'`]/g)) seen.add(match[1]);
    }

    const listed = ENVIRONMENT_VARIABLES.map((v) => v.name);

    expect(new Set(listed).size).toBe(listed.length);
    expect([...seen].filter((name) => !listed.includes(name)).sort(), "read in src but not in ENVIRONMENT_VARIABLES").toEqual([]);
    expect(listed.filter((name) => !seen.has(name)).sort(), "listed but read nowhere in src").toEqual([]);

    const readme = read("README.md");
    const flags = readme.slice(readme.indexOf("## Flags"), readme.indexOf("## Tools"));
    const install = read("llms-install.md");

    for (const { name } of userVariables()) {
      expect(flags, name).toContain(`\`${name}`);
      expect(install, name).toContain(`\`${name}`);
    }

    expect(flags).toContain(internalVariablesLine());
  });
});
