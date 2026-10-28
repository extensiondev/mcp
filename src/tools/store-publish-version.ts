// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { ConsoleProjectPage } from "@extension.dev/urls/paths";

import { approvalGateEnabled, evaluateApproval } from "../lib/approval-gate";
import {
  VERSION_ACTION,
  linesSentence,
  readLines,
  storesInState,
  versionScopeFor,
  type ApprovalLineRow,
} from "../lib/approval-lines";
import { envelope, isEnvelope } from "../lib/envelope";
import { projectApiReadFailure, projectApiSend, tokenRefusal } from "../lib/project-api";
import { consoleProjectUrl } from "../lib/registry";
import { badShipRequest, isRow, openShipApi, text } from "../lib/ship-act";
import { nextStep } from "../lib/store-connection";

type Row = Record<string, unknown>;

export interface PublishVersionArgs {
  buildSha?: string;
  version?: string;
  approvalId?: string;
  project?: string;
  api?: string;
}

const COMMAND = "extension_submit";

const REVIEWERS: Record<string, string> = { chrome: "Chrome", edge: "Microsoft", safari: "Apple" };

const storesRead = (args: PublishVersionArgs) =>
  `extension_release_status (include: ["stores"]${args.project ? `, project: "${args.project}"` : ""})`;

type StoreRow = {
  store: string;
  status: string;
  code?: string;
  message?: string;
  submissionId?: string;
  trackUrl?: string;
  version?: string;
  buildId?: string;
  approvalRefunded?: boolean;
  lines: ApprovalLineRow[];
};

function withApproveStep(out: string, stores: string[]): string {
  let parsed: unknown;

  try {
    parsed = JSON.parse(out);
  } catch {
    return out;
  }

  if (!isEnvelope(parsed) || parsed.status !== "approval-required") return out;

  const value = isRow(parsed.value) ? parsed.value : {};
  const approvalUrl = text(value.approvalUrl);

  if (!approvalUrl) return out;

  const expiresAt = text(value.expiresAt);
  const say = `Approve sending the ${stores.join(", ")} drafts to review at ${approvalUrl}${expiresAt ? ` before ${expiresAt}` : ""}. The page lists one line per store; uncheck a store to leave it out. Nothing changes for current users until each store approves its draft.`;

  return envelope({
    ok: parsed.ok,
    command: parsed.command,
    status: parsed.status,
    value: { ...value, nextStep: nextStep("approve", say, approvalUrl) },
    error: parsed.error,
    warnings: parsed.warnings,
    ...(parsed.truncated !== undefined ? { truncated: parsed.truncated } : {}),
    ...(parsed.hint ? { hint: parsed.hint } : {}),
  });
}

/* @invariant A PUBLISH OF SEVERAL STORES IS ONE APPROVAL PER VERSION, LIKE A
 * SUBMIT OF SEVERAL STORES. The caller names the build whose drafts are sent,
 * so the owner's page names it and the platform refuses a draft of another
 * build; the grant's scope is that build and one "<store>:publish" line per
 * store; the call resumed with the approval sends each store's draft on its
 * own route and reports per store what the platform answered: queued behind
 * a review with the line still pending, dispatched with the line spent,
 * refused with the line's state, or given back when the dispatch never
 * started.
 */
export async function publishVersion(args: PublishVersionArgs, stores: string[]): Promise<string> {
  const buildSha = text(args.buildSha);

  if (!buildSha) {
    return badShipRequest(
      COMMAND,
      "publish",
      "PublishInputError",
      `A publish of several stores (${stores.join(", ")}) is one approval for one version, so pass buildSha, the build whose drafts are sent; extension_builds lists the shas. Nothing was sent.`,
    );
  }

  const opened = await openShipApi(COMMAND, args, { action: "publish", stores, buildSha });
  if ("refused" in opened) return opened.refused;

  const api = opened.api;
  const version = text(args.version);
  const gate = await evaluateApproval({
    command: COMMAND,
    action: VERSION_ACTION,
    scope: versionScopeFor(stores.map((store) => ({ store, act: "publish" })), buildSha, version),
    description: `Send the ${stores.join(", ")} drafts of build ${buildSha}${version ? ` (version ${version})` : ""} to each store's review under one approval, one line per store that the owner can leave out. Nothing changes for current users until each store approves its draft.`,
    approvalId: args.approvalId,
    token: api.token,
    api: args.api,
    refusedStatus: "publish-failed",
    irreversible: true,
    enabled: approvalGateEnabled(true),
    stateRead: storesRead(args),
  });

  if (gate.blocked) return withApproveStep(gate.envelope, stores);

  const approvalId = gate.approvalId ?? text(args.approvalId);
  const context = { workspace: api.ref.workspace, project: `${api.ref.workspace}/${api.ref.project}` };
  const rows: StoreRow[] = [];

  for (const store of stores) {
    const sent = await projectApiSend<Row>(api, "POST", `stores/${store}/publish`, { approvalId });

    if (sent.ok) {
      const json = isRow(sent.json) ? sent.json : {};
      const queued = text(json.status) === "publish-queued";

      rows.push({
        store,
        status: queued ? "publish-queued" : "publish-dispatched",
        ...(text(json.submissionId) ? { submissionId: text(json.submissionId) } : {}),
        ...(text(json.trackUrl) ? { trackUrl: text(json.trackUrl) } : {}),
        ...(text(json.version) ? { version: text(json.version) } : {}),
        ...(text(json.buildId) ? { buildId: text(json.buildId) } : {}),
        ...(queued && isRow(json.queued) && text(json.queued.message) ? { message: text(json.queued.message) } : {}),
        lines: readLines(json.lines).length ? readLines(json.lines) : [{ id: `${store}:publish`, store, act: "publish", state: queued ? "queued" : "spent" }],
      });

      continue;
    }

    if (sent.held || sent.status === 0 || tokenRefusal(sent.code, context)) {
      return projectApiReadFailure(COMMAND, sent, {
        api: args.api,
        name: "Ship",
        value: { action: "publish", stores, approvalId },
        context,
      });
    }

    const body = isRow(sent.body) ? sent.body : {};

    rows.push({
      store,
      status: "refused",
      code: sent.code,
      message: sent.message,
      ...(body.approvalRefunded === true ? { approvalRefunded: true } : {}),
      lines: readLines(body.lines),
    });
  }

  const lines = rows.flatMap((row) => row.lines);
  const byStore: Row = Object.fromEntries(rows.map((row) => [row.store, row]));
  const sent = rows.filter((row) => row.status !== "refused");
  const queued = rows.filter((row) => row.status === "publish-queued");
  const refused = rows.filter((row) => row.status === "refused");
  const storesPageUrl = consoleProjectUrl(api.ref, ConsoleProjectPage.submissions, args.api);
  const retry = [...storesInState(lines, "refunded"), ...refused.filter((row) => row.approvalRefunded && !row.lines.length).map((row) => row.store)];
  const say = [
    sent.length
      ? `${sent.map((row) => `${row.store}: ${row.status === "publish-queued" ? `queued, ${row.message || "sent once the store's review clears"}` : `on its way to ${REVIEWERS[row.store] ?? "the store"}'s review`}`).join("; ")}.`
      : "",
    refused.length ? `${refused.map((row) => `${row.store}: ${row.message || row.code || "refused"}`).join("; ")}.` : "",
    `Approval lines: ${linesSentence(lines)}.`,
    retry.length ? `Call again with the same approvalId ${approvalId} and browsers limited to ${retry.join(", ")}.` : "",
    `Follow each store at ${storesPageUrl}; ${storesRead(args)} reads the record. Nothing changes for current users until each store approves its draft.`,
  ]
    .filter(Boolean)
    .join(" ");
  const status = sent.length === 0 ? "publish-failed" : queued.length === rows.length ? "publish-queued" : "publish-dispatched";

  return envelope({
    ok: sent.length > 0,
    command: COMMAND,
    status,
    value: {
      action: "publish",
      buildSha,
      ...(version ? { version } : {}),
      approvalId,
      stores: byStore,
      lines,
      trackUrl: storesPageUrl,
      sayToPerson: say,
      nextStep: nextStep("done", say, storesPageUrl),
    },
    ...(sent.length === 0
      ? {
          error: {
            code: "E_PLATFORM",
            name: "PublishRefused",
            message: `No store's draft was sent to review: ${refused.map((row) => `${row.store}: ${row.message || row.code}`).join("; ")}.`,
          },
        }
      : {}),
    hint: say,
    warnings: refused.map((row) => `NOT sent: ${row.store}: ${row.message || row.code}.`),
  });
}
