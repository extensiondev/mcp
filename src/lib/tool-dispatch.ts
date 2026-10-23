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

import { openApprovalOnce } from "./approval-open";
import { bindApprovalProject } from "./approval-record";
import { envelope, isEnvelope, type Envelope } from "./envelope";
import {
  TOOL_POLICY,
  disabledToolEnvelope,
  isToolListed,
  pinProjectArgs,
  type ServerOptions,
  toolTitle,
} from "./tool-policy";
import { withCallApi } from "./origins";
import { scrubRunAnswer } from "./run-privacy";
import { serverStamp } from "./server-stamp";
import { shapeStoreAnswer } from "./store-answer";
import { attachTrack } from "./track-url";
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
  openApprovals?: boolean;
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

export function withNote(result: string, note: string | undefined): string {
  if (!note) return result;

  let parsed: unknown;

  try {
    parsed = JSON.parse(result);
  } catch {
    return result;
  }

  if (!isEnvelope(parsed)) return result;

  const frame = parsed as Envelope & { hint?: string };
  const value = frame.value && typeof frame.value === "object" && !Array.isArray(frame.value) ? (frame.value as Record<string, unknown>) : {};
  const said = typeof value.note === "string" && value.note.trim() ? `${value.note.trim()} ${note}` : note;

  return envelope({
    ok: frame.ok,
    command: frame.command,
    status: frame.status,
    value: { ...value, note: said },
    error: frame.error ?? undefined,
    warnings: frame.warnings,
    ...(frame.truncated !== undefined ? { truncated: frame.truncated } : {}),
    ...(frame.hint ? { hint: frame.hint } : {}),
  });
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
        annotations: { title: toolTitle(t.schema.name), ...TOOL_POLICY[t.schema.name].annotations },
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

    const bound = bindApprovalProject(name, pinned.args);

    if ("refused" in bound) return refusedFrame(bound.refused);

    const normalizedArgs = bound.args;
    const issues = validateToolInput(tool.schema.inputSchema, normalizedArgs);

    if (issues.length) {
      return refusedFrame(inputValidationError(name, issues, tool.schema.inputSchema));
    }

    const untrusted = TOOL_POLICY[name]?.untrusted === true;

    try {
      const platform = TOOL_POLICY[name]?.group === "platform";
      const result = await withCallApi(normalizedArgs.api, () =>
        run(
          async () => {
            const answer = withNote(await tool.handler(normalizedArgs), bound.note);

            if (!platform) return answer;

            const shaped = serverStamp.apply(scrubRunAnswer(attachTrack(name, normalizedArgs, shapeStoreAnswer(name, normalizedArgs, answer))));

            return setup.openApprovals ? openApprovalOnce(shaped, options) : shaped;
          },
          name,
          normalizedArgs,
        ),
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
