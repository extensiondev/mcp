import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

// Regression guard for the @extension.dev/core extraction (MIGRATION.md
// phase 2): the MCP is a protocol adapter and must not re-grow its own
// platform-auth logic. The only auth entry point is @extension.dev/core.

const SRC = path.resolve(__dirname, "..");
const THIS_FILE = path.resolve(__dirname, "core-boundary.test.ts");

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listSourceFiles(full));
    else if (entry.name.endsWith(".ts") && full !== THIS_FILE) out.push(full);
  }
  return out;
}

describe("core boundary (auth lives in @extension.dev/core)", () => {
  const files = listSourceFiles(SRC).map((file) => ({
    file: path.relative(SRC, file),
    text: fs.readFileSync(file, "utf8"),
  }));

  it("has no local lib copies of the platform client", () => {
    for (const name of ["credentials", "github-device", "login-flow"]) {
      expect(
        fs.existsSync(path.join(SRC, "lib", `${name}.ts`)),
        `src/lib/${name}.ts must not exist; it lives in @extension.dev/core`,
      ).toBe(false);
    }
  });

  it("never imports the deleted lib modules", () => {
    const banned = /from\s+["'][^"']*lib\/(credentials|github-device|login-flow)["']/;
    for (const { file, text } of files) {
      expect(banned.test(text), `${file} imports a deleted auth lib module`).toBe(
        false,
      );
    }
  });

  it("never redefines credentialsPath or the credential store", () => {
    const banned =
      /(function|const|let)\s+(credentialsPath|readCredentials|writeCredentials|clearCredentials|readValidCredentials|resolveToken)\b/;
    for (const { file, text } of files) {
      expect(
        banned.test(text),
        `${file} redefines a core auth primitive instead of importing it from @extension.dev/core`,
      ).toBe(false);
    }
  });

  it("imports auth primitives only from @extension.dev/core", () => {
    const authNames =
      /\b(readCredentials|writeCredentials|clearCredentials|readValidCredentials|credentialsPath|resolveToken|safeApiBase|pollForToken|startDeviceCode|exchangeAndPersist|fetchLoginConfig|resolveApiBase)\b/;
    const importLine = /import[\s\S]*?from\s+["']([^"']+)["']/g;
    for (const { file, text } of files) {
      for (const match of text.matchAll(importLine)) {
        if (authNames.test(match[0].replace(/from\s+["'][^"']+["']/, ""))) {
          expect(
            match[1],
            `${file} imports an auth primitive from "${match[1]}"`,
          ).toBe("@extension.dev/core");
        }
      }
    }
  });
});
