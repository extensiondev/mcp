// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// MIT License (c) Cezar Augusto and the extension.dev collaborators

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { version } from "../package.json";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import * as create from "./tools/create";
import * as listTemplates from "./tools/list-templates";
import * as build from "./tools/build";
import * as dev from "./tools/dev";
import * as start from "./tools/start";
import * as preview from "./tools/preview";
import * as stop from "./tools/stop";

import * as getTemplateSource from "./tools/get-template-source";
import * as manifestValidate from "./tools/manifest-validate";
import * as inspect from "./tools/inspect";
import * as sourceInspect from "./tools/source-inspect";
import * as listExtensions from "./tools/list-extensions";
import * as logs from "./tools/logs";
import * as evalTool from "./tools/eval";
import * as storage from "./tools/storage";
import * as reload from "./tools/reload";
import * as open from "./tools/open";
import * as domInspect from "./tools/dom-inspect";
import * as publish from "./tools/publish";
import * as releasePromote from "./tools/release-promote";
import * as wait from "./tools/wait";
import * as addFeature from "./tools/add-feature";

import * as login from "./tools/login";
import * as whoami from "./tools/whoami";
import * as logout from "./tools/logout";
import { pollForToken, startDeviceCode } from "./lib/github-device";
import {
  exchangeAndPersist,
  fetchLoginConfig,
  resolveApiBase,
} from "./lib/login-flow";

import * as installBrowser from "./tools/install-browser";
import * as uninstallBrowser from "./tools/uninstall-browser";
import * as listBrowsers from "./tools/list-browsers";
import * as detectBrowsers from "./tools/detect-browsers";
import * as doctor from "./tools/doctor";
import {
  inputValidationError,
  validateToolInput,
} from "./lib/validate-input";

export interface ToolModule {
  schema: {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
  };
  handler: (args: any) => Promise<string>;
}

export const tools: ToolModule[] = [
  create,
  listTemplates,
  build,
  dev,
  start,
  preview,
  stop,
  getTemplateSource,
  manifestValidate,
  inspect,
  sourceInspect,
  listExtensions,
  logs,
  evalTool,
  storage,
  reload,
  open,
  domInspect,
  publish,
  releasePromote,
  wait,
  addFeature,
  login,
  whoami,
  logout,
  installBrowser,
  uninstallBrowser,
  listBrowsers,
  detectBrowsers,
  doctor,
];

const toolMap = new Map<string, ToolModule>();

for (const tool of tools) {
  toolMap.set(tool.schema.name, tool);
}

export async function startServer(): Promise<void> {
  const server = new Server(
    {
      name: "extension-dev",
      version,
    },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: tools.map((t) => ({
        name: t.schema.name,
        description: t.schema.description,
        inputSchema: t.schema.inputSchema,
      })),
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const tool = toolMap.get(name);

    if (!tool) {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              error: `Unknown tool: ${name}`,
              availableTools: tools.map((t) => t.schema.name),
            }),
          },
        ],
        isError: true,
      };
    }

    const issues = validateToolInput(
      tool.schema.inputSchema,
      (args ?? {}) as Record<string, unknown>,
    );
    if (issues.length) {
      return {
        content: [
          {
            type: "text" as const,
            text: inputValidationError(name, issues),
          },
        ],
        isError: true,
      };
    }

    try {
      const result = await tool.handler(args ?? {});
      return {
        content: [
          {
            type: "text" as const,
            text: result,
          },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              error: err instanceof Error ? err.message : String(err),
              tool: name,
            }),
          },
        ],
        isError: true,
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

export async function runCli(cmd: string, args: string[]): Promise<number> {
  const log = (msg: string) => process.stderr.write(`${msg}\n`);

  const flag = (name: string): string | undefined => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
  };

  if (cmd === "whoami") {
    log(await whoami.handler());
    return 0;
  }

  if (cmd === "release") {
    const sub = String(args[0] || "").trim();
    if (sub === "promote") {
      const buildId = String(flag("build") || flag("build-id") || "").trim();
      const channel = String(flag("channel") || "").trim();
      if (!buildId || !channel) {
        log(
          "Usage: extension-mcp release promote --build <sha> --channel <channel> [--source-channel <c>] [--version <v>] [--api <url>]",
        );
        return 1;
      }
      const out = await releasePromote.handler({
        buildId,
        channel,
        sourceChannel: flag("source-channel"),
        version: flag("version"),
        api: flag("api"),
      });
      log(out);
      let parsed: any = null;
      try {
        parsed = JSON.parse(out);
      } catch {
        parsed = null;
      }
      return parsed?.ok === false ? 1 : 0;
    }
    log(
      "Usage: extension-mcp release promote --build <sha> --channel <channel>",
    );
    return 1;
  }

  if (cmd === "logout") {
    log(await logout.handler());
    return 0;
  }

  if (cmd === "login") {
    const project = String(flag("project") || "").trim();
    if (!/^[^/]+\/[^/]+$/.test(project)) {
      log("Usage: extension-mcp login --project <workspace>/<project> [--api <url>]");
      return 1;
    }
    const apiBase = resolveApiBase(flag("api"));
    try {
      const config = await fetchLoginConfig(apiBase);
      const start = await startDeviceCode({
        clientId: config.clientId,
        scope: config.scope,
      });
      log("");
      log(`  Open ${start.verificationUri} and enter code: ${start.userCode}`);
      log("");
      log("  Waiting for authorization...");
      const poll = await pollForToken({
        clientId: config.clientId,
        deviceCode: start.deviceCode,
        interval: start.interval,
        budgetMs: start.expiresIn * 1000,
      });
      if (!poll.ok) {
        log(
          poll.reason === "denied"
            ? "Authorization was denied on GitHub."
            : "Timed out waiting for authorization. Run login again.",
        );
        return 1;
      }
      const creds = await exchangeAndPersist({
        apiBase,
        githubToken: poll.githubToken,
        project,
      });
      log(`Logged in to ${creds.workspaceSlug}/${creds.projectSlug}.`);
      return 0;
    } catch (err: unknown) {
      log(err instanceof Error ? err.message : String(err));
      return 1;
    }
  }

  log(
    `Unknown command: ${cmd}. Expected one of: login, logout, whoami, release.`,
  );
  return 1;
}
