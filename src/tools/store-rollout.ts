// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { awaitRecordedOutcome, dispatchedHint, madeSentence, missedRead, stampNow } from "../lib/act-outcome";
import { envelope } from "../lib/envelope";
import { readSubmissionRecord, type PlatformSubmission, type SubmissionDispatch } from "../lib/platform-submissions";
import { projectApiGet } from "../lib/project-api";
import { badShipRequest, isRow, openShipApi, runShipAct, text } from "../lib/ship-act";
import { actLinks, judgeCancel, judgeRollout, trackOf } from "../lib/store-act-outcome";
import { COMMAND, storeOf, storesRead, type Row, type StoreActArgs } from "./store-acts";

export async function cancelSubmission(args: StoreActArgs): Promise<string> {
  const picked = storeOf(args, "cancel");
  if ("refused" in picked) return picked.refused;

  const submissionId = text(args.submissionId);

  if (!submissionId) {
    return badShipRequest(COMMAND, "cancel", "CancelInputError", `cancel needs submissionId, the platform's id of the submission to withdraw from review; ${storesRead(args)} lists them. Nothing was sent.`);
  }

  const { store } = picked;
  const opened = await openShipApi(COMMAND, args, { action: "cancel", store, submissionId });
  if ("refused" in opened) return opened.refused;

  const ran = await runShipAct(
    {
      command: COMMAND,
      act: "cancel",
      action: "extension_store.cancel",
      route: `stores/${store}/submissions/${encodeURIComponent(submissionId)}/cancel`,
      body: {},
      approvalId: args.approvalId,
      description: `Withdraw ${store} store submission ${submissionId} from review.`,
      reason: "The store stops reviewing it and it goes back to a draft, so a workspace owner approves withdrawing this exact submission first.",
      stateRead: storesRead(args),
      scopeFits: (asked) => text(asked.store) === store && Boolean(text(asked.submissionId)),
      project: args.project,
      apiHint: args.api,
      value: { store, submissionId },
    },
    opened.api,
  );

  if (!ran.ok) return ran.out;

  const acceptedAt = text(ran.json.dispatchedAt) || stampNow();
  const { dispatch: sentDispatch, ...answered } = ran.json;
  const base: Row = { action: "cancel", ...answered };
  const links = actLinks(COMMAND, { ...args, action: "cancel" } as Row, "canceled", base, [], "submission");
  const trackUrl = trackOf(links);
  const waited = await awaitRecordedOutcome<PlatformSubmission>({
    waitSeconds: args.waitSeconds,
    read: () => readSubmissionRecord(opened.api, { submissionId, store }),
    judge: judgeCancel,
  });
  const made = madeSentence(links);
  const dispatch = dispatchState(waited.record?.dispatch ?? sentDispatch);

  if (waited.failed) {
    const reason = dispatch.failedReason || "the withdrawal run failed before the store answered";
    const say = `The withdrawal failed at the store: ${reason}. ${dispatch.refunded ? "The approval was refunded." : "The approval was not refunded."} Say status to read the store's current state.`;

    return envelope({
      ok: false,
      command: COMMAND,
      status: "cancel-failed",
      value: { ...base, dispatch, outcome: waited.outcome, links, trackUrl, sayToPerson: say },
      error: { code: "E_PLATFORM", name: "CancelFailed", message: `The withdrawal of submission ${submissionId} failed at the store: ${reason}` },
      hint: `${say} ${storesRead(args)} reads the record the platform settled from the store. ${made}`,
    });
  }

  if (waited.outcome.recorded) {
    return envelope({
      ok: true,
      command: COMMAND,
      status: "canceled",
      value: { ...base, dispatch, outcome: waited.outcome, links, trackUrl },
      hint: `The platform's record of submission ${submissionId} now reads ${waited.outcome.status}, so it is out of the store's review. ${storesRead(args)} reads it again. ${made}`,
    });
  }

  return envelope({
    ok: true,
    command: COMMAND,
    status: "cancel-dispatched",
    value: { ...base, dispatch, outcome: waited.outcome, links, trackUrl },
    hint: `${dispatchedHint({ acceptedAt, trackUrl, readCall: storesRead(args) })} ${made}`,
  });
}

/* @invariant `value.dispatch` IS A STATE: runState, the step and the store's
 * reason when it failed, and whether the approval came back. The platform's
 * record also names the run and its page; neither is answered here.
 */
function dispatchState(raw: unknown): SubmissionDispatch {
  const row = isRow(raw) ? raw : {};
  const typed = row as Partial<SubmissionDispatch> & { refundedAt?: unknown };

  return {
    runState: text(typed.runState) || "unknown",
    ...(text(typed.failedStep) ? { failedStep: text(typed.failedStep) } : {}),
    ...(text(typed.failedReason) ? { failedReason: text(typed.failedReason) } : {}),
    refunded: typed.refunded === true || Boolean(text(typed.refundedAt)),
  };
}

export async function raiseRollout(args: StoreActArgs): Promise<string> {
  const picked = storeOf(args, "rollout");
  if ("refused" in picked) return picked.refused;

  const raw = args.deployPercentage;
  const percentage = typeof raw === "string" && raw.trim() !== "" ? Number(raw) : raw;

  if (typeof percentage !== "number" || !Number.isInteger(percentage) || percentage < 1 || percentage > 100) {
    return badShipRequest(COMMAND, "rollout", "RolloutInputError", `rollout needs deployPercentage, a whole number from 1 to 100 above the current rollout; got ${JSON.stringify(raw ?? null)}. Nothing was sent.`);
  }

  const { store } = picked;
  const opened = await openShipApi(COMMAND, args, { action: "rollout", store, deployPercentage: percentage });
  if ("refused" in opened) return opened.refused;

  const ran = await runShipAct(
    {
      command: COMMAND,
      act: "rollout",
      action: "extension_store.rollout",
      route: `stores/${store}/rollout`,
      body: { deployPercentage: percentage },
      approvalId: args.approvalId,
      description: `Raise the ${store} store's staged rollout to ${percentage}% of users.`,
      reason: "This is irreversible: the store does not let a rollout be lowered again from here, so a workspace owner approves this exact percentage first.",
      stateRead: 'extension_release_status (include: ["rollout"])',
      irreversible: true,
      scopeFits: (asked) => text(asked.store) === store && text(asked.deployPercentage) === String(percentage),
      project: args.project,
      apiHint: args.api,
      value: { store, deployPercentage: percentage },
    },
    opened.api,
  );

  if (!ran.ok) return ran.out;

  const acceptedAt = text(ran.json.dispatchedAt) || stampNow();
  const base: Row = { action: "rollout", ...ran.json };
  const links = actLinks(COMMAND, { ...args, action: "rollout" } as Row, "rolled-out", base);
  const trackUrl = trackOf(links);
  const rolloutRead = 'extension_release_status (include: ["rollout"])';
  const waited = await awaitRecordedOutcome<Row>({
    waitSeconds: args.waitSeconds,
    read: async () => {
      const read = await projectApiGet<Row>(opened.api, `stores/${store}/rollout`);
      if (!read.ok) return missedRead(read);

      return { ok: true, record: isRow(read.json.rollout) ? read.json.rollout : {} };
    },
    judge: judgeRollout(percentage),
  });
  const made = madeSentence(links);

  if (waited.outcome.recorded) {
    return envelope({
      ok: true,
      command: COMMAND,
      status: "rolled-out",
      value: { ...base, outcome: waited.outcome, links },
      hint: `The platform's rollout record now reads ${percentage}% of users. ${rolloutRead} reads it again. ${made}`,
    });
  }

  return envelope({
    ok: true,
    command: COMMAND,
    status: "rollout-dispatched",
    value: { ...base, outcome: waited.outcome, links },
    hint: `${dispatchedHint({ acceptedAt, trackUrl, readCall: rolloutRead })} ${made}`,
  });
}
