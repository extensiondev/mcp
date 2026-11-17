// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { envelope } from "./envelope";

export interface InputIssue {
  path: string;
  message: string;
}

export const ENFORCED_TYPES = ["string", "number", "integer", "boolean", "array", "object"] as const;

export const ENFORCED_KEYWORDS = ["type", "enum", "minimum", "maximum", "items", "properties", "required"] as const;

export const ANNOTATION_KEYWORDS = ["description", "default"] as const;

interface PropertySchema {
  type?: string | string[];
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
  items?: PropertySchema;
  properties?: Record<string, PropertySchema>;
  required?: string[];
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

function describeValue(value: unknown, allowed: string[]): string {
  if (typeof value === "number" && allowed.includes("integer")) return `number ${value}`;

  return typeOf(value);
}

function matchesType(type: string, value: unknown): boolean {
  if (type === "integer") return typeof value === "number" && Number.isInteger(value);
  if (type === "number") return typeof value === "number" && Number.isFinite(value);

  return typeOf(value) === type;
}

function checkValue(
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

  if (allowed.length > 0 && !allowed.some((type) => matchesType(type, value))) {
    issues.push({
      path,
      message: `expected ${allowed.join(" or ")}, got ${describeValue(value, allowed)}`,
    });

    return;
  }

  if (Array.isArray(value)) {
    const itemSchema = schema.items;

    if (itemSchema) {
      value.forEach((item, i) =>
        checkValue(`${path}[${i}]`, item, itemSchema, issues),
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

      return;
    }
  }

  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) {
      issues.push({ path, message: `must be at least ${schema.minimum}, got ${value}` });
    } else if (typeof schema.maximum === "number" && value > schema.maximum) {
      issues.push({ path, message: `must be at most ${schema.maximum}, got ${value}` });
    }

    return;
  }

  if (typeOf(value) !== "object") return;

  const record = value as Record<string, unknown>;

  for (const key of schema.required ?? []) {
    if (record[key] === undefined) {
      issues.push({ path: `${path}.${key}`, message: "required argument is missing" });
    }
  }

  for (const [key, nested] of Object.entries(schema.properties ?? {})) {
    if (record[key] === undefined) continue;

    checkValue(`${path}.${key}`, record[key], nested, issues);
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
  match: ["grep"],
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

    checkValue(key, value, propSchema, issues);
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
  hint?: string,
): string {
  return envelope({
    ok: false,
    command: toolName,
    status: "invalid-arguments",
    error: {
      code: "E_INPUT_VALIDATION",
      name: "InputValidationError",
      message: `Invalid arguments for ${toolName}: ${issues
        .map((i) => `${i.path}: ${i.message}`)
        .join("; ")}${hint ? `. ${hint}` : ""}`,
    },
    value: {
      issues,
      ...(inputSchema ? { args: describeToolArgs(inputSchema) } : {}),
    },
    ...(hint ? { hint } : {}),
  });
}
