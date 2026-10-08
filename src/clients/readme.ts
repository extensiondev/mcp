// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { CLIENTS, buildRecipe, type Recipe } from "./index";

export const README_SETUP_START = "<!-- setup:start (generated from src/clients, run pnpm readme:clients) -->";
export const README_SETUP_END = "<!-- setup:end -->";

const fence = (language: string, text: string): string =>
  [`\`\`\`${language}`, text, "```"].join("\n");

const PLUGIN_NOTE = [
  "Or install it as a plugin, the MCP server plus the `/extension`, `/extension-add`, `/extension-debug`, and `/extension-publish` commands in one step:",
  "",
  fence("", "/plugin marketplace add extensiondev/mcp\n/plugin install extension-mcp@extensiondev-mcp"),
].join("\n");

function configNote(recipe: Recipe, sharedPath: string): string | undefined {
  if (!recipe.config) return undefined;

  const { path, text } = recipe.config;

  if (recipe.client === "cursor") {
    return `Or paste the \`${sharedPath}\` block below into \`${path}\`.`;
  }

  if (recipe.client === "vscode") {
    const key = Object.keys(JSON.parse(text) as Record<string, unknown>)[0];

    return `Or paste it into \`${path}\` under \`${key}\`, with \`"type": "stdio"\` on the entry.`;
  }

  if (recipe.client === "codex") {
    const table = text.split("\n")[0];

    return `Or write it into \`${path}\` as a \`${table}\` table with the same \`command\` and \`args\`.`;
  }

  return undefined;
}

export function renderReadmeSetup(): string {
  const recipes = CLIENTS.map((client) => ({
    client,
    recipe: buildRecipe({
      client: client.id,
      reach: "everything",
      strictApproval: false,
      project: "",
    }),
  }));
  const shared = recipes.find((entry) => entry.recipe.client === "json")?.recipe.config;

  if (!shared) throw new Error("the json client has no config");

  const sections: string[] = [];

  for (const { client, recipe } of recipes) {
    const title = client.subtitle ? `${client.label} (${client.subtitle})` : client.label;
    const body: string[] = [`### ${title}`, ""];

    if (recipe.client === "cursor" && recipe.deeplink) {
      body.push(
        `[![Install MCP Server](https://cursor.com/deeplink/mcp-install-dark.svg)](${recipe.deeplink})`,
        "",
      );
    }

    if (recipe.command) body.push(fence("bash", recipe.command), "");
    if (recipe.client === "claude-code") body.push(PLUGIN_NOTE, "");

    const note = configNote(recipe, shared.path);

    if (note) body.push(note, "");
    if (recipe.client === "json") body.push(`\`${shared.path}\`:`, "", fence(shared.language, shared.text), "");

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
