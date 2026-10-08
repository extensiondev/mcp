// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { CLIENTS, buildRecipe, type Recipe } from "../clients/index";
import { typeOf, type PropertySchema, type ToolSchemaLike } from "./docs-tools";
import { TOOL_DOCS, type DocsTier } from "./docs-meta";
import { TOOL_POLICY } from "./tool-policy";

export interface ToolDocsInput {
  name: string;
  type: string;
  required: boolean;
  default?: unknown;
  description: string;
}

export interface ToolDocsEntry {
  name: string;
  tier: DocsTier;
  group: string;
  description: string;
  gate: string;
  samplePrompt: string;
  readOnly: boolean;
  destructive: boolean;
  idempotent: boolean;
  openWorld: boolean;
  untrusted: boolean;
  inputs: ToolDocsInput[];
}

export interface ToolsDocsJson {
  generatedFrom: string;
  version: string;
  count: number;
  tools: ToolDocsEntry[];
}

export interface ClientsDocsJson {
  generatedFrom: string;
  version: string;
  clients: { id: string; label: string; recipes: { everything: Recipe; local: Recipe } }[];
}

export function renderToolsJson(tools: ToolSchemaLike[], version: string): ToolsDocsJson {
  const entries = [...tools]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((tool): ToolDocsEntry => {
      const meta = TOOL_DOCS[tool.name];
      const policy = TOOL_POLICY[tool.name];

      if (!meta) throw new Error(`${tool.name} has no docs meta in src/lib/docs-meta.ts`);
      if (!policy) throw new Error(`${tool.name} has no policy in src/lib/tool-policy.ts`);

      const properties = (tool.inputSchema.properties ?? {}) as Record<string, PropertySchema>;
      const required = new Set(tool.inputSchema.required ?? []);

      return {
        name: tool.name,
        tier: meta.tier,
        group: policy.group,
        description: tool.description.trim(),
        gate: meta.gate,
        samplePrompt: meta.samplePrompt,
        readOnly: policy.annotations.readOnlyHint,
        destructive: policy.annotations.destructiveHint,
        idempotent: policy.annotations.idempotentHint,
        openWorld: policy.annotations.openWorldHint,
        untrusted: policy.untrusted === true,
        inputs: Object.keys(properties).map((name) => {
          const property = properties[name] ?? {};

          return {
            name,
            type: typeOf(property),
            required: required.has(name),
            ...(property.default === undefined ? {} : { default: property.default }),
            description: String(property.description ?? "").replace(/\s+/g, " ").trim(),
          };
        }),
      };
    });

  return {
    generatedFrom: "src/index.ts schemas, src/lib/tool-policy.ts, src/lib/docs-meta.ts; regenerate with pnpm docs:tools",
    version,
    count: entries.length,
    tools: entries,
  };
}

export function renderClientsJson(version: string): ClientsDocsJson {
  const recipe = (client: (typeof CLIENTS)[number]["id"], reach: "everything" | "local") =>
    buildRecipe({ client, reach, strictApproval: false, project: "" });

  return {
    generatedFrom: "src/clients/index.ts; regenerate with pnpm docs:tools",
    version,
    clients: CLIENTS.map((client) => ({
      id: client.id,
      label: client.label,
      recipes: { everything: recipe(client.id, "everything"), local: recipe(client.id, "local") },
    })),
  };
}
