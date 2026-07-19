// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// MIT License (c) Cezar Augusto and the extension.dev collaborators

export interface InputIssue {
  path: string;
  message: string;
}

interface PropertySchema {
  type?: string;
  enum?: unknown[];
  items?: { type?: string; enum?: unknown[] };
}

interface ObjectSchema {
  type?: string;
  properties?: Record<string, PropertySchema>;
  required?: string[];
}

function typeOf(value: unknown): string {
  if (Array.isArray(value)) return "array";
  if (value === null) return "null";
  return typeof value;
}

function checkPrimitive(
  path: string,
  value: unknown,
  schema: PropertySchema,
  issues: InputIssue[],
): void {
  if (schema.type && ["string", "number", "boolean"].includes(schema.type)) {
    if (typeOf(value) !== schema.type) {
      issues.push({
        path,
        message: `expected ${schema.type}, got ${typeOf(value)}`,
      });
      return;
    }
  }
  if (schema.type === "array") {
    if (!Array.isArray(value)) {
      issues.push({ path, message: `expected array, got ${typeOf(value)}` });
      return;
    }
    const itemSchema = schema.items;
    if (itemSchema) {
      value.forEach((item, i) =>
        checkPrimitive(`${path}[${i}]`, item, itemSchema, issues),
      );
    }
    return;
  }
  if (Array.isArray(schema.enum) && schema.enum.length) {
    if (!schema.enum.includes(value)) {
      issues.push({
        path,
        message: `must be one of: ${schema.enum.map(String).join(", ")}`,
      });
    }
  }
}

// Common argument synonyms folded to each tool's canonical name before
// validation, so callers who reach for the obvious word (`name`, `code`,
// `path`, `template`) are not rejected. Applied schema-aware: an alias is only
// rewritten when the canonical IS a property of this tool and the alias is NOT
// (so a tool that legitimately uses the alias word keeps its own meaning).
const ARG_ALIASES: Record<string, string[]> = {
  projectPath: ["path", "dir", "projectDir", "cwd"],
  projectName: ["name"],
  parentDir: ["parent", "into"],
  slug: ["template", "templateSlug"],
  expression: ["code", "js", "script"],
  manifestPath: ["manifest"],
  surface: ["view"],
};

export function normalizeArgAliases(
  inputSchema: Record<string, unknown>,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const schema = inputSchema as ObjectSchema;
  const props = schema.properties ?? {};
  const out: Record<string, unknown> = { ...args };
  for (const [canonical, aliases] of Object.entries(ARG_ALIASES)) {
    if (!(canonical in props)) continue;
    if (out[canonical] !== undefined) continue;
    for (const alias of aliases) {
      if (alias in props) continue;
      if (out[alias] !== undefined) {
        out[canonical] = out[alias];
        delete out[alias];
        break;
      }
    }
  }
  return out;
}

export function validateToolInput(
  inputSchema: Record<string, unknown>,
  args: Record<string, unknown>,
): InputIssue[] {
  const schema = inputSchema as ObjectSchema;
  const issues: InputIssue[] = [];
  const properties = schema.properties ?? {};

  for (const key of schema.required ?? []) {
    if (args[key] === undefined) {
      issues.push({ path: key, message: "required argument is missing" });
    }
  }

  for (const [key, value] of Object.entries(args)) {
    const propSchema = properties[key];
    if (!propSchema) {
      const known = Object.keys(properties);
      issues.push({
        path: key,
        message: `unknown argument${known.length ? ` (known: ${known.join(", ")})` : ""}`,
      });
      continue;
    }
    if (value === undefined) continue;
    checkPrimitive(key, value, propSchema, issues);
  }

  return issues;
}

export function inputValidationError(
  toolName: string,
  issues: InputIssue[],
): string {
  return JSON.stringify({
    ok: false,
    error: {
      name: "InputValidationError",
      message: `Invalid arguments for ${toolName}: ${issues
        .map((i) => `${i.path}: ${i.message}`)
        .join("; ")}`,
      issues,
    },
  });
}
