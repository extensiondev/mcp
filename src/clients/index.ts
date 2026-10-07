// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

export type ClientId = "claude-code" | "cursor" | "vscode" | "codex" | "json";

export type Reach = "everything" | "no-ship" | "local";

export interface ClientInfo {
  id: ClientId;
  label: string;
  subtitle?: string;
}

export const CLIENTS: readonly ClientInfo[] = [
  { id: "claude-code", label: "Claude Code" },
  { id: "cursor", label: "Cursor" },
  { id: "vscode", label: "VS Code", subtitle: "Also GitHub Copilot" },
  { id: "codex", label: "Codex" },
  { id: "json", label: "Other clients", subtitle: "Claude Desktop and .mcp.json" },
];

export interface Recipe {
  client: ClientId;
  command?: string;
  config?: { language: "json" | "toml"; path: string; text: string };
  deeplink?: string;
  login: string;
}

export interface RecipeInput {
  client: ClientId;
  reach: Reach;
  strictApproval: boolean;
  project: string;
}

export const SERVER_NAME = "extension-dev";
export const PACKAGE = "@extension.dev/mcp";

/* @invariant
 * EVERY SETUP STRING IS BUILT HERE AND NOWHERE ELSE.
 *
 * The console's Connect dialog, the README's Setup section and therefore www's
 * /mcp page (which renders the published README) all read these recipes, so an
 * instruction cannot drift between them. Each option changes what the server
 * actually does, or it is not offered: the project pin, --no-ship,
 * --features=local and EXTENSION_DEV_APPROVAL_GATE=1 are all read by the
 * server. There is deliberately no way to emit EXTENSION_DEV_APPROVAL_GATE=0;
 * turning human approval off stays a README-only, by-hand decision. Strict approval is only meaningful when the agent can ship, so
 * it is dropped for the other two reaches. A local-only server reads no login,
 * so it is not pinned. The server's own default is the local group alone
 * (DEFAULT_SERVER_OPTIONS), so the two reaches that need the platform name
 * both groups explicitly. The local reach keeps naming its group too, so
 * the recipe reads the same against a server published before the flip.
 */
export function serverArgs(input: Omit<RecipeInput, "client">): string[] {
  const args = [PACKAGE];
  if (input.reach !== "local") args.push("--features=local,platform");
  if (input.reach !== "local" && input.project) args.push("--project", input.project);
  if (input.reach === "no-ship") args.push("--no-ship");
  if (input.reach === "local") args.push("--features=local");

  return args;
}

export function serverEnv(input: Omit<RecipeInput, "client">): Record<string, string> {
  return input.reach === "everything" && input.strictApproval
    ? { EXTENSION_DEV_APPROVAL_GATE: "1" }
    : {};
}

const shellQuote = (value: string): string =>
  /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`;

const base64 = (text: string): string =>
  typeof btoa === "function"
    ? btoa(text)
    : (globalThis as { Buffer?: { from(s: string): { toString(e: string): string } } })
        .Buffer!.from(text)
        .toString("base64");

const tomlString = (value: string): string => JSON.stringify(value);

export function loginCommand(project: string): string {
  return `npx ${PACKAGE} login --project ${shellQuote(project)}`;
}

export function buildRecipe(input: RecipeInput): Recipe {
  const args = serverArgs(input);
  const env = serverEnv(input);
  const envEntries = Object.entries(env);
  const stdio = {
    command: "npx",
    args,
    ...(envEntries.length ? { env } : {}),
  };
  const login = loginCommand(input.project);
  const argLine = args.map(shellQuote).join(" ");

  switch (input.client) {
    case "claude-code":
      return {
        client: "claude-code",
        command: [
          "claude mcp add",
          SERVER_NAME,
          ...envEntries.map(([k, v]) => `-e ${k}=${shellQuote(v)}`),
          "-- npx",
          argLine,
        ].join(" "),
        login,
      };
    case "cursor":
      return {
        client: "cursor",
        deeplink: `https://cursor.com/en/install-mcp?name=${SERVER_NAME}&config=${encodeURIComponent(
          base64(JSON.stringify(stdio)),
        )}`,
        config: {
          language: "json",
          path: ".cursor/mcp.json",
          text: JSON.stringify({ mcpServers: { [SERVER_NAME]: stdio } }, null, 2),
        },
        login,
      };

    case "vscode": {
      const named = { name: SERVER_NAME, ...stdio };

      return {
        client: "vscode",
        command: `code --add-mcp ${shellQuote(JSON.stringify(named))}`,
        deeplink: `vscode:mcp/install?${encodeURIComponent(JSON.stringify(named))}`,
        config: {
          language: "json",
          path: ".vscode/mcp.json",
          text: JSON.stringify(
            { servers: { [SERVER_NAME]: { type: "stdio", ...stdio } } },
            null,
            2,
          ),
        },
        login,
      };
    }

    case "codex": {
      const lines = [
        `[mcp_servers.${SERVER_NAME}]`,
        `command = "npx"`,
        `args = [${args.map(tomlString).join(", ")}]`,
      ];

      if (envEntries.length) {
        lines.push("", `[mcp_servers.${SERVER_NAME}.env]`);
        for (const [k, v] of envEntries) lines.push(`${k} = ${tomlString(v)}`);
      }

      return {
        client: "codex",
        command: [
          "codex mcp add",
          SERVER_NAME,
          ...envEntries.map(([k, v]) => `--env ${k}=${shellQuote(v)}`),
          "-- npx",
          argLine,
        ].join(" "),
        config: { language: "toml", path: "~/.codex/config.toml", text: lines.join("\n") },
        login,
      };
    }

    case "json":
      return {
        client: "json",
        config: {
          language: "json",
          path: ".mcp.json",
          text: JSON.stringify({ mcpServers: { [SERVER_NAME]: stdio } }, null, 2),
        },
        login,
      };
  }
}
