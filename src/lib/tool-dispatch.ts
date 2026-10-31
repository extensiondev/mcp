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
import { withCallWaits } from "./call-waits";
import { envelope } from "./envelope";
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
import { createReloader, handoverState, type ActiveBuild, type BuildImporter, type ListedTool, type RebuiltCall, type ToolFrame } from "./server-reload";
import { markListStale, reloadedWarning, serverStamp, staleEnvelope, type ServerStampReader } from "./server-stamp";
import { markStaleLocal, noLocalCarryReason, predatedChecks, predatesCheckEnvelope, type HeldLocal } from "./stale-local";
import { shapeStoreAnswer } from "./store-answer";
import { annotate, frameText, refusedFrame, toolResultFrame } from "./tool-frames";
import { attachTrack } from "./track-url";
import {
  inputValidationError,
  type InputIssue,
  normalizeArgAliases,
  validateToolInput,
} from "./validate-input";

import type { Server } from "@modelcontextprotocol/sdk/server/index.js";

export type { ToolFrame } from "./server-reload";
export { annotate, toolResultFrame } from "./tool-frames";

export interface ToolModule {
  schema: {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
  };
  handler: (args: any) => Promise<string>;
  invalidArgumentsHint?: (issues: InputIssue[]) => string | undefined;
}

export interface ToolHandlerOptions {
  tools: ToolModule[];
  options: ServerOptions;
  refuse?: (name: string, args: Record<string, unknown>) => string | null;
  run?: (call: () => Promise<string>, name: string, args: Record<string, unknown>) => Promise<string>;
  openApprovals?: boolean;
  stamp?: ServerStampReader;
  importBuild?: BuildImporter;
  onToolsChanged?: () => void;
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

export function listedTools(tools: ToolModule[], options: ServerOptions): ListedTool[] {
  return tools
    .filter((t) => isToolListed(t.schema.name, options))
    .map((t) => ({ name: t.schema.name, description: t.schema.description, inputSchema: t.schema.inputSchema }));
}

export function createToolDispatcher(setup: ToolHandlerOptions): (call: RebuiltCall) => Promise<ToolFrame> {
  return createToolSurface(setup).dispatch;
}

export function createToolSurface(setup: ToolHandlerOptions): {
  dispatch: (call: RebuiltCall) => Promise<ToolFrame>;
  list: () => Promise<ListedTool[]>;
} {
  const { tools, options } = setup;
  const toolMap = new Map(tools.map((tool) => [tool.schema.name, tool]));
  const run = setup.run ?? ((call: () => Promise<string>) => call());
  const stamp = setup.stamp ?? serverStamp;
  const reloader = createReloader({
    entry: stamp.entry,
    importBuild: setup.importBuild ?? null,
    handover: () => handoverState(options),
  });
  const loadedAt = stamp.stamp().builtAt;
  let listedAt: string | null = loadedAt;
  let announced: string | null = null;

  const refused = (text: string): ToolFrame => refusedFrame(stamp.brand(text));

  const list = async (): Promise<ListedTool[]> => {
    const loaded = listedTools(tools, options);
    const rebuilt = stamp.rebuiltSince();
    listedAt = loadedAt;
    if (!rebuilt) return loaded;

    const active = await reloader.activate(rebuilt);
    const fresh = "reloadError" in active ? null : await reloader.list(rebuilt);
    if (!fresh || "reloadError" in active) return loaded;

    listedAt = rebuilt;
    const byName = new Map(fresh.map((tool) => [tool.name, tool]));
    const follows = (name: string): boolean => active.local || TOOL_POLICY[name]?.group === "platform";
    const known = new Set(loaded.map((tool) => tool.name));
    const added = active.local ? fresh.filter((tool) => !known.has(tool.name)) : [];

    return [
      ...loaded.map((tool) => {
        const next = follows(tool.name) ? byName.get(tool.name) : undefined;

        return next ? { name: tool.name, description: next.description, inputSchema: next.inputSchema } : tool;
      }),
      ...added,
    ];
  };

  /* @invariant A SERVER THAT KNOWS IT IS STALE RELOADS ITS CODE INSTEAD OF
   * REFUSING. The operation rebuilds this server from source several times
   * a night, and until ledger 248 every rebuild stopped the walk until the
   * owner ran /mcp by hand: five times in one evening. Now, when the entry
   * file on disk is newer than the one this process loaded, a call imports
   * the rebuilt dist/module.js under a stamped specifier (the bundle is one
   * file, so nothing beside it comes back from the loader's cache) and is
   * answered by that build's own dispatcher, while this process keeps the
   * transport, the stdio pair and the tool list the client was given. What
   * crosses over: the server options (features, noShip, the project pin),
   * the kept default login per store and server, and, since ledger 300, the
   * local state by reference (the session registry, the remembered
   * extension targets, the one-recovery-per-session set), handed from the
   * active generation to the next, so a session a previous generation
   * spawned is found, stopped and guarded by the build answering now. What
   * the new code reads from disk as it is: the credential store,
   * approvals.json, the created-project records and the session markers.
   * What stays here: the opened-approvals set, so an approval page opens
   * once across generations. What is rebuilt: the project id cache,
   * refilled from the platform's whoami. A tool the rebuild reshaped is
   * listed from the build that validates its calls (ledger 285), a tool the
   * rebuild added is listed and dispatched from it; while the client holds a
   * list an older build served, every reloaded answer carries
   * value.server.listStale with the build it was listed at and a hint to
   * list again, and the client is told the list changed once per build
   * (ledger 289). The first answer after each reload says so in warnings,
   * once. E_SERVER_STALE remains only when the reload fails (no loader, an
   * import error, a build without the reload contract, a refused handover),
   * with value.reloadError saying why and the /mcp sentence as the last
   * resort; a local tool then stays on the loaded code, as it does when the
   * build on disk cannot adopt this process's sessions, and every one of its
   * answers says so (stale-local.ts).
   */
  const answeredByRebuilt = async (call: RebuiltCall, rebuilt: string, untrusted: boolean): Promise<ToolFrame | { reloadError: string }> => {
    const outcome = await reloader.dispatch(call, rebuilt);
    if ("reloadError" in outcome) return outcome;

    const stale = listedAt !== rebuilt;

    if (stale && announced !== rebuilt) {
      announced = rebuilt;
      setup.onToolsChanged?.();
    }

    const text = frameText(outcome.frame);
    const said = annotate(
      setup.openApprovals ? openApprovalOnce(text, options) : text,
      outcome.reloaded ? { warning: reloadedWarning(outcome.reloaded) } : {},
    );
    const told = stale ? markListStale(said, listedAt, rebuilt) : said;

    return told === text ? outcome.frame : toolResultFrame(told, untrusted);
  };

  const heldLocal = (rebuilt: string, active: ActiveBuild | { reloadError: string }, failure: string | null): HeldLocal =>
    "reloadError" in active
      ? { rebuilt, reason: active.reloadError, version: null, assertChecks: null }
      : { rebuilt, reason: failure ?? noLocalCarryReason(rebuilt), version: active.version, assertChecks: active.assertChecks };

  const dispatch = async ({ name, arguments: args }: RebuiltCall): Promise<ToolFrame> => {
    const tool = toolMap.get(name);
    const rebuilt = stamp.rebuiltSince();

    if (!tool) {
      if (rebuilt) {
        const active = await reloader.activate(rebuilt);
        const answered = !("reloadError" in active) && active.local ? await answeredByRebuilt({ name, arguments: args }, rebuilt, false) : null;

        if (answered && !("reloadError" in answered)) return answered;
      }

      return refused(
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

    if (disabled) return refused(disabled);

    const untrusted = TOOL_POLICY[name]?.untrusted === true;
    const platform = TOOL_POLICY[name]?.group === "platform";
    const refusedAct = (text: string, callArgs: Record<string, unknown>): ToolFrame => refused(platform ? attachTrack(name, callArgs, text) : text);
    const pinned = pinProjectArgs(name, aliasedArgs, tool.schema.inputSchema, options);

    if ("refused" in pinned) return refusedAct(pinned.refused, aliasedArgs);

    let held: HeldLocal | null = null;

    if (rebuilt) {
      const active = await reloader.activate(rebuilt);
      let failure: string | null = "reloadError" in active ? active.reloadError : null;

      if (!("reloadError" in active) && (platform || active.local)) {
        const answered = await answeredByRebuilt({ name, arguments: pinned.args }, rebuilt, untrusted);
        if (!("reloadError" in answered)) return answered;

        failure = answered.reloadError;
      }

      if (platform) {
        return toolResultFrame(
          attachTrack(name, pinned.args, staleEnvelope(name, rebuilt, stamp.stamp(), pinned.args, failure ?? undefined)),
          untrusted,
        );
      }

      held = heldLocal(rebuilt, active, failure);
    }

    const bound = bindApprovalProject(name, pinned.args);

    if ("refused" in bound) return refusedAct(bound.refused, pinned.args);

    const normalizedArgs = bound.args;
    const issues = validateToolInput(tool.schema.inputSchema, normalizedArgs);

    if (issues.length) {
      return refusedAct(inputValidationError(name, issues, tool.schema.inputSchema, tool.invalidArgumentsHint?.(issues)), normalizedArgs);
    }

    const predated = held ? predatedChecks(name, normalizedArgs, held) : [];

    if (held && predated.length) return refusedFrame(predatesCheckEnvelope(name, predated, stamp.stamp(), held));

    const login = bindApprovalLogin(name, normalizedArgs);

    if ("refused" in login) return refusedAct(login.refused, normalizedArgs);

    try {
      const result = await withCallApi(normalizedArgs.api, () =>
        withApprovalLogin(login.login, () =>
        run(
          async () => {
            if (!platform) return annotate(await withCallWaits(() => tool.handler(normalizedArgs)), { note: bound.note });

            const scoped = bindCallProject(name, normalizedArgs, tool.schema.inputSchema, options);

            if ("refused" in scoped) return stamp.apply(attachTrack(name, normalizedArgs, scoped.refused));

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

      return toolResultFrame(held ? markStaleLocal(result, stamp.stamp(), held) : stamp.brand(result), untrusted);
    } catch (err) {
      return toolResultFrame(
        stamp.brand(
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
        ),
        untrusted,
      );
    }
  };

  return { dispatch, list };
}

export function installToolHandlers(server: Server, setup: ToolHandlerOptions): void {
  const surface = createToolSurface({
    ...setup,
    onToolsChanged: () => {
      setup.onToolsChanged?.();
      server.sendToolListChanged().catch(() => undefined);
    },
  });
  const dispatch = surface.dispatch;

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: (await surface.list()).map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
      annotations: { title: toolTitle(t.name), ...(TOOL_POLICY[t.name]?.annotations ?? {}) },
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => dispatch(request.params));
}
