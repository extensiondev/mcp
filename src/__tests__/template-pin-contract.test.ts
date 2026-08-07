import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { PINNED_COMMIT } from "../lib/template-artifact-source";

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(here, "..", "..");

/* @invariant THE CORPUS PIN CANNOT HAVE ONE OWNER, AND IT ALREADY DOES.
 *
 * At RUNTIME the pin has exactly one owner and it is the channel pointer,
 * media.extension.land/templates/latest.json. Both readers of the corpus
 * resolve it first and reach their own PINNED_COMMIT only when that fetch
 * fails, so the constant is a FLOOR, not the pin.
 *
 * The floor is the part that cannot be shared. This package is published to
 * npm and cannot depend on a private one under C11, and more decisively an
 * installed copy of it carries whatever bytes were baked at publish time, so
 * no module in the monorepo can reach it at runtime whatever the boundary
 * allowed. A shared constant would ship a stale floor to every user who
 * installed before the corpus moved, which is the same drift with one more
 * indirection.
 *
 * So the five source declarations stay five and are held together HERE, by a
 * test that fails when any of them disagrees with any other or with the
 * committed channel pointer. Discovery is by SWEEP rather than by list: a
 * sixth copy appearing anywhere under the scanned roots fails this test until
 * somebody declares it, because the defect being prevented is a new owner, not
 * a wrong value in a known one.
 *
 * The monorepo is detected by the .gitmodules that DECLARES this package and
 * never by a scanned file's presence. Declared and absent is a FAILURE naming
 * the missing checkout; an ancestor that declares nothing is the standalone
 * package repo, where the floor is asserted non-degenerate instead of quietly
 * waved through.
 *
 * The one skip this contract allows is a submodule that is declared and left
 * UNINITIALISED, which CI does on purpose per job and which reads on disk as
 * an empty directory rather than a missing one. That skip cannot hollow the
 * test out: every site outside a submodule is compared unconditionally, the
 * count of compared sources is asserted against a floor, and a file missing
 * from a tree that IS checked out still fails. So the worst a partial checkout
 * can do is compare fewer sites, never zero, and never silently.
 */
const THIS_SUBMODULE = "packages/public-extensiondev-mcp";
const MEDIA_SUBMODULE = "apps/workers/media.extension.land";

const SHA_PATTERN = /\b[0-9a-f]{40}\b/g;
const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mjs", ".js"];

const SCANNED_ROOTS = [
  "apps/web/code.extension.dev/src",
  "apps/web/templates.extension.dev/build-scripts",
  "apps/workers/media.extension.land/scripts",
  "packages/public-extensiondev-mcp/src/lib",
];

const DECLARED_SOURCES = [
  "apps/web/code.extension.dev/src/generate/template-artifact-source.ts",
  "apps/web/templates.extension.dev/build-scripts/assert-template-fidelity.mjs",
  "apps/web/templates.extension.dev/build-scripts/fetch-examples-data.mjs",
  "apps/workers/media.extension.land/scripts/build-templates-artifact.mjs",
  "packages/public-extensiondev-mcp/src/lib/template-artifact-source.ts",
].sort();

const DECLARED_JSON: Array<{ file: string; field: string }> = [
  {
    file: "apps/web/templates.extension.dev/build-scripts/public-corpus-manifest.json",
    field: "ref",
  },
  {
    file: "apps/workers/media.extension.land/public/templates/latest.json",
    field: "commit",
  },
];

const CHANNEL_POINTER =
  "apps/workers/media.extension.land/public/templates/latest.json";

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

const submoduleIsCheckedOut = (root: string, submodule: string): boolean => {
  const dir = path.join(root, submodule);
  return fs.existsSync(dir) && fs.readdirSync(dir).length > 0;
};

const mediaCheckedOut = monorepoRoot
  ? submoduleIsCheckedOut(monorepoRoot, MEDIA_SUBMODULE)
  : false;

const inUninitialisedSubmodule = (relative: string): boolean =>
  !mediaCheckedOut && relative.startsWith(`${MEDIA_SUBMODULE}/`);

const REACHABLE_SOURCES = DECLARED_SOURCES.filter(
  (relative) => !inUninitialisedSubmodule(relative),
);

const SOURCES_OUTSIDE_ANY_SUBMODULE = DECLARED_SOURCES.filter(
  (relative) =>
    !relative.startsWith(`${MEDIA_SUBMODULE}/`) &&
    !relative.startsWith(`${THIS_SUBMODULE}/`),
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

describe("the corpus pin floor is non-degenerate", () => {
  it("reads as a full commit sha, never a branch name or a stub", () => {
    expect(PINNED_COMMIT).toMatch(/^[0-9a-f]{40}$/);
  });
});

describe("the corpus pin agrees across every declaration", () => {
  it("resolves a monorepo checkout or names itself standalone", () => {
    if (!monorepoRoot) {
      expect(DECLARED_SOURCES.length).toBeGreaterThan(1);
      return;
    }
    expect(
      declaresSubmodule(monorepoRoot, MEDIA_SUBMODULE),
      `${monorepoRoot}/.gitmodules stopped declaring ${MEDIA_SUBMODULE}, so the channel pointer this contract compares against can no longer be located. Re-point CHANNEL_POINTER before trusting a green here.`,
    ).toBe(true);
  });

  it("compares enough sites that a partial checkout cannot hollow it out", () => {
    if (!monorepoRoot) return;
    expect(SOURCES_OUTSIDE_ANY_SUBMODULE).toBeGreaterThanOrEqual(3);
    expect(
      REACHABLE_SOURCES.length,
      "Every declared source outside an uninitialised submodule has to be compared, plus this package's own.",
    ).toBeGreaterThanOrEqual(SOURCES_OUTSIDE_ANY_SUBMODULE + 1);
  });

  it("finds every declared source the checkout contains", () => {
    if (!monorepoRoot) return;
    for (const relative of REACHABLE_SOURCES) {
      const file = path.join(monorepoRoot, relative);
      expect(
        fs.existsSync(file),
        `${relative} is declared as a corpus pin site and is missing from a tree that IS checked out. If it moved, move this declaration with it.`,
      ).toBe(true);
    }
  });

  it("discovers no pin site that nobody declared", () => {
    if (!monorepoRoot) return;
    const swept = [...sweepDeclarations(monorepoRoot).keys()].sort();
    expect(
      swept,
      "A file under the scanned roots carries a 40-character commit sha and is not a declared pin site. Advancing the corpus has to move every one of these together, so declare it here or stop hardcoding the sha there.",
    ).toEqual(REACHABLE_SOURCES);
  });

  it("reads exactly one sha, and the same one, from every source", () => {
    if (!monorepoRoot) return;
    const swept = sweepDeclarations(monorepoRoot);
    expect(swept.size).toBe(REACHABLE_SOURCES.length);
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
    let compared = 0;
    for (const { file, field } of DECLARED_JSON) {
      if (inUninitialisedSubmodule(file)) continue;
      const full = path.join(monorepoRoot, file);
      expect(fs.existsSync(full), `${file} is missing`).toBe(true);
      const value = JSON.parse(fs.readFileSync(full, "utf8"))[field];
      expect(value, `${file} has no ${field}`).toMatch(/^[0-9a-f]{40}$/);
      expect(
        value,
        `${file} pins ${value} at .${field} while this package pins ${PINNED_COMMIT}.`,
      ).toBe(PINNED_COMMIT);
      compared += 1;
    }
    expect(compared).toBeGreaterThanOrEqual(1);
  });

  it("agrees with the channel pointer that owns the pin at runtime", () => {
    if (!monorepoRoot) return;
    if (!mediaCheckedOut) {
      expect(
        inUninitialisedSubmodule(CHANNEL_POINTER),
        `${CHANNEL_POINTER} is unreachable for a reason other than an uninitialised ${MEDIA_SUBMODULE}.`,
      ).toBe(true);
      return;
    }

    const pointer = JSON.parse(
      fs.readFileSync(path.join(monorepoRoot, CHANNEL_POINTER), "utf8"),
    ) as { commit?: string; manifest?: string; meta?: string; files?: string };

    expect(
      pointer.commit,
      `${CHANNEL_POINTER} is what both runtime readers resolve first, so a floor that disagrees with it is the value users get only when media is unreachable.`,
    ).toBe(PINNED_COMMIT);

    for (const key of ["manifest", "meta", "files"] as const) {
      expect(pointer[key], `${CHANNEL_POINTER}.${key}`).toContain(PINNED_COMMIT);
    }
  });
});
