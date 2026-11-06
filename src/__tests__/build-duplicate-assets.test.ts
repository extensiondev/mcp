import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, it, expect, afterEach, vi } from "vitest";

import type * as ExecModule from "../lib/exec";

const cliCalls: string[][] = [];
let onDist: ((distDir: string) => void) | null = null;
vi.mock("../lib/exec", async (importOriginal) => {
  const actual = await importOriginal<typeof ExecModule>();

  return {
    ...actual,
    runExtensionCli: async (args: string[]) => {
      cliCalls.push(args);
      const browser = browserFromCliArgs(args);
      const answer = buildCliAnswer(args[1]!, browser);
      writeEngineDist(args[1]!, browser);
      onDist?.(path.join(args[1]!, "dist", browser));

      return answer;
    },
  };
});

const build = await import("../tools/build");
const analyze = await import("../tools/analyze");
const { buildCliAnswer, browserFromCliArgs, writeEngineDist } = await import("./fixtures/engine-answers");
const { findDuplicateAssets, DUPLICATE_ASSET_FLOOR } = await import("../lib/duplicate-assets");

const tmpDirs: string[] = [];

function project(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-build-dupes-"));
  tmpDirs.push(dir);
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src", "manifest.json"), JSON.stringify({ manifest_version: 3, name: "Fixture", version: "1.0.0" }));

  return dir;
}

function blob(seed: string, bytes: number): Buffer {
  return Buffer.alloc(bytes, seed);
}

function write(root: string, rel: string, body: Buffer | string): void {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), body);
}

afterEach(() => {
  cliCalls.length = 0;
  onDist = null;
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const BIG = 300 * 1024;

describe("422: a build that ships the same bytes twice says so, and the large files are listed inline", () => {
  it("extension_build warns with both paths and the size, lists the pair in value.duplicateFiles and marks it in value.largestFiles", async () => {
    const dir = project();

    onDist = (distDir) => {
      write(distDir, "assets/ort-wasm-simd-threaded.dceeca2a.wasm", blob("w", BIG));
      write(distDir, "ort/ort-wasm-simd-threaded.wasm", blob("w", BIG));
      write(distDir, "assets/other.wasm", blob("o", BIG));
    };

    const result = JSON.parse(await build.handler({ projectPath: dir }));

    expect(result.ok).toBe(true);
    expect(result.value.duplicateFiles).toHaveLength(1);
    expect(result.value.duplicateFiles[0].paths).toEqual(["assets/ort-wasm-simd-threaded.dceeca2a.wasm", "ort/ort-wasm-simd-threaded.wasm"]);
    expect(result.value.duplicateFiles[0].size).toBe(BIG);
    expect(result.value.largestFiles.find((f: { path: string }) => f.path === "ort/ort-wasm-simd-threaded.wasm").duplicateOf).toBe("assets/ort-wasm-simd-threaded.dceeca2a.wasm");
    const warning = result.warnings.find((w: string) => w.includes("the same"));
    expect(warning).toContain("ort/ort-wasm-simd-threaded.wasm is the same 300.0 KB as assets/ort-wasm-simd-threaded.dceeca2a.wasm");
    expect(warning).toContain("2 times");
    expect(warning).toContain("drop that one");
  });

  it("lists value.largestFiles inline when one asset is over 5 MiB, and leaves it out of a small clean build", async () => {
    const big = project();
    onDist = (distDir) => write(distDir, "model.wasm", blob("m", 6 * 1024 * 1024));

    const large = JSON.parse(await build.handler({ projectPath: big }));

    expect(large.value.largestFiles[0]).toMatchObject({ path: "model.wasm", sizeFormatted: "6.0 MB" });
    expect(large.value.duplicateFiles).toBeUndefined();

    const small = project();
    onDist = null;

    const plain = JSON.parse(await build.handler({ projectPath: small }));

    expect(plain.value.largestFiles).toBeUndefined();
    expect(plain.warnings.join(" ")).not.toContain("the same");
  });

  it("extension_analyze marks the duplicate in largestFiles, lists duplicateFiles and warns once per pair", async () => {
    const dir = project();
    const distDir = path.join(dir, "dist", "chrome");
    write(distDir, "manifest.json", JSON.stringify({ manifest_version: 3, name: "Fixture", version: "1.0.0" }));
    write(distDir, "assets/big.1a2b3c4d.wasm", blob("w", BIG));
    write(distDir, "public/big.wasm", blob("w", BIG));

    const result = JSON.parse(await analyze.handler({ projectPath: dir, browser: "chrome" }));

    expect(result.ok).toBe(true);
    expect(result.value.duplicateFiles).toHaveLength(1);
    expect(result.value.largestFiles.find((f: { path: string }) => f.path === "public/big.wasm").duplicateOf).toBe("assets/big.1a2b3c4d.wasm");
    expect(result.warnings.filter((w: string) => w.includes("the same"))).toHaveLength(1);
  });

  it("hashes only files at or above the floor and never calls two different files of one size a pair", () => {
    const dir = project();
    write(dir, "a.bin", blob("a", DUPLICATE_ASSET_FLOOR));
    write(dir, "b.bin", blob("b", DUPLICATE_ASSET_FLOOR));
    write(dir, "c.bin", blob("c", 1024));
    write(dir, "d.bin", blob("c", 1024));

    const files = ["a.bin", "b.bin", "c.bin", "d.bin"].map((p) => ({ path: p, size: fs.statSync(path.join(dir, p)).size }));

    expect(findDuplicateAssets(dir, files)).toEqual([]);
  });
});
