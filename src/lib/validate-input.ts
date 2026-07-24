// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

export interface InputIssue {
  path: string;
  message: string;
}

interface PropertySchema {
  type?: string | string[];
  enum?: unknown[];
  items?: { type?: string | string[]; enum?: unknown[] };
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
  const allowed = schema.type === undefined
    ? []
    : Array.isArray(schema.type)
      ? schema.type
      : [schema.type];
  const primitives = allowed.filter((t) =>
    ["string", "number", "boolean"].includes(t),
  );
  if (primitives.length > 0 && primitives.length === allowed.length) {
    if (!primitives.includes(typeOf(value))) {
      issues.push({
        path,
        message: `expected ${primitives.join(" or ")}, got ${typeOf(value)}`,
      });
      return;
    }
  }
  if (allowed.includes("array")) {
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

const ARG_ALIASES: Record<string, string[]> = {
  projectPath: ["path", "dir", "projectDir", "cwd"],
  projectName: ["name"],
  parentDir: ["parent", "into"],
  slug: ["template", "templateSlug"],
  expression: ["code", "js", "script"],
  manifestPath: ["manifest"],
  surface: ["view", "target"],
  timeout: ["timeoutMs", "timeoutMillis"],
  limit: ["lines", "count", "max", "maxLines"],
  tab: ["tabId"],
  url: ["href", "pageUrl"],
  browser: ["browserName"],
  buildSha: ["buildId"],
  buildId: ["buildSha"],
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

export function describeToolArgs(inputSchema: Record<string, unknown>): {
  required: string[];
  optional: string[];
  aliases: Record<string, string[]>;
} {
  const schema = inputSchema as ObjectSchema;
  const props = schema.properties ?? {};
  const required = schema.required ?? [];
  const optional = Object.keys(props).filter((k) => !required.includes(k));
  const aliases: Record<string, string[]> = {};
  for (const [canonical, list] of Object.entries(ARG_ALIASES)) {
    if (!(canonical in props)) continue;
    const usable = list.filter((alias) => !(alias in props));
    if (usable.length) aliases[canonical] = usable;
  }
  return { required, optional, aliases };
}

export function inputValidationError(
  toolName: string,
  issues: InputIssue[],
  inputSchema?: Record<string, unknown>,
): string {
  return JSON.stringify({
    ok: false,
    error: {
      name: "InputValidationError",
      message: `Invalid arguments for ${toolName}: ${issues
        .map((i) => `${i.path}: ${i.message}`)
        .join("; ")}`,
      issues,
      ...(inputSchema ? { args: describeToolArgs(inputSchema) } : {}),
    },
  });
}
