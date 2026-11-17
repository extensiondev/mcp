import { describe, it, expect } from "vitest";

import { tools } from "../index";
import {
  ANNOTATION_KEYWORDS,
  ENFORCED_KEYWORDS,
  ENFORCED_TYPES,
  validateToolInput,
  inputValidationError,
  normalizeArgAliases,
} from "../lib/validate-input";
import { schema as manifestValidateSchema } from "../tools/manifest-validate";
import { schema as createSchema } from "../tools/create";
import { schema as devSchema } from "../tools/dev";
import { schema as logsSchema } from "../tools/logs";
import { schema as submitSchema } from "../tools/submit";
import { schema as releasePromoteSchema } from "../tools/release-promote";
import { schema as authSchema } from "../tools/auth";
import { schema as submitCheckSchema } from "../tools/submit-check";
import { schema as buildsActSchema } from "../tools/builds-act";
import { schema as workspaceSchema } from "../tools/workspace";
import { schema as projectCreateSchema } from "../tools/project-create";
import { schema as themeVerifySchema } from "../tools/theme-verify";
import { schema as evalSchema } from "../tools/eval";
import { schema as docsSearchSchema } from "../tools/docs-search";
import { schema as elementSchema } from "../tools/element";

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

  it("takes the string a property also allows in place of its list, and still checks the list's items", () => {
    expect(validateToolInput(authSchema.inputSchema, { action: "login", workspace: "acme", projects: "*" })).toEqual([]);
    expect(validateToolInput(authSchema.inputSchema, { action: "login", projects: ["acme/a", "acme/b"] })).toEqual([]);

    const wrongItem = validateToolInput(authSchema.inputSchema, { action: "login", projects: ["acme/a", 7] });
    expect(wrongItem).toHaveLength(1);
    expect(wrongItem[0].path).toBe("projects[1]");

    const wrongType = validateToolInput(authSchema.inputSchema, { action: "login", projects: 7 });
    expect(wrongType).toHaveLength(1);
    expect(wrongType[0].message).toContain("expected array or string");
  });

  it("refuses everything but a whole number on an integer argument (ledger 907)", () => {
    for (const schema of [submitSchema, submitCheckSchema]) {
      for (const buildNumber of [true, "12", [12], { n: 12 }, null, 1.5]) {
        const issues = validateToolInput(schema.inputSchema, { browsers: ["safari"], buildNumber });
        expect(issues, `${schema.name} buildNumber ${JSON.stringify(buildNumber)}`).toHaveLength(1);
        expect(issues[0].path).toBe("buildNumber");
        expect(issues[0].message).toContain("expected integer");
      }

      expect(validateToolInput(schema.inputSchema, { browsers: ["safari"], buildNumber: 12 })).toEqual([]);
    }
  });

  it("refuses an array, null or a primitive on an object argument (ledger 907)", () => {
    const cases: Array<[{ name: string; inputSchema: Record<string, unknown> }, string, Record<string, unknown>]> = [
      [submitSchema, "storeSettings", { browsers: ["chrome"] }],
      [submitCheckSchema, "storeSettings", { browsers: ["chrome"] }],
      [buildsActSchema, "buildSettings", { action: "configure" }],
      [workspaceSchema, "settings", { action: "configure-project" }],
      [projectCreateSchema, "outputDirectories", {}],
      [themeVerifySchema, "manifest", {}],
      [evalSchema, "until", { projectPath: "/tmp/x", expression: "1" }],
    ];

    for (const [schema, key, base] of cases) {
      for (const value of [123, "{}", true, [], [{}], null]) {
        const issues = validateToolInput(schema.inputSchema, { ...base, [key]: value });
        expect(issues, `${schema.name} ${key} ${JSON.stringify(value)}`).toHaveLength(1);
        expect(issues[0].path).toBe(key);
        expect(issues[0].message).toContain("expected object");
      }

      expect(validateToolInput(schema.inputSchema, { ...base, [key]: {} }), `${schema.name} ${key} {}`).toEqual([]);
    }
  });

  it("refuses a number outside the schema's minimum and maximum instead of clamping it (ledger 907)", () => {
    const below = validateToolInput(authSchema.inputSchema, { action: "status", waitSeconds: -1 });
    expect(below).toEqual([{ path: "waitSeconds", message: "must be at least 0, got -1" }]);

    const above = validateToolInput(projectCreateSchema.inputSchema, { waitSeconds: 901 });
    expect(above).toEqual([{ path: "waitSeconds", message: "must be at most 900, got 901" }]);

    expect(validateToolInput(docsSearchSchema.inputSchema, { query: "x", limit: 0 })).toEqual([
      { path: "limit", message: "must be at least 1, got 0" },
    ]);

    expect(validateToolInput(docsSearchSchema.inputSchema, { query: "x", limit: 9 })).toEqual([
      { path: "limit", message: "must be at most 8, got 9" },
    ]);

    expect(validateToolInput(submitSchema.inputSchema, { browsers: ["safari"], buildNumber: 0 })).toEqual([
      { path: "buildNumber", message: "must be at least 1, got 0" },
    ]);

    for (const waitSeconds of [0, 900]) {
      expect(validateToolInput(authSchema.inputSchema, { action: "status", waitSeconds })).toEqual([]);
    }

    for (const limit of [1, 8]) {
      expect(validateToolInput(docsSearchSchema.inputSchema, { query: "x", limit })).toEqual([]);
    }
  });

  it("checks what a nested object declares and leaves its undeclared keys alone (ledger 907)", () => {
    const base = { projectPath: "/tmp/x", expression: "1" };

    expect(validateToolInput(evalSchema.inputSchema, { ...base, until: { timeoutMs: "5000" } })).toEqual([
      { path: "until.timeoutMs", message: "expected number, got string" },
    ]);

    expect(validateToolInput(evalSchema.inputSchema, { ...base, until: { timeoutMs: 5000, intervalMs: 250, extra: "kept" } })).toEqual([]);

    expect(validateToolInput(elementSchema.inputSchema, { projectPath: "/tmp/x", action: "move", points: [{ x: 1, y: 2 }, { x: 3 }, 7] })).toEqual([
      { path: "points[1].y", message: "required argument is missing" },
      { path: "points[2]", message: "expected object, got number" },
    ]);

    expect(validateToolInput(submitSchema.inputSchema, { browsers: ["firefox"], storeSettings: { enabled: "yes", releaseChannel: "beta" } })).toEqual([
      { path: "storeSettings.enabled", message: "expected boolean, got string" },
      { path: "storeSettings.releaseChannel", message: "must be one of: listed, unlisted" },
    ]);
  });

  it("enforces every type and range keyword a registered tool schema declares (ledger 907)", () => {
    const known = new Set<string>([...ENFORCED_KEYWORDS, ...ANNOTATION_KEYWORDS]);
    const types = new Set<string>(ENFORCED_TYPES);
    const unenforced: string[] = [];
    let nodes = 0;

    const walk = (at: string, node: unknown): void => {
      if (!node || typeof node !== "object" || Array.isArray(node)) return;

      const schema = node as Record<string, unknown>;
      nodes += 1;

      for (const keyword of Object.keys(schema)) {
        if (!known.has(keyword)) unenforced.push(`${at}: ${keyword}`);
      }

      for (const type of [schema.type ?? []].flat() as string[]) {
        if (!types.has(type)) unenforced.push(`${at}: type ${type}`);
      }

      for (const [key, nested] of Object.entries((schema.properties ?? {}) as Record<string, unknown>)) {
        walk(`${at}.${key}`, nested);
      }

      walk(`${at}[]`, schema.items);
    };

    for (const tool of tools) walk(tool.schema.name, tool.schema.inputSchema);

    expect(tools.length).toBeGreaterThanOrEqual(41);
    expect(nodes).toBeGreaterThan(400);
    expect(unenforced).toEqual([]);

    const probe = {
      type: "object",
      properties: {
        s: { type: "string", enum: ["a"] },
        n: { type: "number", minimum: 1, maximum: 2 },
        i: { type: "integer" },
        b: { type: "boolean" },
        a: { type: "array", items: { type: "integer" } },
        o: { type: "object", properties: { k: { type: "string" } }, required: ["k"] },
      },
      required: ["s"],
    };

    expect(validateToolInput(probe, { s: "a", n: 1.5, i: 3, b: false, a: [1], o: { k: "v" } })).toEqual([]);
    expect(validateToolInput(probe, { n: 3, i: 0.5, b: 0, a: [1.5], o: {} }).map((issue) => issue.path)).toEqual([
      "s",
      "n",
      "i",
      "b",
      "a[0]",
      "o.k",
    ]);

    expect(validateToolInput(probe, { s: "b", n: 0, i: "1", b: "no", a: {}, o: [] }).map((issue) => issue.path)).toEqual([
      "s",
      "n",
      "i",
      "b",
      "a",
      "o",
    ]);
  });
});

describe("normalizeArgAliases", () => {
  it("folds a soft alias to the canonical arg when the tool has it", () => {
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
    const out = normalizeArgAliases(manifestValidateSchema.inputSchema, {
      projectPath: "/tmp/proj",
    });
    expect(out.projectPath).toBe("/tmp/proj");
  });

  it("does not invent an arg the tool does not accept", () => {
    const out = normalizeArgAliases(logsSchema.inputSchema, {
      name: "x",
    });
    expect(out.name).toBe("x");
    expect(out.projectName).toBeUndefined();
  });
});

describe("buildSha/buildId cross-aliases", () => {
  it("submit folds buildId onto buildSha and validates clean", () => {
    const out = normalizeArgAliases(submitSchema.inputSchema, {
      browsers: ["chrome"],
      buildId: "abc1234",
    });
    expect(out.buildSha).toBe("abc1234");
    expect(out.buildId).toBeUndefined();
    expect(validateToolInput(submitSchema.inputSchema, out)).toEqual([]);
  });

  it("promote folds buildSha onto buildId and validates clean", () => {
    const out = normalizeArgAliases(releasePromoteSchema.inputSchema, {
      buildSha: "abc1234",
      channel: "stable",
    });
    expect(out.buildId).toBe("abc1234");
    expect(out.buildSha).toBeUndefined();
    expect(validateToolInput(releasePromoteSchema.inputSchema, out)).toEqual(
      [],
    );
  });

  it("keeps each tool's canonical spelling authoritative", () => {
    const submitOut = normalizeArgAliases(submitSchema.inputSchema, {
      buildSha: "keep111",
      buildId: "ignore2",
    });
    expect(submitOut.buildSha).toBe("keep111");
    const promoteOut = normalizeArgAliases(releasePromoteSchema.inputSchema, {
      buildId: "keep111",
      buildSha: "ignore2",
    });
    expect(promoteOut.buildId).toBe("keep111");
  });

  it("lists the cross-alias in each tool's full-schema validation error", () => {
    const submitErr = JSON.parse(
      inputValidationError(
        "extension_submit",
        [{ path: "buildSha", message: "required argument is missing" }],
        submitSchema.inputSchema,
      ),
    );
    expect(submitErr.value.args.aliases.buildSha).toEqual(["buildId"]);
    expect(submitErr.value.args.aliases.buildId).toBeUndefined();

    const promoteErr = JSON.parse(
      inputValidationError(
        "extension_release_promote",
        [{ path: "buildId", message: "required argument is missing" }],
        releasePromoteSchema.inputSchema,
      ),
    );
    expect(promoteErr.value.args.aliases.buildId).toEqual(["buildSha"]);
    expect(promoteErr.value.args.aliases.buildSha).toBeUndefined();
  });
});

describe("inputValidationError", () => {
  it("produces the frozen envelope shape", () => {
    const out = JSON.parse(
      inputValidationError("extension_dev", [
        { path: "projectPath", message: "required argument is missing" },
      ]),
    );
    expect(out.schema).toBe(1);
    expect(out.ok).toBe(false);
    expect(out.command).toBe("extension_dev");
    expect(out.status).toBe("invalid-arguments");
    expect(out.error.code).toBe("E_INPUT_VALIDATION");
    expect(out.error.name).toBe("InputValidationError");
    expect(out.error.message).toContain("extension_dev");
    expect(out.value.issues).toHaveLength(1);
  });

  it("enumerates the complete arg surface with aliases when given the schema", () => {
    const out = JSON.parse(
      inputValidationError(
        "extension_create",
        [{ path: "projectName", message: "required argument is missing" }],
        createSchema.inputSchema,
      ),
    );
    expect(out.value.args.required).toEqual(["projectName"]);
    expect(out.value.args.optional).toEqual(
      expect.arrayContaining(["parentDir", "template", "install"]),
    );

    expect(out.value.args.aliases.projectName).toEqual(["name"]);
    expect(out.value.args.aliases.parentDir).toEqual(["parent", "into"]);
  });

  it("does not list an alias word the tool owns as a real property", () => {
    const owns = {
      type: "object",
      properties: { timeout: { type: "number" }, timeoutMs: { type: "number" } },
    };
    const out = JSON.parse(
      inputValidationError(
        "extension_probe",
        [{ path: "bogus", message: "unknown argument" }],
        owns,
      ),
    );
    expect(out.value.args.aliases.timeout).toEqual(["timeoutMillis"]);
  });
});
