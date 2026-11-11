// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { PACKAGE, SERVER_NAME, buildRecipe, type ClientId, type Recipe } from "./index";

export const README_SETUP_START = "<!-- setup:start (generated from src/clients, run pnpm readme:clients) -->";
export const README_SETUP_END = "<!-- setup:end -->";

const CLIENTS_DOC = "https://docs.extension.dev/tools/mcp/clients";
const CURSOR_BADGE = "https://cursor.com/deeplink/mcp-install-dark.svg";
const VSCODE_BADGE =
  "https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=flat-square&logo=visualstudiocode&logoColor=white";

const fence = (language: string, text: string): string =>
  [`\`\`\`${language}`, text, "```"].join("\n");

const recipe = (client: ClientId): Recipe =>
  buildRecipe({ client, reach: "everything", strictApproval: false, project: "" });

const withYes = (command: string): string =>
  command.replace(`npx ${PACKAGE}`, `npx -y ${PACKAGE}`);

export function vscodeInstallLink(deeplink: string): string {
  return `https://insiders.vscode.dev/redirect?url=${encodeURIComponent(decodeURIComponent(deeplink))}`;
}

export function renderReadmeSetup(): string {
  const claude = recipe("claude-code");
  const cursor = recipe("cursor");
  const vscode = recipe("vscode");
  const shared = recipe("json").config;

  if (!claude.command || !cursor.deeplink || !vscode.deeplink || !shared) {
    throw new Error("a recipe the README setup needs is missing");
  }

  const config = JSON.parse(shared.text) as {
    mcpServers: Record<string, { command: string; args: string[] }>;
  };
  const entry = config.mcpServers[SERVER_NAME];
  entry.args = ["-y", ...entry.args];

  return [
    README_SETUP_START,
    "",
    fence("bash", withYes(claude.command)),
    "",
    `[![Install in Cursor](${CURSOR_BADGE})](${cursor.deeplink}) [![Install in VS Code](${VSCODE_BADGE})](${vscodeInstallLink(vscode.deeplink)})`,
    "",
    `Other clients take the same server as \`${shared.path}\`; every client's block, with a local-only form, is on [Install in your client](${CLIENTS_DOC}).`,
    "",
    fence(shared.language, JSON.stringify(config, null, 2)),
    "",
    README_SETUP_END,
  ].join("\n");
}

export function spliceReadmeSetup(readme: string): string {
  const start = readme.indexOf(README_SETUP_START);
  const end = readme.indexOf(README_SETUP_END);

  if (start < 0 || end < start) throw new Error("README has no setup markers");

  return readme.slice(0, start) + renderReadmeSetup() + readme.slice(end + README_SETUP_END.length);
}
