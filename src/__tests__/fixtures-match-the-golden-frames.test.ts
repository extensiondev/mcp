import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { actFailure, buildFrame, doctorFrame, evalFrame, evalRefusal } from "./fixtures/engine-answers";

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

const GOLDEN_WITHOUT_A_BUILDER = [
  "golden.build.compile.json",
  "golden.dev.first-compile.json",
  "golden.dev.ready.json",
];

const builderFor: Record<string, () => Record<string, unknown>> = {
  "golden.build.built.json": () => buildFrame("/tmp/project", ["chrome"]),
  "golden.doctor.healthy.json": () =>
    doctorFrame([{ check: "ready-contract", status: "pass", detail: "ready" }]),
  "golden.doctor.session-not-found.json": () =>
    doctorFrame([
      {
        check: "ready-contract",
        status: "fail",
        detail: "no ready contract",
        remediation: "Start a dev session first",
      },
    ]),
  "golden.eval.ok.json": () => evalFrame(4),
  "golden.eval.eval.json": () =>
    evalRefusal(
      { code: "E_EVAL", message: "ReferenceError: chrom is not defined", name: "EvalError", hint: "The expression threw inside the page." },
      { truncated: true },
    ),
  "golden.eval.csp-blocks-eval.json": () =>
    evalRefusal({ code: "E_CSP_BLOCKS_EVAL", message: "call to eval() blocked by CSP", name: "EvalError", engine: "firefox", hint: "The extension's own content_security_policy forbids eval in this document." }),
  "golden.eval.csp-blocks-eval.page.json": () =>
    evalRefusal({ code: "E_CSP_BLOCKS_EVAL", message: "call to eval() blocked by CSP", name: "EvalError", engine: "firefox", hint: "The page's own Content-Security-Policy forbids eval." }),
  "golden.eval.target-not-found.json": () =>
    evalRefusal({ code: "E_TARGET_NOT_FOUND", message: "the expression never executed in tab 12", name: "TargetNotFound" }),
  "golden.open.headed-window-required.json": () =>
    actFailure("open", {
      name: "Unsupported",
      message: "openPopup: Could not find an active browser window.",
      code: "E_HEADED_WINDOW_REQUIRED",
    }),
};

const goldenFiles = (): string[] =>
  fs.readdirSync(goldenDir).filter((name) => name.startsWith("golden.")).sort();

describe("every golden frame the installed engine ships is compared key for key with a fixture builder, or named as a gap", () => {
  it("ships golden frames to compare against", () => {
    expect(goldenFiles().length).toBeGreaterThan(0);
  });

  it("names every golden file that has no builder, so a new golden file is a red cell", () => {
    const shipped = goldenFiles();
    const uncovered = shipped.filter((name) => !(name in builderFor));
    const expected = GOLDEN_WITHOUT_A_BUILDER
      .filter((name) => shipped.includes(name))
      .sort();

    expect(uncovered).toEqual(expected);
  });

  for (const name of goldenFiles().filter((file) => file in builderFor)) {
    it(`${name.replace(/^golden\.|\.json$/g, "")}: the builder drops no key of the golden envelope or of its value and error`, () => {
      const shipped = golden(name);
      const built = builderFor[name]();
      expect(missingKeys(shipped, built)).toEqual([]);
      expect(missingKeys(shipped.value, built.value)).toEqual([]);
      expect(missingKeys(shipped.error, built.error)).toEqual([]);
      expect(shipped.status).toBe(built.status);
    });
  }
});
