import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import { STORE_MD_FILENAME, parseStoreMd, type StoreMdData } from "../lib/store-md";
import { storeMdWarnings } from "../tools/submit";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(here, "fixtures", "store-md");
const pinFile = path.join(here, "fixtures", "store-md.pin.json");

interface Pin {
  upstreamPackage: string;
  upstreamPath: string;
  upstreamSha256: string;
  fixtureCount: number;
  expected: Record<string, StoreMdData>;
}

const pin: Pin = JSON.parse(fs.readFileSync(pinFile, "utf8"));

const fixtures = fs
  .readdirSync(fixturesDir)
  .filter((name) => name.endsWith(".md"))
  .sort();

const read = (name: string): string =>
  fs.readFileSync(path.join(fixturesDir, name), "utf8");

const UPSTREAM_SUBMODULE = "packages/extensiondev-deploy";

const findDeclaringRoot = (): string | null => {
  const packageRoot = path.resolve(here, "..", "..");

  for (let dir = path.dirname(packageRoot); ; dir = path.dirname(dir)) {
    const modules = path.join(dir, ".gitmodules");

    if (
      fs.existsSync(modules) &&
      fs.readFileSync(modules, "utf8").includes(`path = ${UPSTREAM_SUBMODULE}`)
    ) {
      return dir;
    }

    if (dir === path.parse(dir).root) return null;
  }
};

const monorepoRoot = findDeclaringRoot();
const upstreamFile = monorepoRoot
  ? path.join(monorepoRoot, UPSTREAM_SUBMODULE, pin.upstreamPath)
  : null;

describe("STORE.md contract corpus, where an upstream declared in .gitmodules and absent is a failure, never a skip", () => {
  it("holds every fixture the pin was generated over", () => {
    expect(fixtures).toHaveLength(pin.fixtureCount);
    expect(fixtures.length).toBeGreaterThan(0);
    expect(Object.keys(pin.expected).sort()).toEqual(fixtures);
  });

  it.each(fixtures)("this package parses %s exactly as the pin", (name) => {
    expect(parseStoreMd(read(name))).toEqual(pin.expected[name]);
  });

  it.each(fixtures)(
    "the submit advisory for %s follows the pin, never its own reading",
    (name) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "extdev-storemd-pin-"));

      try {
        fs.writeFileSync(path.join(dir, STORE_MD_FILENAME), read(name));
        const warnings = storeMdWarnings(["firefox", "edge"], dir);
        const expected = pin.expected[name]!;
        expect(
          warnings.some((w) => w.includes("no Firefox reviewer notes")),
        ).toBe(!expected.firefox?.approvalNotes);

        expect(
          warnings.some((w) => w.includes("no Edge certification notes")),
        ).toBe(!expected.edge?.certificationNotes);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});

describe("STORE.md contract against the platform parser", () => {
  it("resolves the upstream file whenever this is a monorepo checkout", () => {
    if (!monorepoRoot) {
      expect(pin.fixtureCount).toBeGreaterThan(0);
      expect(Object.keys(pin.expected)).toHaveLength(pin.fixtureCount);

      return;
    }

    expect(
      fs.existsSync(upstreamFile!),
      `${upstreamFile} is missing. This checkout declares ${UPSTREAM_SUBMODULE}, so ${pin.upstreamPackage} must be checked out for the STORE.md contract to mean anything; run git submodule update --init ${UPSTREAM_SUBMODULE}.`,
    ).toBe(true);
  });

  it("pins the upstream parser's bytes", () => {
    if (!monorepoRoot) return;

    const sha = createHash("sha256")
      .update(fs.readFileSync(upstreamFile!))
      .digest("hex");
    expect(
      sha,
      `${pin.upstreamPackage}/${pin.upstreamPath} changed. Re-read it, re-port src/lib/store-md.ts, regenerate src/__tests__/fixtures/store-md.pin.json from the upstream parser, and only then update this hash.`,
    ).toBe(pin.upstreamSha256);
  });

  it("agrees with the upstream parser on every fixture", async () => {
    if (!monorepoRoot) return;

    const upstream = (await import(
      /* @vite-ignore */ pathToFileURL(upstreamFile!).href
    )) as { parseStoreMd: (content: string) => StoreMdData };

    for (const name of fixtures) {
      const content = read(name);
      expect(upstream.parseStoreMd(content), name).toEqual(pin.expected[name]);
      expect(parseStoreMd(content), name).toEqual(
        upstream.parseStoreMd(content),
      );
    }
  });
});
