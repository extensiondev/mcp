import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { PINNED_COMMIT } from "../lib/template-artifact-source";

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(here, "..", "..");

const THIS_SUBMODULE = "packages/public-extensiondev-mcp";

const SHA_PATTERN = /\b[0-9a-f]{40}\b/g;
const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mjs", ".js"];

const SCANNED_ROOTS = [
  "apps/web/code.extension.dev/src",
  "apps/web/templates.extension.dev/build-scripts",
  "packages/public-extensiondev-mcp/src/lib",
];

const DECLARED_SOURCES = [
  "apps/web/code.extension.dev/src/generate/template-artifact-source.ts",
  "apps/web/templates.extension.dev/build-scripts/assert-template-fidelity.mjs",
  "apps/web/templates.extension.dev/build-scripts/fetch-examples-data.mjs",
  "packages/public-extensiondev-mcp/src/lib/template-artifact-source.ts",
].sort();

const DECLARED_JSON: Array<{ file: string; field: string }> = [
  {
    file: "apps/web/templates.extension.dev/build-scripts/public-corpus-manifest.json",
    field: "ref",
  },
];

const CATALOG_POINTER_FILE =
  "apps/web/templates.extension.dev/build-scripts/templates-catalog.pinned.json";

const LIVE_CATALOG_POINTER =
  "https://registry.extension.land/extension-dev/catalog/latest.json";

const declaresSubmodule = (dir: string, submodule: string): boolean => {
  const modules = path.join(dir, ".gitmodules");

  return (
    fs.existsSync(modules) &&
    fs.readFileSync(modules, "utf8").includes(`path = ${submodule}`)
  );
};

const findDeclaringRoot = (): string | null => {
  for (let dir = path.dirname(packageRoot); ; dir = path.dirname(dir)) {
    if (declaresSubmodule(dir, THIS_SUBMODULE)) return dir;
    if (dir === path.parse(dir).root) return null;
  }
};

const monorepoRoot = findDeclaringRoot();

const SOURCES_OUTSIDE_THIS_SUBMODULE = DECLARED_SOURCES.filter(
  (relative) => !relative.startsWith(`${THIS_SUBMODULE}/`),
).length;

const isSourceFile = (name: string): boolean =>
  SOURCE_EXTENSIONS.some((ext) => name.endsWith(ext)) &&
  !name.includes(".spec.") &&
  !name.includes(".test.");

const walk = (dir: string, found: string[]): void => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;

    const full = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      if (entry.name === "__tests__" || entry.name === "__spec__") continue;

      walk(full, found);
      continue;
    }

    if (entry.isFile() && isSourceFile(entry.name)) found.push(full);
  }
};

const shasIn = (file: string): string[] =>
  fs.readFileSync(file, "utf8").match(SHA_PATTERN) ?? [];

const sweepDeclarations = (root: string): Map<string, string[]> => {
  const carriers = new Map<string, string[]>();

  for (const scanned of SCANNED_ROOTS) {
    const dir = path.join(root, scanned);
    if (!fs.existsSync(dir)) continue;

    const files: string[] = [];
    walk(dir, files);

    for (const file of files) {
      const shas = shasIn(file);

      if (shas.length > 0) {
        carriers.set(path.relative(root, file).split(path.sep).join("/"), shas);
      }
    }
  }

  return carriers;
};

describe("the corpus pin floor is non-degenerate, and every copy of it agrees with the catalog pointer", () => {
  it("reads as a full commit sha, never a branch name or a stub", () => {
    expect(PINNED_COMMIT).toMatch(/^[0-9a-f]{40}$/);
  });
});

describe("the corpus pin agrees across every declaration", () => {
  it("compares enough sites that a partial checkout cannot hollow it out", () => {
    if (!monorepoRoot) {
      expect(DECLARED_SOURCES.length).toBeGreaterThan(1);

      return;
    }

    expect(SOURCES_OUTSIDE_THIS_SUBMODULE).toBeGreaterThanOrEqual(3);
    expect(
      DECLARED_SOURCES.length,
      "Every declared source has to be compared, plus this package's own.",
    ).toBeGreaterThanOrEqual(SOURCES_OUTSIDE_THIS_SUBMODULE + 1);
  });

  it("finds every declared source the checkout contains", () => {
    if (!monorepoRoot) return;

    for (const relative of DECLARED_SOURCES) {
      const file = path.join(monorepoRoot, relative);
      expect(
        fs.existsSync(file),
        `${relative} is declared as a corpus pin site and is missing from the tree. If it moved, move this declaration with it.`,
      ).toBe(true);
    }
  });

  it("discovers no pin site that nobody declared", () => {
    if (!monorepoRoot) return;

    const swept = [...sweepDeclarations(monorepoRoot).keys()].sort();
    expect(
      swept,
      "A file under the scanned roots carries a 40-character commit sha and is not a declared pin site. Advancing the corpus has to move every one of these together, so declare it here or stop hardcoding the sha there.",
    ).toEqual(DECLARED_SOURCES);
  });

  it("reads exactly one sha, and the same one, from every source", () => {
    if (!monorepoRoot) return;

    const swept = sweepDeclarations(monorepoRoot);
    expect(swept.size).toBe(DECLARED_SOURCES.length);

    for (const [relative, shas] of swept) {
      expect(
        new Set(shas).size,
        `${relative} carries ${shas.length} distinct shas`,
      ).toBe(1);

      expect(
        shas[0],
        `${relative} pins ${shas[0]} while this package pins ${PINNED_COMMIT}. Advancing the corpus is one change across every declaration, and a surface left behind serves the icons and metadata of a corpus the others have moved past.`,
      ).toBe(PINNED_COMMIT);
    }
  });

  it("reads the same sha from every declared json field", () => {
    if (!monorepoRoot) return;

    for (const { file, field } of DECLARED_JSON) {
      const full = path.join(monorepoRoot, file);
      expect(fs.existsSync(full), `${file} is missing`).toBe(true);
      const value = JSON.parse(fs.readFileSync(full, "utf8"))[field];
      expect(value, `${file} has no ${field}`).toMatch(/^[0-9a-f]{40}$/);
      expect(
        value,
        `${file} pins ${value} at .${field} while this package pins ${PINNED_COMMIT}.`,
      ).toBe(PINNED_COMMIT);
    }
  });

  /* @invariant
   * THE POINTER THE TEMPLATES APP COMMITS IS THE CHANNEL AT RUNTIME.
   *
   * Both runtime readers, the code app and this server, resolve the registry
   * channel pointer first and refuse any commit but the pin, so a pin that
   * disagrees with the published pointer is the value users get only when the
   * registry is unreachable. The templates app commits the pointer it
   * publishes; until that file lands, the live channel is read instead, and a
   * checkout with no network skips rather than passing on nothing.
   */
  it("agrees with the catalog pointer the templates app publishes", async (ctx) => {
    if (!monorepoRoot) return;

    const committed = path.join(monorepoRoot, CATALOG_POINTER_FILE);

    if (fs.existsSync(committed)) {
      const pinned = JSON.parse(fs.readFileSync(committed, "utf8")) as {
        commit?: string;
        catalog?: string;
        source?: { commit?: string };
      };
      expect(
        pinned.source?.commit ?? pinned.commit,
        `${CATALOG_POINTER_FILE} is the catalog both runtime readers resolve first, so a floor that disagrees with it is the value users get only when the registry is unreachable.`,
      ).toBe(PINNED_COMMIT);

      if (pinned.catalog) {
        expect(pinned.catalog, `${CATALOG_POINTER_FILE}.catalog`).toContain(PINNED_COMMIT);
      }

      return;
    }

    let pointer: { commit?: string; catalog?: string };

    try {
      const response = await fetch(LIVE_CATALOG_POINTER, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(8000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      pointer = (await response.json()) as { commit?: string; catalog?: string };
    } catch (error) {
      ctx.skip(
        `${CATALOG_POINTER_FILE} is not committed yet and ${LIVE_CATALOG_POINTER} could not be read (${error instanceof Error ? error.message : String(error)}).`,
      );

      return;
    }

    expect(
      pointer.commit,
      `${LIVE_CATALOG_POINTER} publishes ${pointer.commit} while this package pins ${PINNED_COMMIT}.`,
    ).toBe(PINNED_COMMIT);

    expect(pointer.catalog, `${LIVE_CATALOG_POINTER}.catalog`).toContain(PINNED_COMMIT);
  });
});
