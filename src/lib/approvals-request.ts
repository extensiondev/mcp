// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { AsyncLocalStorage } from "node:async_hooks";

import { envelope, isEnvelope, reframed } from "./envelope";
import { SUBMIT_SETTING_ACTIONS, SUBMIT_SHIP_ACTIONS, submitCheckRefusal } from "./submit-action-safety";
import { TOOL_TWINS } from "./tool-twins";
import { fenceUntrusted } from "./untrusted-fence";

type Args = Record<string, unknown>;

export const APPROVALS_REQUEST_TOOL = "extension_approvals_request";

/* @invariant ASKING FOR AN APPROVAL IS ITS OWN CALL, AND THE ACT IS ANOTHER
 * (Cezar, 2026-11-25, ledger 1193). Claude Code's auto mode judges a call by
 * its tool name and arguments alone, so a first call of extension_submit or
 * of a public set-visibility read as the act and was refused before the
 * server saw it, although it only asked for the owner's approval. A request
 * now goes through extension_approvals_request, whose name and arguments say
 * what it is, and the act tool runs only the call that carries the approved
 * id. Each act lists the actions that wait on an approval page; every other
 * action is refused here before anything runs, so a request never performs a
 * plain write. A write the platform asks an approval for that the server did
 * not foresee (a plain verdict, or a gate marked unforeseen) still mints on
 * the act's call, since no request could have known to ask for it.
 */
export const REQUESTABLE_ACTS: Readonly<Record<string, readonly string[]>> = {
  extension_submit: ["submit", ...SUBMIT_SHIP_ACTIONS, ...SUBMIT_SETTING_ACTIONS],
  extension_release_promote: [],
  extension_workspace_configure: ["set-visibility", "configure-project", "rename-slug"],
  extension_shares_manage: ["revoke"],
  extension_builds_act: ["create-channel", "configure-channel"],
};

export const REQUESTABLE_TOOLS = Object.keys(REQUESTABLE_ACTS);

const DEFAULT_ACTION: Record<string, string> = { extension_submit: "submit" };

interface ActCall {
  act: string;
  args: Args;
  requested: boolean;
}

const acting = new AsyncLocalStorage<ActCall>();

export function actCall(): ActCall | undefined {
  return acting.getStore();
}

export function runAsAct<T>(call: ActCall, run: () => Promise<T>): Promise<T> {
  return acting.run(call, run);
}

/* @invariant A FORWARDER THAT LISTS NO REQUEST TOOL KEEPS ITS INLINE ASK. An
 * 11.3.0 or older forwarder has no extension_approvals_request to call, so
 * the lane runs its calls as asked: a first act call mints the approval as
 * it did, and only a forwarder that serves the request tool is sent to it.
 */
export function runWithInlineAsk<T>(run: () => Promise<T>): Promise<T> {
  return acting.run({ act: "", args: {}, requested: true }, run);
}

const actionOf = (args: Args): string => (typeof args.action === "string" ? args.action : "");

function actOf(name: string, args: Args): string | null {
  if (REQUESTABLE_ACTS[name]) return name;

  const twin = TOOL_TWINS.find((candidate) => candidate.of === name && REQUESTABLE_ACTS[candidate.name] && candidate.actions.includes(actionOf(args) || candidate.actions[0]!));

  return twin ? twin.name : null;
}

export function requestableAct(name: string, args: Args): string | null {
  const act = actOf(name, args);
  if (!act) return null;

  const actions = REQUESTABLE_ACTS[act]!;
  const action = actionOf(args) || DEFAULT_ACTION[act] || "";

  return actions.length === 0 || actions.includes(action) ? act : null;
}

export function shownArgs(args: Args, properties: Record<string, unknown> | undefined): Args {
  return Object.fromEntries(Object.entries(args).filter(([key]) => key !== "approvalId" && (!properties || key in properties)));
}

export function requestedArgs(args: Args): Args {
  const inner = args.args && typeof args.args === "object" && !Array.isArray(args.args) ? (args.args as Args) : {};

  return args.act === "extension_submit" && (inner.action === undefined || inner.action === "submit") ? { ...inner, dryRun: false } : inner;
}

function refusal(message: string, value: Args = {}): string {
  return envelope({
    ok: false,
    command: APPROVALS_REQUEST_TOOL,
    status: "request-refused",
    error: { code: "E_BAD_REQUEST", name: "RequestRefused", message: `${message} Nothing was asked and nothing ran.` },
    value,
  });
}

export function approvalsRequestRefused(args: Args): string | null {
  const act = typeof args.act === "string" ? args.act : "";
  const actions = REQUESTABLE_ACTS[act];

  if (!actions) return refusal(`act names the tool that runs the act once approved: ${REQUESTABLE_TOOLS.join(", ")}.`, { acts: REQUESTABLE_TOOLS });

  const inner = requestedArgs(args);

  if (typeof inner.approvalId === "string" && inner.approvalId.trim()) {
    return refusal(`args carries approvalId ${inner.approvalId.trim()}, which is already the approval: call ${act} with these args to run it.`, { useTool: act });
  }

  const action = actionOf(inner) || DEFAULT_ACTION[act] || "";

  if (actions.length && !actions.includes(action)) {
    return refusal(`${act} ${action || "with no action"} runs without an approval page, so call ${act} directly. The actions that ask are ${actions.join(", ")}.`, { useTool: act, actions });
  }

  if (act === "extension_submit") {
    const reason = submitCheckRefusal(inner);

    if (reason) return refusal(reason.replace(/ Nothing was sent\.$/, ""), { useTool: act });
  }

  return null;
}

export function requestFirst(command: string, call: ActCall): { blocked: true; envelope: string } {
  const request = { act: call.act, args: call.args };

  return {
    blocked: true,
    envelope: envelope({
      ok: false,
      command,
      status: "approval-not-requested",
      error: {
        code: "E_APPROVAL_REQUIRED",
        name: "ApprovalNotRequested",
        message: `This act waits on a workspace owner's approval, and this call carried none, so nothing ran and no approval was asked. ${APPROVALS_REQUEST_TOOL} asks for it.`,
      },
      value: { requestWith: { tool: APPROVALS_REQUEST_TOOL, arguments: request } },
      hint: `Call ${APPROVALS_REQUEST_TOOL} ${JSON.stringify(request)}; once the owner approves, call ${call.act} again with the same arguments and the approvalId it answers.`,
    }),
  };
}

export function withRunWhenApproved(out: string, act: string, args: Args): string {
  let parsed: unknown;

  try {
    parsed = JSON.parse(out);
  } catch {
    return out;
  }

  if (!isEnvelope(parsed)) return out;

  const value = parsed.value && typeof parsed.value === "object" ? (parsed.value as Args) : null;
  const approvalId = typeof value?.approvalId === "string" ? value.approvalId : "";
  if (!value || !approvalId) return out;

  const { schema: _schema, untrusted: _untrusted, untrustedEnd: _untrustedEnd, ...frame } = parsed as typeof parsed & { untrusted?: unknown; untrustedEnd?: unknown };
  const answer = reframed({ ...frame, value: { ...value, runWhenApproved: { tool: act, arguments: { ...args, approvalId } } } });

  return "untrustedEnd" in parsed ? fenceUntrusted(answer) : answer;
}

export function hostToolOf(act: string): string {
  return TOOL_TWINS.find((twin) => twin.name === act)?.of ?? act;
}
