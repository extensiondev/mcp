import { describe, it, expect } from "vitest";
import {
  validateToolInput,
  inputValidationError,
  normalizeArgAliases,
} from "../lib/validate-input";
import { schema as manifestValidateSchema } from "../tools/manifest-validate";
import { schema as devSchema } from "../tools/dev";
import { schema as logsSchema } from "../tools/logs";

describe("validateToolInput", () => {
  it("accepts valid args", () => {
    expect(
      validateToolInput(manifestValidateSchema.inputSchema, {
        manifestPath: "/tmp/manifest.json",
        browsers: ["chrome", "firefox"],
      }),
    ).toEqual([]);
  });

  it("flags a missing required argument", () => {
    const issues = validateToolInput(devSchema.inputSchema, {});
    expect(issues).toHaveLength(1);
    expect(issues[0].path).toBe("projectPath");
    expect(issues[0].message).toContain("required");
  });

  it("flags unknown arguments and names the known ones", () => {
    const issues = validateToolInput(logsSchema.inputSchema, {
      projectPath: "/tmp/x",
      grep: "nope",
    });
    expect(issues).toHaveLength(1);
    expect(issues[0].path).toBe("grep");
    expect(issues[0].message).toContain("unknown argument");
    expect(issues[0].message).toContain("projectPath");
  });

  it("flags wrong primitive types", () => {
    const issues = validateToolInput(devSchema.inputSchema, {
      projectPath: 42,
    });
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain("expected string");
  });

  it("flags enum violations", () => {
    const issues = validateToolInput(devSchema.inputSchema, {
      projectPath: "/tmp/x",
      browser: "netscape",
    });
    expect(issues).toHaveLength(1);
    expect(issues[0].path).toBe("browser");
    expect(issues[0].message).toContain("must be one of");
  });

  it("checks array item types", () => {
    const issues = validateToolInput(manifestValidateSchema.inputSchema, {
      manifestPath: "/tmp/manifest.json",
      browsers: ["chrome", 7],
    });
    expect(issues).toHaveLength(1);
    expect(issues[0].path).toBe("browsers[1]");
  });
});

describe("normalizeArgAliases", () => {
  it("folds a soft alias to the canonical arg when the tool has it", () => {
    // dev has projectPath but not `path`; `path` should become projectPath.
    const out = normalizeArgAliases(devSchema.inputSchema, {
      path: "/tmp/x",
    });
    expect(out.projectPath).toBe("/tmp/x");
    expect(out.path).toBeUndefined();
  });

  it("does not clobber an explicit canonical value", () => {
    const out = normalizeArgAliases(devSchema.inputSchema, {
      projectPath: "/keep",
      path: "/ignore",
    });
    expect(out.projectPath).toBe("/keep");
  });

  it("leaves an alias alone when it is a real arg for that tool", () => {
    // manifest_validate now has both manifestPath and projectPath as real
    // props, so projectPath must NOT be rewritten away.
    const out = normalizeArgAliases(manifestValidateSchema.inputSchema, {
      projectPath: "/tmp/proj",
    });
    expect(out.projectPath).toBe("/tmp/proj");
  });

  it("does not invent an arg the tool does not accept", () => {
    const out = normalizeArgAliases(logsSchema.inputSchema, {
      name: "x",
    });
    // logs has no projectName, so `name` stays as-is (validation will reject it)
    expect(out.name).toBe("x");
    expect(out.projectName).toBeUndefined();
  });
});

describe("inputValidationError", () => {
  it("produces the frozen envelope shape", () => {
    const out = JSON.parse(
      inputValidationError("extension_dev", [
        { path: "projectPath", message: "required argument is missing" },
      ]),
    );
    expect(out.ok).toBe(false);
    expect(out.error.name).toBe("InputValidationError");
    expect(out.error.message).toContain("extension_dev");
    expect(out.error.issues).toHaveLength(1);
  });
});
