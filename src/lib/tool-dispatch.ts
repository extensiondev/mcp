// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { envelope, isEnvelope } from "./envelope";
import {
  TOOL_POLICY,
  disabledToolEnvelope,
  isToolListed,
  pinProjectArgs,
  type ServerOptions,
} from "./tool-policy";
import { withCallApi } from "./origins";
import { fenceUntrusted } from "./untrusted-fence";
import {
  inputValidationError,
  normalizeArgAliases,
  validateToolInput,
} from "./validate-input";

import type { Server } from "@modelcontextprotocol/sdk/server/index.js";

export interface ToolModule {
  schema: {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
  };
  handler: (args: any) => Promise<string>;
}

export interface ToolHandlerOptions {
  tools: ToolModule[];
  options: ServerOptions;
  refuse?: (name: string, args: Record<string, unknown>) => string | null;
  run?: (call: () => Promise<string>, name: string, args: Record<string, unknown>) => Promise<string>;
}

type ToolFrame = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

function isEnvelopeText(result: string): boolean {
  try {
    return isEnvelope(JSON.parse(result));
  } catch {
    return false;
  }
}

export function toolResultFrame(result: string, untrusted = false): ToolFrame {
  let refused: boolean;

  try {
    const parsed: unknown = JSON.parse(result);
    refused = isEnvelope(parsed) && parsed.ok === false;
  } catch {
    refused = false;
  }

  return {
    content: [
      {
        type: "text" as const,
        text: untrusted ? fenceUntrusted(result) : result,
      },
    ],
    ...(refused || (untrusted && !isEnvelopeText(result)) ? { isError: true } : {}),
  };
}

function refusedFrame(text: string): ToolFrame {
  return { content: [{ type: "text" as const, text }], isError: true };
}

export function installToolHandlers(server: Server, setup: ToolHandlerOptions): void {
  const { tools, options } = setup;
  const toolMap = new Map(tools.map((tool) => [tool.schema.name, tool]));
  const run = setup.run ?? ((call: () => Promise<string>) => call());

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools
      .filter((t) => isToolListed(t.schema.name, options))
      .map((t) => ({
        name: t.schema.name,
        description: t.schema.description,
        inputSchema: t.schema.inputSchema,
        annotations: TOOL_POLICY[t.schema.name].annotations,
      })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const tool = toolMap.get(name);

    if (!tool) {
      return refusedFrame(
        envelope({
          ok: false,
          command: name,
          status: "unknown-tool",
          error: {
            code: "E_UNKNOWN_TOOL",
            message: `Unknown tool: ${name}`,
          },
          value: {
            availableTools: tools
              .map((t) => t.schema.name)
              .filter((toolName) => isToolListed(toolName, options)),
          },
        }),
      );
    }

    const aliasedArgs = normalizeArgAliases(
      tool.schema.inputSchema,
      (args ?? {}) as Record<string, unknown>,
    );
    const disabled =
      disabledToolEnvelope(name, aliasedArgs, options) ?? setup.refuse?.(name, aliasedArgs) ?? null;

    if (disabled) return refusedFrame(disabled);

    const pinned = pinProjectArgs(name, aliasedArgs, tool.schema.inputSchema, options);

    if ("refused" in pinned) return refusedFrame(pinned.refused);

    const normalizedArgs = pinned.args;
    const issues = validateToolInput(tool.schema.inputSchema, normalizedArgs);

    if (issues.length) {
      return refusedFrame(inputValidationError(name, issues, tool.schema.inputSchema));
    }

    const untrusted = TOOL_POLICY[name]?.untrusted === true;

    try {
      const result = await withCallApi(normalizedArgs.api, () =>
        run(() => tool.handler(normalizedArgs), name, normalizedArgs),
      );

      return toolResultFrame(result, untrusted);
    } catch (err) {
      return toolResultFrame(
        envelope({
          ok: false,
          command: name,
          status: "internal-error",
          error: {
            code: "E_INTERNAL",
            name: err instanceof Error ? err.name : "Error",
            message: err instanceof Error ? err.message : String(err),
          },
        }),
        untrusted,
      );
    }
  });
}
