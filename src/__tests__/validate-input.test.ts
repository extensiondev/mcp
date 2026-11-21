import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, it, expect } from "vitest";

import { tools } from "../index";
import { createToolDispatcher, type ToolModule } from "../lib/tool-dispatch";
import {
  ANNOTATION_KEYWORDS,
  CONTENT_ARGUMENT_LIMIT,
  ENFORCED_KEYWORDS,
  ENFORCED_TYPES,
  STRING_ARGUMENT_LIMIT,
  validateToolInput,
  inputValidationError,
  normalizeArgAliases,
} from "../lib/validate-input";
import * as buildTool from "../tools/build";
import * as doctorTool from "../tools/doctor";
import * as startTool from "../tools/start";
import * as stopTool from "../tools/stop";
import { schema as manifestValidateSchema } from "../tools/manifest-validate";
import { schema as createSchema } from "../tools/create";
import * as devTool from "../tools/dev";
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
import { schema as approvalsSchema } from "../tools/approvals";

const devSchema = devTool.schema;

const said = (issues: Array<{ path: string; message: string }>) => issues.map(({ path: at, message }) => ({ path: at, message }));

describe("validateToolInput", () => {
  it("accepts valid args", () => {
    expect(
      validateToolInput(manifestValidateSchema.inputSchema, {
        manifestPath: "/tmp/manifest.json",
        browsers: ["chrome", "firefox"],
      }),
    ).toEqual([]);
  });

  it("lets extension_approvals list with no approvalId, which list mode never needs", () => {
    expect(validateToolInput(approvalsSchema.inputSchema, {})).toEqual([]);
    expect(validateToolInput(approvalsSchema.inputSchema, { action: "list" })).toEqual([]);
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
    const below = said(validateToolInput(authSchema.inputSchema, { action: "status", waitSeconds: -1 }));
    expect(below).toEqual([{ path: "waitSeconds", message: "must be at least 0, got -1" }]);

    const above = said(validateToolInput(projectCreateSchema.inputSchema, { waitSeconds: 901 }));
    expect(above).toEqual([{ path: "waitSeconds", message: "must be at most 900, got 901" }]);

    expect(said(validateToolInput(docsSearchSchema.inputSchema, { query: "x", limit: 0 }))).toEqual([
      { path: "limit", message: "must be at least 1, got 0" },
    ]);

    expect(said(validateToolInput(docsSearchSchema.inputSchema, { query: "x", limit: 9 }))).toEqual([
      { path: "limit", message: "must be at most 8, got 9" },
    ]);

    expect(said(validateToolInput(submitSchema.inputSchema, { browsers: ["safari"], buildNumber: 0 }))).toEqual([
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

    expect(said(validateToolInput(evalSchema.inputSchema, { ...base, until: { timeoutMs: "5000" } }))).toEqual([
      { path: "until.timeoutMs", message: "expected number, got string" },
    ]);

    expect(validateToolInput(evalSchema.inputSchema, { ...base, until: { timeoutMs: 5000, intervalMs: 250, extra: "kept" } })).toEqual([]);

    expect(said(validateToolInput(elementSchema.inputSchema, { projectPath: "/tmp/x", action: "move", points: [{ x: 1, y: 2 }, { x: 3 }, 7] }))).toEqual([
      { path: "points[1].y", message: "required argument is missing" },
      { path: "points[2]", message: "expected object, got number" },
    ]);

    expect(said(validateToolInput(submitSchema.inputSchema, { browsers: ["firefox"], storeSettings: { enabled: "yes", releaseChannel: "beta" } }))).toEqual([
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

describe("912: an argument refusal says what to pass, read from the schema that refused it", () => {
  const hintOf = (tool: { name: string; inputSchema: Record<string, unknown> }, args: Record<string, unknown>): string =>
    JSON.parse(inputValidationError(tool.name, validateToolInput(tool.inputSchema, args), tool.inputSchema)).error.hint;

  it("names the argument, its type and every value its enum lists", () => {
    expect(hintOf(submitSchema, { browsers: ["firefox"], storeSettings: { enabled: "yes", releaseChannel: "beta" } })).toBe(
      'Pass storeSettings.enabled as true or false. Pass storeSettings.releaseChannel as a string, one of "listed", "unlisted".',
    );

    expect(hintOf(authSchema, { action: "signin" })).toBe('Pass action as a string, one of "status", "login", "logout".');
  });

  it("names the range a number has to sit in", () => {
    expect(hintOf(docsSearchSchema, { query: "x", limit: 9 })).toBe("Pass limit as a number, from 1 to 8.");
    expect(hintOf(authSchema, { action: "status", waitSeconds: -1 })).toMatch(/^Pass waitSeconds as a (whole )?number, from 0 to \d+\.$/);
  });

  it("says a missing argument is required and what it takes, and tells an unknown one to go", () => {
    expect(hintOf(docsSearchSchema, {})).toBe("Pass query as a string; it is required.");
    expect(hintOf(docsSearchSchema, { query: "x", nope: 1 })).toBe("Remove nope, which this tool does not take.");
  });

  it("says how to shorten an over-long value and to drop a NUL byte", () => {
    expect(hintOf(devSchema, { projectPath: `/tmp/${"x".repeat(STRING_ARGUMENT_LIMIT)}` })).toBe(`Shorten projectPath to ${STRING_ARGUMENT_LIMIT} characters or fewer.`);
    expect(hintOf(devSchema, { projectPath: "/tmp/a\u0000b" })).toBe("Remove the NUL byte from projectPath.");
  });

  it("says the first three fixes and counts the rest, and keeps fix out of value.issues", () => {
    const out = JSON.parse(
      inputValidationError("extension_docs_search", validateToolInput(docsSearchSchema.inputSchema, { a: 1, b: 2, c: 3, d: 4, limit: 99 }), docsSearchSchema.inputSchema),
    );

    expect(out.error.hint).toBe("Pass query as a string; it is required. Remove a, which this tool does not take. Remove b, which this tool does not take. value.issues names 3 more.");
    expect(out.value.issues).toHaveLength(6);
    expect(out.value.issues.every((issue: Record<string, unknown>) => Object.keys(issue).join() === "path,message")).toBe(true);
  });

  it("answers a wrong type through the dispatcher with the hint in error.hint", async () => {
    const dispatch = createToolDispatcher({ tools: [buildTool as ToolModule], options: { features: ["local"], noShip: true } });
    const frame = await dispatch({ name: "extension_build", arguments: { projectPath: os.tmpdir(), browser: 7 } });
    const out = JSON.parse(frame.content[0]!.text);

    expect(out.error.code).toBe("E_INPUT_VALIDATION");
    expect(out.error.hint).toMatch(/^Pass browser as a string, one of "chrome", /);
    expect(out.error.hint).toContain('"firefox"');
  });
});

describe("908: a string argument no process, path or address can carry is refused before the tool runs", () => {
  it("refuses a NUL byte in any string argument and names it", () => {
    const issues = validateToolInput(startTool.schema.inputSchema, { projectPath: "/tmp/x", profile: "a\u0000b" });

    expect(issues).toHaveLength(1);
    expect(issues[0].path).toBe("profile");
    expect(issues[0].message).toContain("NUL byte");
  });

  it("refuses a NUL byte inside an array of strings and names the item", () => {
    const issues = validateToolInput(devTool.schema.inputSchema, { projectPath: "/tmp/x", extensions: ["/tmp/a", "/tmp/b\u0000"] });

    expect(issues.map((issue) => issue.path)).toEqual(["extensions[1]"]);
  });

  it(`refuses a path, name or id over ${STRING_ARGUMENT_LIMIT} characters and takes one at the limit`, () => {
    const over = validateToolInput(buildTool.schema.inputSchema, { projectPath: `/tmp/${"a".repeat(5000)}` });

    expect(over).toHaveLength(1);
    expect(over[0].path).toBe("projectPath");
    expect(over[0].message).toContain("5005 characters");
    expect(over[0].message).toContain(String(STRING_ARGUMENT_LIMIT));
    expect(validateToolInput(buildTool.schema.inputSchema, { projectPath: "a".repeat(STRING_ARGUMENT_LIMIT) })).toEqual([]);
  });

  it("takes a long expression and a long data URL, which carry content and not a name", () => {
    const expression = `(() => { ${"window.x = 1; ".repeat(2000)} })()`;
    const url = `data:text/html;base64,${"QUJD".repeat(20000)}`;

    expect(expression.length).toBeGreaterThan(STRING_ARGUMENT_LIMIT);
    expect(validateToolInput(evalSchema.inputSchema, { projectPath: "/tmp/x", expression, url })).toEqual([]);
    expect(validateToolInput(devTool.schema.inputSchema, { projectPath: "/tmp/x", startingUrl: url })).toEqual([]);
  });

  it(`refuses content over ${CONTENT_ARGUMENT_LIMIT} characters`, () => {
    const issues = validateToolInput(evalSchema.inputSchema, { projectPath: "/tmp/x", expression: "1".repeat(CONTENT_ARGUMENT_LIMIT + 1) });

    expect(issues.map((issue) => issue.path)).toEqual(["expression"]);
  });
});

describe("908: a call whose arguments cannot work answers E_INPUT_VALIDATION with retry no, before any process is started", () => {
  const local = [buildTool, devTool, startTool, doctorTool, stopTool] as unknown as ToolModule[];
  const dispatch = createToolDispatcher({ tools: local, options: { features: ["local"], noShip: true } });
  const call = async (name: string, args: Record<string, unknown>) => JSON.parse((await dispatch({ name, arguments: args })).content[0]?.text ?? "{}");
  const missing = path.join(os.tmpdir(), "mcp-908-no-such-folder");
  const spawning = ["extension_build", "extension_dev", "extension_start", "extension_doctor"];

  it("a NUL byte and a 5,000-character projectPath are refused by name on build, dev, start and doctor", async () => {
    for (const name of spawning) {
      for (const projectPath of [`/tmp/${"a".repeat(5000)}`, "/tmp/a\u0000b"]) {
        const out = await call(name, { projectPath });

        expect(out.error.code, name).toBe("E_INPUT_VALIDATION");
        expect(out.error.retry, name).toBe("no");
        expect(out.value.issues[0].path, name).toBe("projectPath");
      }
    }
  });

  it("a projectPath that is not there is refused in the same words on every tool, naming the folder", async () => {
    const messages = new Set<string>();

    for (const name of spawning) {
      const out = await call(name, { projectPath: missing });

      expect(out.error.code, name).toBe("E_INPUT_VALIDATION");
      expect(out.error.retry, name).toBe("no");
      expect(out.status, name).toBe("invalid-arguments");
      expect(out.value.issues[0].path, name).toBe("projectPath");
      messages.add(out.value.issues[0].message);
    }

    expect([...messages]).toEqual([`no folder at ${missing}; pass the extension project's root, absolute or relative to this server's working directory ${process.cwd()}`]);
  });

  it("a projectPath that is a file is refused as not a folder, and a relative one is read from the server's working directory", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-908-"));
    const file = path.join(dir, "manifest.json");
    fs.writeFileSync(file, "{}");

    try {
      const out = await call("extension_build", { projectPath: file });

      expect(out.error.code).toBe("E_INPUT_VALIDATION");
      expect(out.value.issues[0].message).toContain(`${file} is a file, not a folder`);

      const relative = await call("extension_doctor", { projectPath: "mcp-908-no-such-folder" });

      expect(relative.value.issues[0].message).toContain(`no folder at ${path.resolve("mcp-908-no-such-folder")}`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("extension_stop still answers for a folder that is gone, so a session whose project was deleted can be ended", async () => {
    const out = await call("extension_stop", { projectPath: missing, browser: "chrome" });

    expect(out.error?.code).not.toBe("E_INPUT_VALIDATION");
  });

  it("a process the operating system refuses to start for its arguments is an input refusal, never E_INTERNAL", async () => {
    const thrower = (error: Error): ToolModule => ({
      schema: { name: "extension_doctor", description: "", inputSchema: { type: "object", properties: {} } },
      handler: async () => {
        throw error;
      },
    });
    const answer = async (error: Error) =>
      JSON.parse((await createToolDispatcher({ tools: [thrower(error)], options: { features: ["local"], noShip: false } })({ name: "extension_doctor", arguments: {} })).content[0]?.text ?? "{}");

    for (const error of [
      Object.assign(new Error("spawn ENAMETOOLONG"), { code: "ENAMETOOLONG", syscall: "spawn" }),
      Object.assign(new Error("spawn E2BIG"), { code: "E2BIG", syscall: "spawn" }),
      Object.assign(new Error("spawn EINVAL"), { code: "EINVAL", syscall: "spawn" }),
      Object.assign(new TypeError("The argument 'args[7]' must be a string without null bytes. Received 'a\\x00b'"), { code: "ERR_INVALID_ARG_VALUE" }),
    ]) {
      const out = await answer(error);

      expect(out.error.code, error.message).toBe("E_INPUT_VALIDATION");
      expect(out.error.retry, error.message).toBe("no");
      expect(out.error.message, error.message).toContain(error.message);
    }

    const unknown = await answer(new Error("boom"));

    expect(unknown.error.code).toBe("E_INTERNAL");
  });
});
