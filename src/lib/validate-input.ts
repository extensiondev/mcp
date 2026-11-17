// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { statSync } from "node:fs";
import { resolve as resolveFolder } from "node:path";

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

/* @invariant NO STRING ARGUMENT REACHES A TOOL WITH A NUL BYTE OR PAST ITS
 * LENGTH LIMIT. A path, name, slug, id or flag value is held to 4,096
 * characters: the longest path any supported system takes (PATH_MAX on
 * Linux; macOS stops at 1,024 and Windows at 260 without the long-path
 * switch), and one that still fits the 8,191 characters of a Windows command
 * line. The arguments named below carry content, not a name (an expression,
 * a stored value, typed text, a response body, a page address that may be a
 * data URL, release notes), so they are held to 1,000,000 characters, the
 * size of one MCP message and of macOS's whole argument area. What the
 * system still refuses under that limit (Linux takes 131,072 bytes in one
 * argument) is answered by the dispatcher as an input refusal, not as
 * E_INTERNAL (argumentFailure in exec.ts). Before ledger 908 a 5,000
 * character projectPath or a NUL byte reached spawn and answered E_INTERNAL
 * with retry "safe".
 */
export const STRING_ARGUMENT_LIMIT = 4_096;
export const CONTENT_ARGUMENT_LIMIT = 1_000_000;

const CONTENT_ARGUMENTS = new Set([
  "body",
  "description",
  "expression",
  "match",
  "probe",
  "releaseNotes",
  "selector",
  "startingUrl",
  "tabUrl",
  "text",
  "url",
  "value",
  "valueJson",
]);

function checkStringBounds(key: string, at: string, value: unknown, issues: InputIssue[]): void {
  if (Array.isArray(value)) {
    value.forEach((item, i) => checkStringBounds(key, `${at}[${i}]`, item, issues));

    return;
  }

  if (typeof value !== "string") return;

  if (value.includes("\u0000")) {
    issues.push({ path: at, message: "contains a NUL byte, which no path, command argument or address can carry" });

    return;
  }

  const limit = CONTENT_ARGUMENTS.has(key) ? CONTENT_ARGUMENT_LIMIT : STRING_ARGUMENT_LIMIT;

  if (value.length > limit) {
    issues.push({ path: at, message: `is ${value.length} characters, over the limit of ${limit} for this argument` });
  }
}

const FOLDER_MAY_BE_GONE = new Set(["extension_stop"]);

/* @invariant A projectPath THAT IS NOT A FOLDER ON THIS MACHINE IS REFUSED
 * ONCE, HERE, IN THE SAME WORDS FOR EVERY TOOL. The engine is started with
 * the project as its working directory, and a missing working directory
 * fails the spawn as ENOENT on the command, so extension_dev blamed the
 * engine override and npx, extension_build answered E_BUILD_FAILED with the
 * same text and extension_doctor asked for a newer CLI (ledger 908). The
 * path is read as every tool reads it, from this server's working
 * directory. extension_stop is the one exception: it ends a session by its
 * recorded pids, and a session whose folder was deleted still has to be
 * stoppable. A folder the system will not let this server read is left to
 * the tool, which says what it could not read.
 */
export function projectFolderIssues(
  toolName: string,
  inputSchema: Record<string, unknown>,
  args: Record<string, unknown>,
): InputIssue[] {
  const properties = (inputSchema as ObjectSchema).properties ?? {};
  const given = args.projectPath;

  if (!("projectPath" in properties) || FOLDER_MAY_BE_GONE.has(toolName)) return [];
  if (typeof given !== "string" || !given.trim()) return [];

  const folder = resolveFolder(given);
  const where = `pass the extension project's root, absolute or relative to this server's working directory ${process.cwd()}`;

  try {
    if (statSync(folder).isDirectory()) return [];

    return [{ path: "projectPath", message: `${folder} is a file, not a folder; ${where}` }];
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;

    if (code === "ENOENT" || code === "ENOTDIR") return [{ path: "projectPath", message: `no folder at ${folder}; ${where}` }];
    if (code === "ENAMETOOLONG") return [{ path: "projectPath", message: `is ${given.length} characters, longer than a path on this system can be` }];

    return [];
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
    checkStringBounds(key, key, value, issues);
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
