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

import { bindApprovalLogin } from "./approval-login";
import { openApprovalOnce } from "./approval-open";
import { answerOnceDecided } from "./approval-wait";
import { bindApprovalProject } from "./approval-record";
import { withApprovalLogin } from "./approval-scope";
import { envelope, isEnvelope, type Envelope } from "./envelope";
import { resolveApiBase } from "./login-flow";
import {
  TOOL_POLICY,
  disabledToolEnvelope,
  isToolListed,
  pinProjectArgs,
  type ServerOptions,
  toolTitle,
} from "./tool-policy";
import { withCallApi } from "./origins";
import { bindCallProject, stampAnsweredFor } from "./project-binding";
import { followProjectMove, followSentence, movedAnswer } from "./project-move";
import { scrubRunAnswer } from "./run-privacy";
import { createReloader, handoverState, type BuildImporter, type RebuiltCall, type ToolFrame } from "./server-reload";
import { localRebuiltWarning, reloadedWarning, serverStamp, staleEnvelope, type ServerStampReader } from "./server-stamp";
import { shapeStoreAnswer } from "./store-answer";
import { attachTrack } from "./track-url";
import { fenceUntrusted } from "./untrusted-fence";
import {
  inputValidationError,
  normalizeArgAliases,
  validateToolInput,
} from "./validate-input";

import type { Server } from "@modelcontextprotocol/sdk/server/index.js";

export type { ToolFrame } from "./server-reload";

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
  stamp?: ServerStampReader;
  importBuild?: BuildImporter;
}

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

export function annotate(result: string, said: { note?: string; warning?: string }): string {
  if (!said.note && !said.warning) return result;

  let parsed: unknown;

  try {
    parsed = JSON.parse(result);
  } catch {
    return result;
  }

  if (!isEnvelope(parsed)) return result;

  const frame = parsed as Envelope & { hint?: string };
  const value = frame.value && typeof frame.value === "object" && !Array.isArray(frame.value) ? (frame.value as Record<string, unknown>) : {};
  const note = said.note ? (typeof value.note === "string" && value.note.trim() ? `${value.note.trim()} ${said.note}` : said.note) : undefined;

  return envelope({
    ok: frame.ok,
    command: frame.command,
    status: frame.status,
    value: note ? { ...value, note } : frame.value,
    error: frame.error ?? undefined,
    warnings: [...frame.warnings, said.warning],
    ...(frame.truncated !== undefined ? { truncated: frame.truncated } : {}),
    ...(frame.hint ? { hint: frame.hint } : {}),
  });
}

/* @invariant A PLATFORM ANSWER THAT NAMES WHERE THE PROJECT WENT IS FOLLOWED
 * ONCE, IN THE SAME CALL. The refusal already moved the login; this server's
 * created record and pin follow it, the call is made again naming the
 * current slug, and the answer says once that the server follows the new
 * name. The second answer is taken as it is: a move it names in turn is not
 * followed, so two renames in one call cannot chase each other.
 */
async function followedOnce(
  answer: string,
  args: Record<string, unknown>,
  handler: (args: Record<string, unknown>) => Promise<string>,
): Promise<string> {
  const move = movedAnswer(answer);
  if (!move) return answer;

  followProjectMove({ apiBase: resolveApiBase(typeof args.api === "string" ? args.api : undefined), move });

  return annotate(await handler({ ...args, project: move.to }), { warning: followSentence(move) });
}

export function createToolDispatcher(setup: ToolHandlerOptions): (call: RebuiltCall) => Promise<ToolFrame> {
  const { tools, options } = setup;
  const toolMap = new Map(tools.map((tool) => [tool.schema.name, tool]));
  const run = setup.run ?? ((call: () => Promise<string>) => call());
  const stamp = setup.stamp ?? serverStamp;
  const reloader = createReloader({
    entry: stamp.entry,
    importBuild: setup.importBuild ?? null,
    handover: () => handoverState(options),
  });
  let localSaid: string | null = null;

  return async ({ name, arguments: args }) => {
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

    const untrusted = TOOL_POLICY[name]?.untrusted === true;
    const platform = TOOL_POLICY[name]?.group === "platform";
    const rebuilt = stamp.rebuiltSince();

    /* @invariant A SERVER THAT KNOWS IT IS STALE RELOADS ITS PLATFORM CODE
     * INSTEAD OF REFUSING. The operation rebuilds this server from source
     * several times a night, and until ledger 248 every rebuild stopped the
     * walk until the owner ran /mcp by hand: five times in one evening. Now,
     * when the entry file on disk is newer than the one this process loaded,
     * a platform call imports the rebuilt dist/module.js under a stamped
     * specifier (the bundle is one file, so nothing beside it comes back
     * from the loader's cache) and is answered by that build's own
     * dispatcher, while this process keeps the transport, the stdio pair and
     * the tool list the client was given. What crosses over: the server
     * options (features, noShip, the project pin) and the kept default login
     * per store and server, handed from the active generation to the next,
     * so a login made through a reloaded build travels on. What the new code
     * reads from disk as it is: the credential store, approvals.json, the
     * created-project records and the session markers. What stays here: the
     * opened-approvals set, so an approval page opens once across
     * generations. What is rebuilt: the project id cache, refilled from the
     * platform's whoami. A tool the rebuild added or reshaped still needs
     * /mcp, since the client holds the list this process announced. The
     * first answer after each reload says so in warnings, once.
     * E_SERVER_STALE remains only when the reload fails (no loader, an
     * import error, a build without the reload contract, a refused
     * handover), with value.reloadError saying why and the /mcp sentence as
     * the last resort. Local tools stay on the loaded code: their dev
     * sessions, child processes and open targets live in this module's
     * memory and a reload would orphan them, so a rebuilt server warns once
     * per build that /mcp picks up their new code.
     */
    if (rebuilt && platform) {
      const outcome = await reloader.dispatch({ name, arguments: pinned.args }, rebuilt);

      if ("reloadError" in outcome) {
        return toolResultFrame(
          attachTrack(name, pinned.args, staleEnvelope(name, rebuilt, stamp.stamp(), pinned.args, outcome.reloadError)),
          untrusted,
        );
      }

      const text = outcome.frame.content[0]?.text ?? "";
      const said = annotate(
        setup.openApprovals ? openApprovalOnce(text, options) : text,
        outcome.reloaded ? { warning: reloadedWarning(outcome.reloaded) } : {},
      );

      return said === text ? outcome.frame : toolResultFrame(said, untrusted);
    }

    const bound = bindApprovalProject(name, pinned.args);

    if ("refused" in bound) return refusedFrame(bound.refused);

    const normalizedArgs = bound.args;
    const issues = validateToolInput(tool.schema.inputSchema, normalizedArgs);

    if (issues.length) {
      return refusedFrame(inputValidationError(name, issues, tool.schema.inputSchema));
    }

    const held = bindApprovalLogin(name, normalizedArgs);

    if ("refused" in held) return refusedFrame(held.refused);

    try {
      const result = await withCallApi(normalizedArgs.api, () =>
        withApprovalLogin(held.login, () =>
        run(
          async () => {
            if (!platform) return annotate(await tool.handler(normalizedArgs), { note: bound.note });

            const scoped = bindCallProject(name, normalizedArgs, tool.schema.inputSchema, options);

            if ("refused" in scoped) return stamp.apply(scoped.refused);

            const callArgs = scoped.args;
            const answered = await answerOnceDecided(callArgs, tool.handler);
            const followed = await followedOnce(answered, callArgs, tool.handler);
            const answer = annotate(annotate(followed, { note: bound.note }), { note: scoped.note });
            const shaped = stamp.apply(
              scrubRunAnswer(attachTrack(name, callArgs, shapeStoreAnswer(name, callArgs, stampAnsweredFor(answer, scoped.answeredFor)))),
            );

            return setup.openApprovals ? openApprovalOnce(shaped, options) : shaped;
          },
          name,
          normalizedArgs,
        ),
        ),
      );

      if (rebuilt && localSaid !== rebuilt) {
        localSaid = rebuilt;

        return toolResultFrame(annotate(result, { warning: localRebuiltWarning(rebuilt) }), untrusted);
      }

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
  };
}

export function installToolHandlers(server: Server, setup: ToolHandlerOptions): void {
  const { tools, options } = setup;
  const dispatch = createToolDispatcher(setup);

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

  server.setRequestHandler(CallToolRequestSchema, async (request) => dispatch(request.params));
}
