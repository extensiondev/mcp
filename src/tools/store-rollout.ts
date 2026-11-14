// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { awaitRecordedOutcome, dispatchedHint, madeSentence, missedRead, stampNow } from "../lib/act-outcome";
import { envelope } from "../lib/envelope";
import { readStoreActByHand, readSubmissionRecord, readSubmissionsInReview, type PlatformSubmission, type StoreActByHand, type SubmissionDispatch } from "../lib/platform-submissions";
import { byHandFields, storeActByHandAnswer } from "../lib/store-act-by-hand";
import { projectApiGet, type ProjectApi } from "../lib/project-api";
import { badShipRequest, isRow, openShipApi, runShipAct, text } from "../lib/ship-act";
import { actLinks, judgeCancel, judgeRollout, trackOf } from "../lib/store-act-outcome";
import { COMMAND, storeOf, storesRead, type Row, type StoreActArgs } from "./store-acts";

const STORE_TITLES: Record<string, string> = {
  chrome: "Chrome Web Store",
  edge: "Edge Add-ons",
  firefox: "Firefox Add-ons",
  safari: "App Store",
};

function cancelByHand(store: string, submissionId: string, byHand: StoreActByHand): string {
  const title = STORE_TITLES[store] ?? store;
  const subject = store === "safari" ? "Removing a version from App Review" : `Withdrawing a ${title} submission from review`;
  const say = `${subject} does not run on the extension.dev platform yet, so nothing was sent and no approval was asked for. ${byHand.handPath ? `To do it now, ${byHand.handPath}.` : `Withdraw it in the ${title}'s own dashboard.`}`;

  return envelope({
    ok: false,
    command: COMMAND,
    status: "cancel-by-hand",
    value: {
      action: "cancel",
      store,
      ...(submissionId ? { submissionId } : {}),
      refusedBeforeApproval: true,
      ...byHandFields(say, byHand),
    },
    error: { code: "E_PLATFORM", name: "CancelNotOnPlatform", message: say },
    hint: say,
  });
}

async function submissionInReview(api: ProjectApi, store: string, args: StoreActArgs, recordedByHand = false): Promise<{ submissionId: string } | { refused: string }> {
  const read = await readSubmissionsInReview(api, store, { recordedByHand });
  const refuse = (why: string) => ({
    refused: badShipRequest(COMMAND, "cancel", "CancelInputError", `${why} Nothing was sent.`),
  });

  if (read.ok && read.byHand) return { refused: cancelByHand(store, "", read.byHand) };

  if (!read.ok) return refuse(`cancel without submissionId reads the ${store} submission in review, and that read failed: ${read.message}. Pass submissionId; ${storesRead(args)} lists them.`);

  const ids = (read.record ?? []).map((row) => text(row.id));

  if (ids.length === 1) return { submissionId: ids[0]! };
  if (!ids.length) return refuse(`There is no ${store} submission in review to withdraw; ${storesRead(args)} reads each store's latest submission and its review state.`);

  const calls = ids.map((id) => `extension_submit {action: "cancel", store: "${store}", submissionId: "${id}"}`).join(" or ");

  return refuse(`${ids.length} ${store} submissions are in review, so cancel needs the one to withdraw: ${calls}.`);
}

/* @invariant AN EDGE CANCEL IS RECORDED, NEVER SENT. The platform cannot
 * withdraw an Edge review, and Partner Center's Publish API keeps reading
 * SUCCEEDED after "Cancel submission" was pressed there, so the platform's
 * Edge lock stood on a review that ended (ledger 570 and 677). Cezar's
 * ruling of 2026-11-14: the person records it. So a cancel for Edge names
 * the one submission the platform reads as in review and asks a workspace
 * owner to approve the record of a cancel made by hand, in words that say
 * where to cancel first and that nothing is sent; the platform writes who
 * and when, clears the lock, and corrects the record if the store later
 * serves that version. Nothing here calls Partner Center.
 */
async function recordHandCancel(args: StoreActArgs, store: string): Promise<string> {
  const named = text(args.submissionId);
  const opened = await openShipApi(COMMAND, args, { action: "cancel", store, canceledByHand: true, ...(named ? { submissionId: named } : {}) });
  if ("refused" in opened) return opened.refused;

  const resolved = named ? { submissionId: named } : await submissionInReview(opened.api, store, args, true);
  if ("refused" in resolved) return resolved.refused;

  const { submissionId } = resolved;
  const ran = await runShipAct(
    {
      command: COMMAND,
      act: "cancel",
      action: "extension_store.cancel",
      route: `stores/${store}/submissions/${encodeURIComponent(submissionId)}/cancel/by-hand`,
      body: {},
      approvalId: args.approvalId,
      description: `Record that the Edge review of submission ${submissionId} was canceled by hand in Partner Center.`,
      reason: 'The platform cannot cancel an Edge review and Partner Center does not say when one is canceled there, so a workspace owner approves recording this exact cancel. Approve only once it is canceled: open the extension in Partner Center and choose "Cancel submission". Nothing is sent to Partner Center.',
      stateRead: storesRead(args),
      scopeFits: (asked) => text(asked.store) === store && text(asked.submissionId) === submissionId && text(asked.byHand) === "partner-center",
      project: args.project,
      apiHint: args.api,
      value: { store, submissionId, canceledByHand: true },
    },
    opened.api,
  );

  if (!ran.ok) return ran.out;

  const recorded = isRow(ran.json.handCancel) ? ran.json.handCancel : {};
  const by = text(recorded.recordedBy);
  const at = text(recorded.recordedAt) || stampNow();
  const say = `Recorded${by ? ` by ${by}` : ""} at ${at}: the Edge review of submission ${submissionId} was canceled by hand in Partner Center. The Edge lock is clear, so a new version can be sent now; nothing was sent to Partner Center, and the record is corrected to published if Edge Add-ons later serves that version.`;

  return envelope({
    ok: true,
    command: COMMAND,
    status: "cancel-recorded",
    value: {
      action: "cancel",
      store,
      submissionId,
      canceledByHand: true,
      ...(by ? { recordedBy: by } : {}),
      recordedAt: at,
      lockCleared: ran.json.lockCleared === true,
      sayToPerson: say,
    },
    hint: `${say} extension_submit_check {action: "submit", browsers: ["edge"]} reads the Edge line again.`,
  });
}

export async function cancelSubmission(args: StoreActArgs): Promise<string> {
  const picked = storeOf(args, "cancel");
  if ("refused" in picked) return picked.refused;

  const { store } = picked;

  if (store === "edge") return recordHandCancel(args, store);

  const safari = store === "safari";
  const named = text(args.submissionId);
  const opened = await openShipApi(COMMAND, args, { action: "cancel", store, ...(named ? { submissionId: named } : {}) });
  if ("refused" in opened) return opened.refused;

  const byHand = named && !text(args.approvalId) ? await readStoreActByHand(opened.api, store, "cancel") : null;
  if (byHand) return cancelByHand(store, named, byHand);

  const resolved = named ? { submissionId: named } : await submissionInReview(opened.api, store, args);
  if ("refused" in resolved) return resolved.refused;

  const { submissionId } = resolved;

  const ran = await runShipAct(
    {
      command: COMMAND,
      act: "cancel",
      action: "extension_store.cancel",
      route: `stores/${store}/submissions/${encodeURIComponent(submissionId)}/cancel`,
      body: {},
      approvalId: args.approvalId,
      description: safari ? `Remove Safari submission ${submissionId} from App Review.` : `Withdraw ${store} store submission ${submissionId} from review.`,
      reason: safari
        ? "Apple stops reviewing the version and its build stays on TestFlight, so a workspace owner approves removing this exact version from App Review first."
        : "The store stops reviewing it and it goes back to a draft, so a workspace owner approves withdrawing this exact submission first.",
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
    const apple = safari ? appleWithdrawStates(waited.record?.storeReview, waited.outcome.storeState) : null;

    return envelope({
      ok: true,
      command: COMMAND,
      status: "canceled",
      value: {
        ...base,
        dispatch,
        outcome: waited.outcome,
        ...(apple?.versionState ? { versionState: apple.versionState } : {}),
        ...(apple?.reviewSubmissionState ? { reviewSubmissionState: apple.reviewSubmissionState } : {}),
        links,
        trackUrl,
      },
      hint: safari
        ? `The platform's record of submission ${submissionId} now reads ${waited.outcome.status}${apple?.sentence ?? ""}, so it is out of App Review; its build stays on TestFlight and a new build can go to App Review with publish. ${storesRead(args)} reads it again. ${made}`
        : `The platform's record of submission ${submissionId} now reads ${waited.outcome.status}, so it is out of the store's review. ${storesRead(args)} reads it again. ${made}`,
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

const REVIEW_SUBMISSION_STATES = new Set(["COMPLETE", "CANCELING", "CANCELED"]);

/* @invariant A WITHDRAWAL NAMES APPLE'S VERSION STATE AND THE REVIEW
 * SUBMISSION'S STATE EACH AS WHAT IT IS. Rebeccat's withdrawal of 2026-10-28
 * was answered "App Store Connect reads the version as COMPLETE", and
 * COMPLETE was the review submission's state, not the version's
 * (DEVELOPER_REJECTED). The record carries both since registry-template
 * 0f0c2fd; an older record's COMPLETE or CANCELING is said to be the review
 * submission's, with the version's own state left to the next store poll.
 */
function appleWithdrawStates(
  review: { state?: string; versionState?: string; reviewSubmissionState?: string } | undefined,
  storeState: string | null | undefined,
): { versionState: string; reviewSubmissionState: string; sentence: string } {
  const state = text(review?.state || storeState).toUpperCase();
  const submissionWord = REVIEW_SUBMISSION_STATES.has(state);
  const versionState = text(review?.versionState).toUpperCase() || (submissionWord ? "" : state);
  const reviewSubmissionState = text(review?.reviewSubmissionState).toUpperCase() || (submissionWord ? state : "");
  const submission = reviewSubmissionState ? `its App Review submission as ${reviewSubmissionState}` : "";
  const sentence = versionState
    ? ` and App Store Connect reads the version as ${versionState}${submission ? ` and ${submission}` : ""}`
    : submission
      ? ` and App Store Connect reads ${submission}; the version's own state is not recorded yet and the next store poll records it`
      : "";

  return { versionState, reviewSubmissionState, sentence };
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

  const byHand = text(args.approvalId) ? null : await readStoreActByHand(opened.api, store, "rollout");
  if (byHand) return storeActByHandAnswer({ command: COMMAND, action: "rollout", store, subject: `Raising the ${STORE_TITLES[store] ?? store} staged rollout`, hand: byHand, value: { deployPercentage: percentage } });

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
