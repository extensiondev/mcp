import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { refusedTheOutputFlag } from "../lib/engine-version";

const source = fs.readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../lib/engine-version.ts"),
  "utf8",
);

describe("the invocation cache key separator is written as an escape, never as a raw NUL byte, so git keeps showing the file as text", () => {
  it("holds no raw NUL byte anywhere in the module", () => {
    expect(source.includes("\u0000")).toBe(false);
  });

  it("joins the command and its prefix arguments with the escaped NUL", () => {
    expect(source).toContain('join("\\0")');
  });
});

describe("the engine's refusal of --output json is recognised in both of its phrasings and never in a real failure", () => {
  it("matches commander's lowercase refusal", () => {
    expect(refusedTheOutputFlag("error: unknown option '--output'")).toBe(true);
  });

  it("matches the redesigned styled refusal", () => {
    expect(refusedTheOutputFlag("⏵⏵⏵ Unknown option --output.\nRun extension build --help to see the options.")).toBe(true);
  });

  it("leaves a failure that merely mentions an output path alone", () => {
    expect(refusedTheOutputFlag("error: the build failed, --output-dir dist is not writable")).toBe(false);
  });
});
