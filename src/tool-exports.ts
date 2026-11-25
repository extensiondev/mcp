// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { TOOL_POLICY, toolTitle } from "./lib/tool-policy";
import { tools } from "./lib/tool-registry";
import * as addFeature from "./tools/add-feature";
import * as analyze from "./tools/analyze";
import * as build from "./tools/build";
import * as buildsTool from "./tools/builds";
import * as create from "./tools/create";
import * as docsSearch from "./tools/docs-search";
import * as manifestValidate from "./tools/manifest-validate";
import * as previewWeb from "./tools/preview-web";
import * as templates from "./tools/templates";
import * as themeVerify from "./tools/theme-verify";
import * as tryTool from "./tools/try";

import type { ToolModule } from "./lib/tool-dispatch";
import type { ToolAnnotations } from "./lib/tool-annotations";

export type { ToolAnnotations } from "./lib/tool-annotations";
export type { ToolModule } from "./lib/tool-dispatch";

type Args = Record<string, unknown>;

export interface ToolSchemaExport {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: ToolAnnotations;
  definition: ToolModule["schema"];
}

export interface ToolExport extends ToolSchemaExport {
  handler: (args: Args) => Promise<string>;
}

export const SERVED_TOOL_NAMES = [
  "extension_docs_search",
  "extension_templates",
  "extension_manifest_validate",
  "extension_create",
  "extension_add_feature",
  "extension_build",
  "extension_analyze",
  "extension_theme_verify",
  "extension_try",
  "extension_preview_web",
  "extension_builds_download",
] as const;

export const BROWSER_TOOL_NAMES = [
  "extension_dev",
  "extension_start",
  "extension_stop",
  "extension_reload",
  "extension_open",
  "extension_list_extensions",
  "extension_screenshot",
  "extension_eval",
  "extension_dom_snapshot",
  "extension_element_read",
  "extension_element_act",
  "extension_network_read",
  "extension_network_stub",
  "extension_storage_read",
  "extension_storage_write",
  "extension_logs",
  "extension_inspect",
  "extension_assert",
  "extension_wait",
] as const;

export type ServedToolName = (typeof SERVED_TOOL_NAMES)[number];
export type BrowserToolName = (typeof BROWSER_TOOL_NAMES)[number];

const OWN_HANDLERS: Record<Exclude<ServedToolName, "extension_builds_download">, ToolModule["handler"]> = {
  extension_docs_search: docsSearch.handler,
  extension_templates: templates.handler,
  extension_manifest_validate: manifestValidate.handler,
  extension_create: create.handler,
  extension_add_feature: addFeature.handler,
  extension_build: build.handler,
  extension_analyze: analyze.handler,
  extension_theme_verify: themeVerify.handler,
  extension_try: tryTool.handler,
  extension_preview_web: previewWeb.handler,
};

function listed(name: string): ToolModule {
  const tool = tools.find((candidate) => candidate.schema.name === name);
  if (!tool) throw new Error(`${name} is not a tool this server lists`);

  return tool;
}

function schemaExport(name: string): ToolSchemaExport {
  const { schema } = listed(name);

  return {
    name,
    title: toolTitle(name),
    description: schema.description,
    inputSchema: schema.inputSchema,
    annotations: TOOL_POLICY[name]!.annotations,
    definition: schema,
  };
}

function twinHandler(name: string, served: ToolModule["handler"]): ToolModule["handler"] {
  const actsAs = TOOL_POLICY[name]!.actsAs!;

  return async (args: Args) => actsAs.refuse(args) ?? served(actsAs.args ? actsAs.args(args) : args);
}

const handlers: Record<ServedToolName, ToolModule["handler"]> = {
  ...OWN_HANDLERS,
  extension_builds_download: twinHandler("extension_builds_download", buildsTool.handler),
};

export const servedTools = Object.fromEntries(
  SERVED_TOOL_NAMES.map((name) => [name, { ...schemaExport(name), handler: handlers[name] }]),
) as Record<ServedToolName, ToolExport>;

export const browserToolSchemas = Object.fromEntries(
  BROWSER_TOOL_NAMES.map((name) => [name, schemaExport(name)]),
) as Record<BrowserToolName, ToolSchemaExport>;
