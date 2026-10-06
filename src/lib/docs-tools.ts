// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

/* @invariant THE TOOL REFERENCE IS RENDERED FROM THE SCHEMAS, NEVER TYPED.
   The hand-written claude/rules/mcp-tools.md documented inputs the server
   refuses as unknown, so the file is generated from the
   schemas the server registers and a test fails when it drifts. */

interface PropertySchema {
  type?: string | string[];
  description?: string;
  enum?: unknown[];
  default?: unknown;
  items?: { type?: string; enum?: unknown[] };
}

export interface ToolSchemaLike {
  name: string;
  description: string;
  inputSchema: {
    properties?: Record<string, unknown>;
    required?: string[];
  };
}

function typeOf(property: PropertySchema): string {
  const base = Array.isArray(property.type) ? property.type.join(" | ") : property.type ?? "any";
  if (base === "array" && property.items?.enum) return `array of ${property.items.enum.map((v) => JSON.stringify(v)).join(" | ")}`;
  if (base === "array" && property.items?.type) return `array of ${property.items.type}`;
  if (property.enum) return property.enum.map((v) => JSON.stringify(v)).join(" | ");
  return base;
}

export function renderToolsDoc(tools: ToolSchemaLike[]): string {
  const lines: string[] = [];
  lines.push("# MCP tools");
  lines.push("");
  lines.push("Generated from the schemas the server registers (`src/index.ts`); do not edit by hand. Regenerate with `pnpm docs:tools`. A test fails when this file and the schemas disagree.");
  lines.push("");
  lines.push(`${tools.length} tools.`);
  lines.push("");
  for (const tool of [...tools].sort((a, b) => a.name.localeCompare(b.name))) {
    lines.push(`## ${tool.name}`);
    lines.push("");
    lines.push(tool.description.trim());
    lines.push("");
    const properties = (tool.inputSchema.properties ?? {}) as Record<string, PropertySchema>;
    const required = new Set(tool.inputSchema.required ?? []);
    const names = Object.keys(properties);
    if (names.length === 0) {
      lines.push("Inputs: none.");
    } else {
      lines.push("| input | type | required | default | description |");
      lines.push("| --- | --- | --- | --- | --- |");
      for (const name of names) {
        const property = properties[name] ?? {};
        const def = property.default === undefined ? "" : `\`${JSON.stringify(property.default)}\``;
        const description = String(property.description ?? "").replace(/\s+/g, " ").replace(/\|/g, "\\|").trim();
        lines.push(`| \`${name}\` | ${typeOf(property).replace(/\|/g, "\\|")} | ${required.has(name) ? "yes" : "no"} | ${def} | ${description} |`);
      }
    }
    lines.push("");
  }
  return lines.join("\n");
}
