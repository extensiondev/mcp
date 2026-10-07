// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { CLIENTS, buildRecipe } from "./index";

export const README_SETUP_START = "<!-- setup:start (generated from src/clients, run pnpm readme:clients) -->";
export const README_SETUP_END = "<!-- setup:end -->";

const fence = (language: string, text: string): string =>
  ["```" + language, text, "```"].join("\n");

const PLUGIN_NOTE = [
  "Or install it as a plugin, the MCP server plus the `/extension`, `/extension-add`, `/extension-debug`, and `/extension-publish` commands in one step:",
  "",
  fence("", "/plugin marketplace add extensiondev/mcp\n/plugin install extension-mcp@extensiondev-mcp"),
].join("\n");

export function renderReadmeSetup(): string {
  const sections: string[] = [];
  for (const client of CLIENTS) {
    const recipe = buildRecipe({
      client: client.id,
      reach: "everything",
      strictApproval: false,
      project: "",
    });
    const title = client.subtitle ? `${client.label} (${client.subtitle})` : client.label;
    const body: string[] = [`### ${title}`, ""];
    if (recipe.client === "cursor" && recipe.deeplink) {
      body.push(
        `[![Install MCP Server](https://cursor.com/deeplink/mcp-install-dark.svg)](${recipe.deeplink})`,
        "",
      );
    }
    if (recipe.command) body.push(fence("bash", recipe.command), "");
    if (recipe.config) body.push(`\`${recipe.config.path}\`:`, "", fence(recipe.config.language, recipe.config.text), "");
    if (recipe.client === "claude-code") body.push(PLUGIN_NOTE, "");
    sections.push(body.join("\n").trimEnd());
  }
  return [README_SETUP_START, "", sections.join("\n\n"), "", README_SETUP_END].join("\n");
}

export function spliceReadmeSetup(readme: string): string {
  const start = readme.indexOf(README_SETUP_START);
  const end = readme.indexOf(README_SETUP_END);
  if (start < 0 || end < start) throw new Error("README has no setup markers");
  return readme.slice(0, start) + renderReadmeSetup() + readme.slice(end + README_SETUP_END.length);
}
