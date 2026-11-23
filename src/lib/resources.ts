// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ErrorCode, ListResourcesRequestSchema, McpError, ReadResourceRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import { name as PACKAGE_NAME, version } from "../../package.json";

import type { Server } from "@modelcontextprotocol/sdk/server/index.js";

export interface ServerResource {
  uri: string;
  name: string;
  title: string;
  description: string;
  mimeType: "text/markdown";
  file: string;
  section?: string;
}

export const RESOURCES: ServerResource[] = [
  {
    uri: "extension-dev://reference/tools",
    name: "tool-reference",
    title: "Tool reference",
    description: "Every tool this package registers, with its inputs, types and defaults, generated from the schemas.",
    mimeType: "text/markdown",
    file: "claude/reference/mcp-tools.md",
  },
  {
    uri: "extension-dev://reference/store-md",
    name: "store-md-fields",
    title: "STORE.md fields",
    description: "The fields a project's STORE.md may carry and the store listing field each one fills.",
    mimeType: "text/markdown",
    file: "claude/reference/store-md-fields.md",
  },
  {
    uri: "extension-dev://reference/security",
    name: "security-notes",
    title: "Security notes",
    description: "What runs on this machine, what leaves it, the eval gate and the approvals a person gives, from the README.",
    mimeType: "text/markdown",
    file: "README.md",
    section: "Security",
  },
  {
    uri: "extension-dev://changelog/current",
    name: "changelog-current",
    title: `Changelog of ${version}`,
    description: `What changed in ${version}, the version of this server that is running, from CHANGELOG.md.`,
    mimeType: "text/markdown",
    file: "CHANGELOG.md",
    section: version,
  },
];

export function packageRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));

  for (;;) {
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")) as { name?: string };

      if (manifest.name === PACKAGE_NAME) return dir;
    } catch {}

    const parent = path.dirname(dir);

    if (parent === dir) throw new Error(`The ${PACKAGE_NAME} package folder was not found above ${fileURLToPath(import.meta.url)}.`);

    dir = parent;
  }
}

export function markdownSection(text: string, heading: string): string | null {
  const lines = text.split("\n");
  const start = lines.indexOf(`## ${heading}`);

  if (start < 0) return null;

  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith("## "));

  return `${[lines[start], ...(end < 0 ? rest : rest.slice(0, end))].join("\n").trimEnd()}\n`;
}

export function readResource(uri: string): { uri: string; mimeType: string; text: string } {
  const resource = RESOURCES.find((entry) => entry.uri === uri);

  if (!resource) {
    throw new McpError(ErrorCode.InvalidParams, `No resource has the URI ${uri}. Call resources/list for the URIs: ${RESOURCES.map((entry) => entry.uri).join(", ")}.`);
  }

  let text: string | null;

  try {
    const whole = fs.readFileSync(path.join(packageRoot(), resource.file), "utf8");

    text = resource.section ? markdownSection(whole, resource.section) : whole;
  } catch {
    text = null;
  }

  if (text === null) {
    const what = resource.section ? `the "${resource.section}" section of ${resource.file}` : resource.file;

    throw new McpError(ErrorCode.InternalError, `The installed ${PACKAGE_NAME} package does not carry ${what}, which ${uri} serves. Install the package again (npx -y ${PACKAGE_NAME}@latest) and read it again.`);
  }

  return { uri: resource.uri, mimeType: resource.mimeType, text };
}

export function installResourceHandlers(server: Server): void {
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: RESOURCES.map(({ uri, name, title, description, mimeType }) => ({ uri, name, title, description, mimeType })),
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => ({ contents: [readResource(request.params.uri)] }));
}
