import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { buildFrame, doctorFrame } from "./fixtures/engine-answers";

const goldenDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../node_modules/extension-develop/dist/contract",
);

const golden = (name: string): Record<string, unknown> =>
  JSON.parse(fs.readFileSync(path.join(goldenDir, name), "utf8"));

const keysOf = (value: unknown): string[] =>
  value && typeof value === "object" && !Array.isArray(value)
    ? Object.keys(value as Record<string, unknown>).sort()
    : [];

const missingKeys = (shipped: unknown, built: unknown): string[] =>
  keysOf(shipped).filter((key) => !keysOf(built).includes(key));

describe("every fixture builder with a golden frame in the installed engine carries every key that frame carries", () => {
  it("ships golden frames to compare against", () => {
    expect(fs.existsSync(path.join(goldenDir, "golden.build.built.json"))).toBe(true);
    expect(fs.existsSync(path.join(goldenDir, "golden.doctor.healthy.json"))).toBe(true);
  });

  it("buildFrame drops no key of golden.build.built, on the envelope or on its value", () => {
    const shipped = golden("golden.build.built.json");
    const built = buildFrame("/tmp/project", ["chrome"]);
    expect(missingKeys(shipped, built)).toEqual([]);
    expect(missingKeys(shipped.value, built.value)).toEqual([]);
  });

  it("doctorFrame drops no key of golden.doctor.healthy", () => {
    const shipped = golden("golden.doctor.healthy.json");
    const built = doctorFrame([{ check: "ready-contract", status: "pass", detail: "ready" }]);
    expect(missingKeys(shipped, built)).toEqual([]);
  });
});
