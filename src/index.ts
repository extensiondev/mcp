// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { version } from "../package.json";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import * as create from "./tools/create";
import * as templates from "./tools/templates";
import * as build from "./tools/build";
import * as dev from "./tools/dev";
import * as start from "./tools/start";
import * as previewWeb from "./tools/preview-web";
import * as shares from "./tools/shares";
import * as stop from "./tools/stop";

import * as manifestValidate from "./tools/manifest-validate";
import * as themeVerify from "./tools/theme-verify";
import * as analyze from "./tools/analyze";
import * as inspect from "./tools/inspect";
import * as listExtensions from "./tools/list-extensions";
import * as logs from "./tools/logs";
import * as evalTool from "./tools/eval";
import * as storage from "./tools/storage";
import * as reload from "./tools/reload";
import * as open from "./tools/open";
import * as domSnapshot from "./tools/dom-snapshot";
import * as publish from "./tools/publish";
import * as releasePromote from "./tools/release-promote";
import * as releaseStatus from "./tools/release-status";
import * as submitTool from "./tools/submit";
import * as wait from "./tools/wait";
import * as addFeature from "./tools/add-feature";

import * as auth from "./tools/auth";
import { readIdentity } from "./tools/whoami";
import { clearLocalCredentials } from "./tools/logout";
import { requestDeviceCode, pollDeviceToken } from "./lib/device-flow";
import { fetchLoginConfig, resolveApiBase } from "./lib/login-flow";

import * as browsers from "./tools/browsers";
import * as doctor from "./tools/doctor";
import {
  inputValidationError,
  normalizeArgAliases,
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
  templates,
  build,
  dev,
  start,
  previewWeb,
  shares,
  stop,
  manifestValidate,
  themeVerify,
  analyze,
  inspect,
  listExtensions,
  logs,
  evalTool,
  storage,
  reload,
  open,
  domSnapshot,
  publish,
  releaseStatus,
  releasePromote,
  submitTool,
  wait,
  addFeature,
  auth,
  browsers,
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

    const normalizedArgs = normalizeArgAliases(
      tool.schema.inputSchema,
      (args ?? {}) as Record<string, unknown>,
    );
    const issues = validateToolInput(tool.schema.inputSchema, normalizedArgs);
    if (issues.length) {
      return {
        content: [
          {
            type: "text" as const,
            text: inputValidationError(name, issues, tool.schema.inputSchema),
          },
        ],
        isError: true,
      };
    }

    try {
      const result = await tool.handler(normalizedArgs);
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
    log(await readIdentity());
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
    log(await clearLocalCredentials());
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

      const start = await requestDeviceCode({
        apiBase,
        path: config.deviceCodeUrl,
        project,
      });
      log("");
      log(`  Open ${start.verificationUri} and enter code: ${start.userCode}`);
      log("");
      log("  Waiting for authorization...");
      const poll = await pollDeviceToken({
        apiBase,
        path: config.deviceTokenUrl,
        project,
        deviceCode: start.deviceCode,
        interval: start.interval,
        budgetMs: start.expiresIn * 1000,
      });
      if (!poll.ok) {
        log(
          poll.reason === "denied"
            ? "Authorization was denied at extension.dev/device."
            : poll.reason === "expired"
              ? "The device code expired. Run login again."
              : "Timed out waiting for authorization. Run login again.",
        );
        return 1;
      }
      log(`Logged in to ${poll.creds.workspaceSlug}/${poll.creds.projectSlug}.`);
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
