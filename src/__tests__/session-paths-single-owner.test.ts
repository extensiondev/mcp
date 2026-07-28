import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const OWNER = path.join(SRC, "lib", "session-paths.ts");

/* @invariant Empty, and it stays empty. It held tools/build.ts while that file was being
   rewritten by another author; build.ts now calls buildSummaryPath like every
   other reader, so there is nothing left to excuse. An entry here is a file
   allowed to rebuild the session layout by hand, which is the thing this test
   exists to prevent, so adding one needs a reason that outlives the next
   engine layout change. */
const NOT_YET_MIGRATED = new Set<string>([]);

function productionFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__" || entry.name === "vendor") continue;
      productionFiles(full, out);
      continue;
    }
    if (!entry.name.endsWith(".ts")) continue;
    if (full === OWNER) continue;
    out.push(full);
  }
  return out;
}

/* @invariant The engine's own layout spec fails any path join that bypasses its
   session-paths module. This is the same guard on this side of the wire: the
   hand-built dist/extension-js/<browser>/... joins are gone, and this test is
   what stops the next one from appearing. It deliberately does NOT flag
   ~/.cache/extension-js, which is the template cache and not session state. */
describe("only lib/session-paths.ts knows the session-state layout", () => {
  const files = productionFiles(SRC);
  const scanned = files.filter((file) => !NOT_YET_MIGRATED.has(file));

  it("finds production sources to scan", () => {
    expect(scanned.length).toBeGreaterThan(30);
  });

  /* @invariant Only the path-join form is an offence. Prose that NAMES dist/extension-js
     in a tool description or an error message is the opposite of the problem:
     telling the caller which path was read is exactly how a layout mismatch
     stops being silent. */
  it("has no production file rebuilding the dist/extension-js root by hand", () => {
    const joined = /["']dist["']\s*,\s*["']extension-js["']/;
    const offenders = scanned.filter((file) => {
      const source = fs
        .readFileSync(file, "utf8")
        .split("\n")
        .filter((line) => !line.trimStart().startsWith("//"))
        .join("\n");
      return joined.test(source);
    });
    expect(offenders.map((f) => path.relative(SRC, f))).toEqual([]);
  });

  it("has no production file naming a session artifact file by hand", () => {
    const artifacts = [
      "ready.json",
      "logs.ndjson",
      "events.ndjson",
      "actions.ndjson",
      "build-summary.json",
    ];
    const offenders: string[] = [];
    for (const file of scanned) {
      const source = fs.readFileSync(file, "utf8");
      for (const [index, line] of source.split("\n").entries()) {
        for (const artifact of artifacts) {
          if (!line.includes(`"${artifact}"`)) continue;
          offenders.push(
            `${path.relative(SRC, file)}:${index + 1}: ${line.trim()}`,
          );
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("scans every production file, with nothing held back", () => {
    expect(NOT_YET_MIGRATED.size).toBe(0);
    expect(scanned).toEqual(files);
  });

  it("has build.ts reading the build summary through the owner module", () => {
    const source = fs.readFileSync(
      path.join(SRC, "tools", "build.ts"),
      "utf8",
    );
    expect(source).toContain("buildSummaryPath(projectPath, browser)");
    expect(source).toContain('from "../lib/session-paths"');
  });
});
