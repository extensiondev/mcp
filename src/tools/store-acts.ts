// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { ConsoleProjectPage } from "@extension.dev/urls/paths";

import {
  awaitRecordedOutcome,
  dispatchedHint,
  linksOf,
  madeSentence,
  stampNow,
} from "../lib/act-outcome";
import { approvalSubjectPhrase, subjectOf } from "../lib/approval-subject";
import { envelope, isEnvelope } from "../lib/envelope";
import {
  firefoxConnectSentences,
  firefoxConnectUrl,
  firefoxKeyPairFailedSentences,
  firefoxKeyPairState,
  firefoxKeyPairUnverifiedSentences,
  firefoxWorkspaceKeyPairSentences,
  firefoxNotConnected,
  firefoxSourceArchiveLine,
  firefoxSourceArchiveView,
} from "../lib/firefox-store";
import {
  readSubmissionRecord,
  type PlatformSubmission,
} from "../lib/platform-submissions";
import { compactPreflightStores, PREFLIGHT_DETAIL_SENTENCE, preflightDetail } from "../lib/preflight-detail";
import { consoleProjectUrl } from "../lib/registry";
import { projectApiReadFailure, projectApiSend } from "../lib/project-api";
import { actLinks, judgePublish, publishFailureReason, trackOf } from "../lib/store-act-outcome";
import {
  badShipRequest,
  isRow,
  openShipApi,
  runShipAct,
  text,
} from "../lib/ship-act";
import {
  ITEM_NOT_LINKED_CODE,
  NOT_CONNECTED_CODES,
  PUBLISH_APPROVAL_SENTENCE,
  WORKSPACE_RECONNECT_STATE,
  connectSentences,
  connectionOf,
  connectionSourceOf,
  reportConnectionSource,
  workspaceAccountSentence,
  workspaceReconnectSentences,
  workspaceStoreAccountsUrl,
  failedCheckSentence,
  fallbackConnectUrl,
  itemLinkUrls,
  nextStep,
  storeSettingsUrl,
  storeSwitchOff,
  storeSwitchSentences,
  submitStep,
  uploadStopsAtDraft,
  type ModeIds,
} from "../lib/store-connection";
import {
  missingRequirementsSentences,
  requirementsView,
} from "../lib/store-requirements";
import { bringListOf, bringListSentences, screenshotDoor } from "../lib/store-bring-list";
import { notReadyForReviewStep, notReadyLine } from "../lib/store-not-ready";
import { nextVersionOf, nextVersionSentence } from "../lib/store-readiness";
import { LISTING_INCOMPLETE_CODE, listingIncompleteOf, listingIncompleteSentence } from "../lib/store-listing-incomplete";
import { chromeItemLeftOf } from "../lib/chrome-item-left";
import { linkItemAnswer } from "../lib/link-item-answer";
import { firefoxUpdateManifestOf, relayFirefoxUpdateUrl } from "../lib/firefox-update-url";
import { withHandUploadRows } from "../lib/hand-upload";
import { buildsReadByPackageChecks, packageBuildLine, packageBuildViews } from "../lib/package-checks-build";
import { releaseReadView, storePreflightChecks } from "../lib/store-preflight-checks";
import {
  EDGE_FIRST_SUBMISSION_STATE,
  edgeFirstSubmissionOf,
  firstSubmissionFromRefusal,
  firstSubmissionSentences,
  firstSubmissionStep,
  isEdgeCreateNotAllowed,
  partnerCenterProductUrl,
  publishRefusedMessage,
} from "../lib/edge-first-submission";
import {
  readLocalListing,
  reconciledWithStoreMd,
  storeMdAdvisory,
} from "./store-listing";
import { publishVersion } from "./store-publish-version";

import type { PackageScope } from "../lib/package-address";
import type { ListingStore } from "../lib/store-md-listing";
import type { LocalListingRead } from "../lib/store-requirements";

export const COMMAND = "extension_submit";
export const STORES = ["chrome", "firefox", "edge", "safari"] as const;

export type Row = Record<string, unknown>;

export interface StoreActArgs {
  action?: string;
  store?: string;
  browsers?: string[];
  submissionId?: string;
  buildNumber?: unknown;
  deployPercentage?: unknown;
  buildSha?: string;
  approvalId?: string;
  waitSeconds?: unknown;
  project?: string;
  projectPath?: string;
  detail?: unknown;
  api?: string;
}

export const storesRead = (args: StoreActArgs) =>
  `extension_release_status (include: ["stores"]${args.project ? `, project: "${args.project}"` : ""})`;

export function storeOf(
  args: StoreActArgs,
  act: string,
): { store: string } | { refused: string } {
  const store = text(args.store).toLowerCase() || "chrome";

  if (!(STORES as readonly string[]).includes(store)) {
    return {
      refused: badShipRequest(
        COMMAND,
        act,
        "StoreInputError",
        `store must be one of ${STORES.join(", ")}; got "${args.store}". Nothing was sent.`,
      ),
    };
  }

  return { store };
}

export const PUBLISH_ACTIONS = new Set(["publish", "review"]);

function reworded(
  out: string,
  api: { ref: { workspace: string; project: string } },
  apiHint: string | undefined,
  store: PublishStore = "chrome",
): string {
  let parsed: unknown;

  try {
    parsed = JSON.parse(out);
  } catch {
    return out;
  }

  if (!isEnvelope(parsed)) return out;

  const value = isRow(parsed.value) ? parsed.value : {};

  if (parsed.status === "approval-required") {
    const approvalUrl = text(value.approvalUrl);
    const expiresAt = text(value.expiresAt);
    const phrase = approvalSubjectPhrase(subjectOf(value));
    const words = storeWords(store);
    const say = [
      approvalUrl
        ? `Approve ${phrase ? `sending ${phrase} to ${words.reviewer}'s ${words.reviewWord}` : "it"} at ${approvalUrl}${expiresAt ? ` before ${expiresAt}` : ""}.`
        : "",
      publishApprovalSentence(store),
    ]
      .filter(Boolean)
      .join(" ");

    return envelope({
      ok: parsed.ok,
      command: parsed.command,
      status: parsed.status,
      value: {
        ...value,
        ...(expiresAt ? { expiresAt } : {}),
        sayToPerson: say,
        nextStep: nextStep("approve", say, approvalUrl),
      },
      error: parsed.error,
      warnings: parsed.warnings,
      hint: `${say}${text(value.approvalId) ? ` When the person says approved, call extension_submit again with action "publish" and approvalId ${text(value.approvalId)}.` : ""}`,
    });
  }

  const code = text(parsed.error?.platformCode);
  const settingsUrl = storeSettingsUrl(api.ref, apiHint);
  const incomplete = code === LISTING_INCOMPLETE_CODE ? listingIncompleteOf(code, value.listingIncomplete, store) : null;

  /* @invariant A LISTING REFUSAL IS A LIST, NEVER A RECORD. The platform
   * answers 409 LISTING_INCOMPLETE before it mints or consumes an approval,
   * so the answer carries the rows in the store's own words with the door
   * that clears each, the store's console page in trackUrl, and says that
   * nothing was sent, no approval was spent and no submission was recorded;
   * it never reads as publish-dispatched or in-review.
   */
  if (incomplete) {
    const words = storeWords(store);
    const trackUrl = consoleProjectUrl(api.ref, ConsoleProjectPage.submissionsStore(store), apiHint);
    const first = store === "edge" ? firstSubmissionFromRefusal(value.listingIncomplete, incomplete.missing) : null;

    /* @invariant A PRODUCT NEVER SUBMITTED THROUGH PARTNER CENTER IS ANSWERED
     * AS ITS OWN STATE, WITH THE DASHBOARD AS THE NEXT STEP. Microsoft's
     * Publish API cannot make the first submission (CreateNotAllowed), so no
     * STORE.md line and no sync-listing clears this row: the answer is
     * `first-submission-in-partner-center`, the product's Partner Center page
     * and the one-time steps, before any approval is asked for. */
    if (first) {
      const step = firstSubmissionStep(first, trackUrl);

      return envelope({
        ok: false,
        command: COMMAND,
        status: EDGE_FIRST_SUBMISSION_STATE,
        error: {
          code: "E_PLATFORM",
          name: "FirstSubmissionInPartnerCenter",
          platformCode: code,
          message: (isRow(value.listingIncomplete) ? text(value.listingIncomplete.message) : "") || step.say,
        },
        value: {
          action: "publish",
          store,
          refusedBeforeApproval: true,
          missing: incomplete.missing,
          ...(first.partnerCenterUrl ? { partnerCenterUrl: first.partnerCenterUrl } : {}),
          steps: first.steps,
          trackUrl,
          sayToPerson: step.say,
          nextStep: step,
        },
        hint: `${step.say} Once the product has been submitted there once, turn on "Submitted once in Partner Center" in the console Edge store settings (or wait for the platform to record the first publish Partner Center accepted), then say publish again.`,
      });
    }

    const say = `${listingIncompleteSentence(incomplete, words.name.charAt(0).toUpperCase() + words.name.slice(1))}${incomplete.bringList ? ` ${incomplete.bringList.say}` : ""}`;
    const needsImage = incomplete.missing.some((row) => /\.screenshots$/.test(row.id));

    return envelope({
      ok: false,
      command: COMMAND,
      status: "listing-incomplete",
      error: {
        code: "E_PLATFORM",
        name: "ListingIncomplete",
        platformCode: code,
        message: (isRow(value.listingIncomplete) ? text(value.listingIncomplete.message) : "") || say,
      },
      value: {
        action: "publish",
        store,
        refusedBeforeApproval: true,
        missing: incomplete.missing,
        ...(incomplete.bringList ? { bringList: incomplete.bringList } : {}),
        trackUrl,
        sayToPerson: say,
        nextStep: nextStep(needsImage ? "screenshot" : "sync-listing", say, trackUrl),
      },
      hint: `${say} ${needsImage ? `${screenshotDoor(store)}. ` : ""}Fill the rows, run extension_submit action:"sync-listing" for ${store}, then say publish again; the preflight reads the same rows.`,
    });
  }

  if (code === "SUBMISSION_NOT_JOINABLE" && text(value.uploadRunState)) {
    const sha = text(value.buildId);
    const trackUrl = consoleProjectUrl(api.ref, ConsoleProjectPage.submissionsStore(store), apiHint);
    const say = `The upload for build ${sha || "this draft"} is still running; say publish again when the status reads landed.`;

    return envelope({
      ok: false,
      command: COMMAND,
      status: "upload-running",
      error: {
        code: "E_PLATFORM",
        name: "UploadRunning",
        platformCode: code,
        message: text(parsed.error?.message) || say,
      },
      value: {
        ...value,
        trackUrl,
        sayToPerson: say,
        nextStep: nextStep("publish", say, trackUrl),
      },
      hint: `The platform holds the publish while the submit run carrying the package is ${text(value.uploadRunState)}; nothing ran and no approval was requested. Read the record with extension_release_status (include: ["stores"]) and call publish again once the upload has landed.`,
    });
  }

  if (code === ITEM_NOT_LINKED_CODE) {
    const words = storeWords(store);
    const urls =
      store === "edge"
        ? { linkItemUrl: `${settingsUrl}?link=edge` }
        : itemLinkUrls([], settingsUrl, { ref: api.ref, sha: text(value.buildId), browser: store, api: apiHint });
    const edgeSay = `No Edge Add-ons product is linked to this project yet. Create it once in Partner Center with this build's package, then paste its product ID in the store settings at ${urls.linkItemUrl}; after that, say publish again.`;
    const answer =
      store === "edge"
        ? { sayToPerson: edgeSay, nextStep: nextStep("link-item", edgeSay, urls.linkItemUrl), hint: edgeSay }
        : linkItemAnswer(urls as ReturnType<typeof itemLinkUrls>);

    return envelope({
      ok: false,
      command: COMMAND,
      status: "store-item-not-linked",
      error: {
        code: "E_PLATFORM",
        name: "StoreItemNotLinked",
        platformCode: code,
        message: `No ${words.name.replace(/^the /, "")} ${words.noun} is linked to this project yet, so there is no draft to send to review. Nothing was sent.`,
      },
      value: {
        action: "publish",
        store,
        ...urls,
        trackUrl: settingsUrl,
        sayToPerson: answer.sayToPerson,
        nextStep: answer.nextStep,
      },
      hint: answer.hint,
    });
  }

  if (NOT_CONNECTED_CODES.has(code)) {
    const words = storeWords(store);
    const connectUrl = fallbackConnectUrl(api.ref, store, apiHint);
    const say =
      store === "edge"
        ? `Edge Add-ons is not connected to this project yet. Paste the Partner Center client ID and API key once in the store settings at ${connectUrl}; after that, say publish again.`
        : connectSentences(connectUrl);

    return envelope({
      ok: false,
      command: COMMAND,
      status:
        code === "STORE_CONNECTION_UNHEALTHY"
          ? "store-connection-failed"
          : "store-not-connected",
      error: {
        code: "E_PLATFORM",
        name: "StoreNotConnected",
        platformCode: code,
        message: `${words.name.charAt(0).toUpperCase()}${words.name.slice(1)} is not connected to this project, so nothing was sent to review.`,
      },
      value: {
        action: "publish",
        store,
        connectUrl,
        trackUrl: settingsUrl,
        sayToPerson: say,
        nextStep: nextStep("connect", say, connectUrl),
      },
      hint: say,
    });
  }

  return out;
}

type PublishStore = "chrome" | "edge" | "safari";

const PUBLISH_STORES: readonly PublishStore[] = ["chrome", "edge", "safari"];

const PUBLISH_WORDS: Record<
  PublishStore,
  { name: string; reviewer: string; noun: string; reviewWord: string }
> = {
  chrome: {
    name: "the Chrome Web Store",
    reviewer: "Chrome",
    noun: "item",
    reviewWord: "review",
  },
  edge: {
    name: "Edge Add-ons",
    reviewer: "Edge",
    noun: "product",
    reviewWord: "certification review",
  },
  safari: {
    name: "the App Store",
    reviewer: "Apple",
    noun: "version",
    reviewWord: "App Review",
  },
};

function storeWords(store: PublishStore): (typeof PUBLISH_WORDS)[PublishStore] {
  return PUBLISH_WORDS[store];
}

function publishApprovalSentence(store: PublishStore): string {
  if (store === "edge") return "This sends the product to Edge's certification review.";

  if (store === "safari") {
    return "This sends the App Store version holding the TestFlight build to Apple's App Review; a version the act creates is set to manual release, and a version App Store Connect holds for release after approval is set to manual release before it is sent unless STORE.md states `- Release: after approval` under `## Safari`, so Apple's approval does not put it on sale; the record names the change.";
  }

  return PUBLISH_APPROVAL_SENTENCE;
}

export function safariBuildNumberOf(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return null;

  const number = typeof value === "number" ? value : Number(String(value).trim());

  return Number.isInteger(number) && number > 0 ? number : Number.NaN;
}

export async function publishDraft(args: StoreActArgs): Promise<string> {
  const asked = (
    Array.isArray(args.browsers) && args.browsers.length
      ? args.browsers
      : [text(args.store) || "chrome"]
  ).map((b) => text(b).toLowerCase());
  const store = asked[0] as PublishStore;
  const unknown = asked.filter((name) => !PUBLISH_STORES.includes(name as PublishStore));

  if (!asked.length || unknown.length) {
    return badShipRequest(
      COMMAND,
      "publish",
      "PublishInputError",
      `publish sends a store's draft to review, so browsers must be ["chrome"], ["edge"] or ["safari"], or several of them with buildSha; got ${JSON.stringify(args.browsers ?? args.store ?? null)}. Firefox enters review when it is submitted. Nothing was sent.`,
    );
  }

  if (asked.length > 1) return publishVersion(args, [...new Set(asked)] as PublishStore[]);

  const words = storeWords(store);
  const submissionId = text(args.submissionId);
  const buildNumber = safariBuildNumberOf(args.buildNumber);

  if (buildNumber !== null && (store !== "safari" || !Number.isFinite(buildNumber))) {
    return badShipRequest(
      COMMAND,
      "publish",
      "PublishInputError",
      store === "safari"
        ? `buildNumber is the TestFlight build number Apple shows, a whole number above zero; got ${JSON.stringify(args.buildNumber)}. Nothing was sent.`
        : `buildNumber names a Safari TestFlight build and takes browsers ["safari"]; ${store} drafts are named by submissionId. Nothing was sent.`,
    );
  }

  const opened = await openShipApi(COMMAND, args, { action: "publish", store });
  if ("refused" in opened) return opened.refused;

  const named = {
    ...(submissionId ? { submissionId } : {}),
    ...(buildNumber ? { buildNumber } : {}),
  };
  const ran = await runShipAct(
    {
      command: COMMAND,
      act: "publish",
      action: "extension_store.publish",
      route: `stores/${store}/publish`,
      body: named,
      approvalId: args.approvalId,
      description: `Send the ${words.name.replace(/^the /, "")} ${store === "safari" ? "TestFlight build" : "draft"} to review.`,
      reason: `${publishApprovalSentence(store)} Nothing changes for current users until ${words.reviewer} approves it, so a workspace owner approves this exact draft first.`,
      stateRead: storesRead(args),
      scopeFits: (scope) =>
        text(scope.store) === store &&
        Boolean(text(scope.submissionId)) &&
        (!submissionId || text(scope.submissionId) === submissionId),
      project: args.project,
      apiHint: args.api,
      value: { store, ...named },
    },
    opened.api,
  );

  if (!ran.ok) return reworded(ran.out, opened.api, args.api, store);

  const json = ran.json;
  const itemUrl = text(json.itemUrl);
  const sentId = text(json.submissionId) || submissionId;
  const acceptedAt = text(json.dispatchedAt) || stampNow();
  const base: Row = {
    action: "publish",
    store,
    submissionId: sentId,
    ...(text(json.version) ? { version: text(json.version) } : {}),
    ...(text(json.buildId) ? { buildId: text(json.buildId) } : {}),
    ...(itemUrl ? { itemUrl } : {}),
  };
  const itemLink = itemUrl
    ? [{ kind: "item" as const, url: itemUrl, audience: "you" as const }]
    : [];
  const links = text(json.trackUrl)
    ? linksOf([{ kind: "submission", url: text(json.trackUrl) }, ...itemLink])
    : actLinks(
        COMMAND,
        { ...args, action: "publish" } as Row,
        "in-review",
        base,
        itemLink,
        "submission",
      );
  const trackUrl = text(json.trackUrl) || trackOf(links);
  const say = `It is on its way to ${words.reviewer}'s ${words.reviewWord}; follow it at ${trackUrl || "the submission page"}. Nothing changes for current users until ${words.reviewer} approves it.`;
  const accepted = `The platform accepted the publish at ${acceptedAt} and ${words.reviewer} has not confirmed it yet, so it is accepted, not yet confirmed; follow it at ${trackUrl || "the submission page"}. Nothing changes for current users until ${words.reviewer} approves it.`;
  const waited = await awaitRecordedOutcome<PlatformSubmission>({
    waitSeconds: args.waitSeconds,
    read: () =>
      readSubmissionRecord(opened.api, { submissionId: sentId, store }),
    judge: judgePublish(acceptedAt),
  });
  const made = madeSentence(links);
  const value: Row = {
    ...base,
    ...(trackUrl ? { trackUrl } : {}),
    outcome: waited.outcome,
    links,
  };

  if (waited.failed) {
    const refusal = publishFailureReason(
      waited.record,
      `the platform's record of submission ${sentId} reads ${waited.outcome.status}`,
    );
    const productUrl = store === "edge" && text(json.itemId) ? partnerCenterProductUrl(text(json.itemId)) : null;
    const firstSubmission = store === "edge" && isEdgeCreateNotAllowed(refusal);
    const reason = publishRefusedMessage(refusal, productUrl);
    const step = firstSubmission ? firstSubmissionStep({ partnerCenterUrl: productUrl, steps: [] }, trackUrl) : null;

    return envelope({
      ok: false,
      command: COMMAND,
      status: "publish-failed",
      value: step ? { ...value, ...(productUrl ? { partnerCenterUrl: productUrl } : {}), sayToPerson: step.say, nextStep: step } : value,
      error: {
        code: "E_PLATFORM",
        name: firstSubmission ? "FirstSubmissionInPartnerCenter" : "PublishFailed",
        message: `The publish did not reach ${words.reviewer}'s ${words.reviewWord}: ${reason}.`,
      },
      hint: firstSubmission
        ? `${step?.say ?? ""} Once it has been submitted there once, turn on "Submitted once in Partner Center" in the console Edge store settings (or wait for the platform to record the first publish Partner Center accepted), then call extension_submit action "publish" again; ${storesRead(args)} reads the record. ${made}`
        : `Fix the cause and call extension_submit action "publish" again; ${storesRead(args)} reads the record. ${made}`,
    });
  }

  if (waited.outcome.recorded) {
    return envelope({
      ok: true,
      command: COMMAND,
      status: "in-review",
      value: {
        ...value,
        sayToPerson: say,
        nextStep: nextStep("done", say, trackUrl),
      },
      hint: `The platform's record of submission ${sentId} carries ${words.reviewer}'s own state for the draft, ${waited.outcome.storeState}, so the draft is in ${words.reviewer}'s ${words.reviewWord}${waited.outcome.liveState ? `; the item already live stays ${waited.outcome.liveState} until ${words.reviewer} approves the draft` : ""}. ${say} ${made}`,
    });
  }

  return envelope({
    ok: true,
    command: COMMAND,
    status: "publish-dispatched",
    value: {
      ...value,
      sayToPerson: accepted,
      nextStep: nextStep("done", accepted, trackUrl),
    },
    hint: `${dispatchedHint({ acceptedAt, trackUrl, readCall: storesRead(args) })} ${made}`,
  });
}

/* @invariant A LOCKED CHECK KEEPS ITS LOCK. The platform answers a check
 * whose store will refuse the act until a review it is running ends as
 * {status: "locked", lock: {kind, clearsWhen, storeWord, readAt, source?,
 * reason?}}; the view carried only the message, so an agent saw a check that
 * was not passing and nothing about what clears it (lane 3, 2026-10-28). The
 * status and the lock travel through, and a locked check sits in `locked`,
 * never in `failing`. `source` says whether the platform read the review
 * from the store or could not read it at all (the owner's own Partner Center
 * submission, ledger 329), and `reason` carries the store's words for why.
 */
export function lockView(lock: unknown): Row | null {
  if (!isRow(lock)) return null;

  const view: Row = {};

  for (const key of ["kind", "clearsWhen", "storeWord", "readAt", "source", "reason"]) {
    if (text(lock[key])) view[key] = text(lock[key]);
  }

  return Object.keys(view).length ? view : null;
}

function checkView(check: Row, withLabel: boolean): Row {
  const out: Row = { id: text(check.id) };

  if (withLabel && text(check.label)) out.label = text(check.label);
  if (text(check.severity)) out.severity = text(check.severity);

  for (const key of ["message", "expected", "actual", "docsUrl"]) {
    if (text(check[key])) out[key] = text(check[key]);
  }

  const lock = lockView(check.lock);

  if (text(check.status) === "locked") out.status = "locked";
  if (lock) out.lock = lock;

  return out;
}

export function storePreflightView(json: Row, store: string, local: LocalListingRead = null): Row | null {
  const block = json[`${store}Preflight`];

  if (!isRow(block)) return null;

  const lock = lockView(block.lock);
  const ids = (value: unknown) => (Array.isArray(value) ? value.map((id) => text(id)).filter(Boolean) : []);
  const blockingIds = ids(block.blocking);
  const warningIds = ids(block.warnings);
  const checks = storePreflightChecks(block, store, blockingIds, warningIds).map((check) => reconciledWithStoreMd(check, local));

  return {
    ...(text(block.act) ? { act: text(block.act) } : {}),
    blocking: blockingIds,
    warnings: warningIds,
    ...(checks.length ? { checks } : {}),
    lock,
    ...(text(block.approval) ? { approval: text(block.approval) } : {}),
    ...(nextVersionOf(json, store) ?? {}),
    ...(isRow(block.release) && text(block.release.type) ? { release: releaseReadView(block.release) } : {}),
  };
}


export function nextVersionSentences(storePreflight: Record<string, Row>): string {
  return Object.entries(storePreflight)
    .map(([store, block]) => (text(block.nextVersion) ? nextVersionSentence(store, { nextVersion: text(block.nextVersion), landing: text(block.landing) || undefined }) : ""))
    .filter(Boolean)
    .join(" ");
}

export function lockSentences(storePreflight: Record<string, Row>): string {
  return Object.entries(storePreflight)
    .map(([store, block]) => {
      const lock = isRow(block.lock) ? block.lock : null;

      if (!lock || !text(lock.clearsWhen)) return "";

      if (text(lock.source) === "unreadable") {
        return `${store}: a submission is in certification review and its state ${text(lock.reason) || "could not be read from here"}; the ${text(block.act) || "act"} is queued until ${text(lock.clearsWhen)} (${text(lock.storeWord) || text(lock.kind)}), never failed, and nothing here can call the product idle.`;
      }

      return `${store}: the ${text(block.act) || "act"} is locked until ${text(lock.clearsWhen)} (${text(lock.storeWord) || text(lock.kind)}); a submit or publish is queued behind it, never failed.`;
    })
    .filter(Boolean)
    .join(" ");
}

const NAMED_BY_SUBMIT = new Set(["submission.build_selected"]);

function count(checks: Row[], status: string): number {
  return checks.filter((c) => text(c.status) === status).length;
}

function blocking(checks: Row[]): number {
  return checks.filter(
    (c) =>
      text(c.status) === "fail" &&
      text(c.severity) !== "warning" &&
      text(c.severity) !== "info",
  ).length;
}

function summaryWithout(summary: Row, deferred: Row[], checks: Row[]): Row {
  if (!deferred.length) return summary;

  const stage = (name: string) => checks.filter((c) => text(c.stage) === name);
  const integration = stage("integration");
  const review = stage("review");
  const blockingFailures = blocking(checks);

  return {
    ...summary,
    pass: count(checks, "pass"),
    warn: count(checks, "warn"),
    fail: count(checks, "fail"),
    blockingFailures,
    ...(isRow(summary.integration)
      ? {
          integration: {
            ...summary.integration,
            fail: count(integration, "fail"),
            blockingFailures: blocking(integration),
            canQueue: blocking(integration) === 0,
          },
        }
      : {}),
    ...(isRow(summary.review)
      ? {
          review: {
            ...summary.review,
            fail: count(review, "fail"),
            blockingFailures: blocking(review),
            canSubmitForReview: blocking(review) === 0,
          },
        }
      : {}),
    canSubmit: blockingFailures === 0,
    namedBySubmit: deferred.map((c) => text(c.id)),
  };
}

const DRAFT_ONLY_STORES = new Set(["chrome", "edge"]);

function readinessView(
  json: Row,
  store: string,
  projectPath: string,
  buildNamed: boolean,
  scope: PackageScope,
): Row {
  const apiHint = scope.api;
  const all = (Array.isArray(json.checks) ? json.checks : []).filter(isRow);
  const deferred = buildNamed
    ? []
    : all.filter(
        (c) => NAMED_BY_SUBMIT.has(text(c.id)) && text(c.status) === "fail",
      );
  const checks = all.filter((c) => !deferred.includes(c));
  const summary = summaryWithout(
    isRow(json.summary) ? json.summary : {},
    deferred,
    checks,
  );
  const open = checks.filter(
    (c) => text(c.status) === "fail" || text(c.status) === "warn",
  );
  const settled = checks.filter((c) => text(c.status) === "pass");
  const local = projectPath
    ? readLocalListing(projectPath, store as ListingStore)
    : null;
  const connection = connectionOf(json, apiHint);
  const connectionSource = reportConnectionSource(json);
  const mode = isRow(json.submissionMode) ? json.submissionMode : null;
  const submissionMode =
    mode && text(mode.id)
      ? {
          id: text(mode.id),
          label: text(mode.label),
          description: text(mode.description),
          ...(DRAFT_ONLY_STORES.has(store)
            ? {
                fromHere: uploadStopsAtDraft(store, text(mode.id))
                  ? "An upload from here stops at the draft under this mode."
                  : "An upload from here goes on to review under this mode; set the mode to its draft option in the console store settings to stop at a draft.",
              }
            : {}),
        }
      : null;
  const failing = checks
    .filter((c) => text(c.status) === "fail")
    .map((c) => checkView(reconciledWithStoreMd(c, local), true));
  const locked = checks
    .filter((c) => text(c.status) === "locked")
    .map((c) => checkView(c, true));
  const read = requirementsView(json.requirements, local);
  const sha = text(scope.sha) || text(json.buildId) || buildsReadByPackageChecks(json, store)[0] || "";
  const requirements = read ? { ...read, items: withHandUploadRows(read.items, { ...scope, sha }, nextVersionOf(json, store)?.nextVersion) } : null;
  const review = isRow(summary.review) ? summary.review : null;
  const bringList = bringListOf(store, requirements, review?.canSubmitForReview !== false);

  return {
    canSubmit:
      summary.canSubmit === true ||
      (deferred.length > 0 && failing.length === 0),
    ...(connection ? { connection } : {}),
    ...(connectionSource ? { connectionSource } : {}),
    ...(submissionMode ? { submissionMode } : {}),
    ...(requirements ? { requirements } : {}),
    ...(bringList ? { readyForReview: bringList.readyForReview, bringList } : {}),
    ...(text(json.dashboardUrl) ? { dashboardUrl: text(json.dashboardUrl) } : {}),
    summary,
    ...(deferred.length ? { namedBySubmit: ["build"] } : {}),
    failing,
    ...(locked.length ? { locked } : {}),
    warnings: checks
      .filter((c) => text(c.status) === "warn")
      .map((c) => checkView(reconciledWithStoreMd(c, local), true)),
    ...(local
      ? {
          storeMd:
            "problem" in local
              ? { missing: local.problem }
              : storeMdAdvisory(local, open, settled, requirements),
        }
      : {}),
  };
}

/* @invariant A PREFLIGHT IS A READ. The platform assembles each store's
 * readiness from the build repository, the registry and the names of the
 * secrets it holds, never their values, and writes nothing, so this asks for
 * no approval and counts as no shipping call. Prefilled listing text is left
 * out of the answer: it is the project's own words, not a readiness fact.
 */
export async function preflight(args: StoreActArgs): Promise<string> {
  const asked = (
    Array.isArray(args.browsers) && args.browsers.length
      ? args.browsers
      : [text(args.store) || "chrome"]
  ).map((b) => text(b).toLowerCase());
  const unknown = asked.filter(
    (b) => !(STORES as readonly string[]).includes(b),
  );

  if (unknown.length) {
    return badShipRequest(
      COMMAND,
      "preflight",
      "PreflightInputError",
      `${unknown.join(", ")} is not a store; use ${STORES.join(", ")}. Nothing was sent.`,
    );
  }

  const detail = preflightDetail(args.detail);

  if ("problem" in detail) {
    return badShipRequest(COMMAND, "preflight", "PreflightInputError", `${detail.problem}. Nothing was sent.`);
  }

  const opened = await openShipApi(COMMAND, args, { action: "preflight" });
  if ("refused" in opened) return opened.refused;

  const api = opened.api;
  const body: Row = {};
  if (text(args.buildSha)) body.buildId = text(args.buildSha);

  const reads = await Promise.all(
    asked.map((store) =>
      projectApiSend<Row>(
        api,
        "POST",
        `stores/${store}/submissions/preflight`,
        body,
      ),
    ),
  );
  const firstRefusal = reads.find((read) => !read.ok);

  if (firstRefusal && !firstRefusal.ok && reads.every((read) => !read.ok)) {
    return projectApiReadFailure(COMMAND, firstRefusal, {
      api: args.api,
      name: "Preflight",
      value: { action: "preflight", stores: asked },
    });
  }

  const stores: Row = {};
  const reports: Record<string, Row> = {};
  const storePreflight: Record<string, Row> = {};
  const unread: string[] = [];

  const shown = (): Row => {
    const compact = compactPreflightStores(stores, detail);

    return {
      ...(compact.trimmed ? { stores: compact.stores, detail: PREFLIGHT_DETAIL_SENTENCE } : { stores: compact.stores }),
      ...(Object.keys(storePreflight).length ? { storePreflight } : {}),
    };
  };

  asked.forEach((store, i) => {
    const read = reads[i];
    if (read.ok) {
      const updateManifest = store === "firefox" ? firefoxUpdateManifestOf(read.json, api.ref, text(args.projectPath), args.api) : null;
      const json = relayFirefoxUpdateUrl(read.json, updateManifest);
      reports[store] = json;

      const block = storePreflightView(json, store, text(args.projectPath) ? readLocalListing(text(args.projectPath), store as ListingStore) : null);
      if (block) storePreflight[store] = block;

      const view = readinessView(
        json,
        store,
        text(args.projectPath),
        Boolean(text(args.buildSha)),
        { ref: api.ref, sha: text(args.buildSha), api: args.api },
      );
      stores[store] =
        store === "firefox"
          ? {
              ...view,
              ...firefoxSourceArchiveView(
                json,
                firefoxConnectUrl(api.ref, args.api),
              ),
              ...(updateManifest ? { updateManifest } : {}),
            }
          : view;
    } else unread.push(`${store}: ${read.message}`);
  });

  const packageBuilds = await packageBuildViews(api, text(args.projectPath), reports, asked);

  asked.forEach((store, i) => {
    const view = packageBuilds[i];
    if (view && isRow(stores[store])) stores[store] = { ...(stores[store] as Row), packageBuild: view };
  });

  const packageLine = packageBuildLine(packageBuilds);
  const blocked = Object.entries(stores)
    .filter(([, view]) => (view as Row).canSubmit !== true)
    .map(([store]) => store);
  const coverable = Object.entries(stores)
    .filter(
      ([, view]) =>
        isRow((view as Row).storeMd) &&
        Array.isArray(((view as Row).storeMd as Row).covers) &&
        (((view as Row).storeMd as Row).covers as unknown[]).length,
    )
    .map(([store]) => store);
  const syncLine = coverable.length
    ? ` STORE.md and the build already cover part of the ${coverable.join(", ")} listing: extension_submit action:"sync-listing" with browsers:[${coverable.map((s) => `"${s}"`).join(", ")}] and projectPath fills it after a workspace owner approves.`
    : "";
  const unreadLine = unread.length
    ? `Readiness could not be read for ${unread.join("; ")}.`
    : null;
  const storesPageUrl = consoleProjectUrl(
    api.ref,
    ConsoleProjectPage.stores,
    args.api,
  );
  const buildNamedLater = Object.values(stores).some((view) =>
    Array.isArray((view as Row).namedBySubmit),
  );
  const buildLine = buildNamedLater
    ? " The submit call names the build; extension_builds lists the shas."
    : "";
  const modeLine = Object.entries(stores)
    .map(([store, view]) => {
      const mode = isRow((view as Row).submissionMode)
        ? ((view as Row).submissionMode as Row)
        : null;

      return mode && text(mode.label)
        ? ` ${store} submission mode: ${text(mode.label)} (${text(mode.id)}): ${text(mode.description)}${text(mode.fromHere) ? ` ${text(mode.fromHere)}` : ""}`
        : "";
    })
    .join("");
  const firefoxView = isRow(stores.firefox) ? stores.firefox : null;
  const sourceLine = [
    firefoxView && isRow(firefoxView.sourceArchive) ? ` ${text(firefoxView.sourceArchive.say)}` : "",
    firefoxView && isRow(firefoxView.updateManifest) ? ` ${text(firefoxView.updateManifest.say)}` : "",
  ].join("");
  const inputsSay = [missingRequirementsSentences(stores), bringListSentences(stores)].filter(Boolean).join(" ");
  const workspaceLine = Object.entries(stores)
    .filter(([, view]) => (view as Row).connectionSource === "workspace")
    .map(([store, view]) => {
      const row = isRow((view as Row).connection) ? ((view as Row).connection as Row) : {};

      return ` ${workspaceAccountSentence(store, text(row.connectedAs) || null)}`;
    })
    .join("");
  const notReady = Object.entries(stores)
    .filter(([, view]) => (view as Row).readyForReview === false)
    .map(([store]) => store);
  const lockLine = lockSentences(storePreflight);
  const versionLine = nextVersionSentences(storePreflight);
  const packageSay = packageLine ? ` ${packageLine}` : "";
  const readinessHint = blocked.length
    ? `${blocked.join(", ")} cannot be submitted yet; each failing check says what to fix.${syncLine}${sourceLine}${lockLine ? ` ${lockLine}` : ""}${versionLine ? ` ${versionLine}` : ""}${packageSay} This read wrote nothing.`
    : `${notReady.length ? "Every store read here can take an upload." : "Every store read here is ready to submit."}${buildLine}${modeLine}${sourceLine}${workspaceLine}${lockLine ? ` ${lockLine}` : ""}${versionLine ? ` ${versionLine}` : ""}${packageSay} This read wrote nothing; extension_submit with dryRun:false submits.`;
  const chrome = isRow(stores.chrome) ? stores.chrome : null;
  const connection =
    chrome && isRow(chrome.connection) ? chrome.connection : null;

  if (
    chrome &&
    connection &&
    (!text(connection.kind) || connection.healthy === false)
  ) {
    const connected = Boolean(text(connection.kind));
    const settingsUrl = storeSettingsUrl(api.ref, args.api);
    const connectUrl =
      text(connection.connectUrl) ||
      fallbackConnectUrl(api.ref, "chrome", args.api);
    const say = connected
      ? `${failedCheckSentence(text(connection.reason), "chrome", connectionSourceOf(connection.source))} ${connectSentences(connectUrl)}`
      : connectSentences(connectUrl);
    const others = blocked.filter((store) => store !== "chrome");

    return envelope({
      ok: true,
      command: COMMAND,
      status: connected ? "store-connection-failed" : "store-not-connected",
      value: {
        action: "preflight",
        ...shown(),
        storesPageUrl,
        connectUrl,
        trackUrl: settingsUrl,
        sayToPerson: say,
        nextStep: nextStep("connect", say, connectUrl),
      },
      hint: say,
      warnings: [
        others.length
          ? `${others.join(", ")} cannot be submitted yet either; each failing check says what to fix.`
          : null,
        unreadLine,
        "This read wrote nothing.",
      ],
    });
  }

  if (
    chrome &&
    connection &&
    connection.healthy === true &&
    connection.itemLinked === false
  ) {
    const settingsUrl = storeSettingsUrl(api.ref, args.api);
    const chromeReport = reports.chrome ?? {};
    const urls = itemLinkUrls([chromeReport, chromeReport.connection, connection], settingsUrl, {
      ref: api.ref,
      sha: text(args.buildSha) || (isRow(chrome.packageBuild) ? text(chrome.packageBuild.read) : ""),
      browser: "chrome",
      api: args.api,
    });
    const answer = linkItemAnswer(urls, chromeItemLeftOf(connection, chromeReport));

    return envelope({
      ok: true,
      command: COMMAND,
      status: "store-item-not-linked",
      value: {
        action: "preflight",
        ...shown(),
        storesPageUrl,
        ...urls,
        trackUrl: settingsUrl,
        sayToPerson: answer.sayToPerson,
        nextStep: answer.nextStep,
      },
      hint: answer.hint,
      warnings: [unreadLine, "This read wrote nothing."],
    });
  }

  const reconnecting = asked.find(
    (store) => reports[store] && connectionOf(reports[store])?.state === WORKSPACE_RECONNECT_STATE,
  );

  if (reconnecting) {
    const accountsUrl = workspaceStoreAccountsUrl(api.ref, args.api);
    const say = workspaceReconnectSentences(
      text(connectionOf(reports[reconnecting])?.reason),
      accountsUrl,
    );
    const others = blocked.filter((store) => store !== reconnecting);

    return envelope({
      ok: true,
      command: COMMAND,
      status: WORKSPACE_RECONNECT_STATE,
      value: {
        action: "preflight",
        ...shown(),
        storesPageUrl,
        connectionSource: "workspace",
        workspaceStoreAccountsUrl: accountsUrl,
        trackUrl: accountsUrl,
        sayToPerson: say,
        nextStep: nextStep("configure", say, accountsUrl),
      },
      hint: say,
      warnings: [
        others.length
          ? `${others.join(", ")} cannot be submitted yet either; each failing check says what to fix.`
          : null,
        unreadLine,
        "This read wrote nothing.",
      ],
    });
  }

  const firefoxPair = reports.firefox
    ? firefoxKeyPairState(reports.firefox)
    : null;

  if (firefoxPair && reportConnectionSource(reports.firefox) === "workspace") {
    const firefoxConnection = connectionOf(reports.firefox);
    const accountsUrl = workspaceStoreAccountsUrl(api.ref, args.api);
    const say = firefoxWorkspaceKeyPairSentences(
      firefoxPair,
      text(firefoxConnection?.reason),
      accountsUrl,
    );

    return envelope({
      ok: true,
      command: COMMAND,
      status:
        firefoxPair === "failed"
          ? "store-connection-failed"
          : "store-connection-unverified",
      value: {
        action: "preflight",
        ...shown(),
        storesPageUrl,
        connectionSource: "workspace",
        workspaceStoreAccountsUrl: accountsUrl,
        trackUrl: accountsUrl,
        sayToPerson: say,
        nextStep: nextStep("configure", say, accountsUrl),
      },
      hint: say,
      warnings: [unreadLine, "This read wrote nothing."],
    });
  }

  if (firefoxPair) {
    const firefoxConnection = connectionOf(reports.firefox);
    const settingsUrl = storeSettingsUrl(api.ref, args.api);
    const connectUrl =
      text(firefoxConnection?.connectUrl) ||
      firefoxConnectUrl(api.ref, args.api);
    const say =
      firefoxPair === "failed"
        ? firefoxKeyPairFailedSentences(
            text(firefoxConnection?.reason),
            connectUrl,
          )
        : firefoxKeyPairUnverifiedSentences(
            connectUrl,
            blocked.includes("firefox"),
          );
    const others = blocked.filter((store) => store !== "firefox");

    return envelope({
      ok: true,
      command: COMMAND,
      status:
        firefoxPair === "failed"
          ? "store-connection-failed"
          : "store-connection-unverified",
      value: {
        action: "preflight",
        ...shown(),
        storesPageUrl,
        connectUrl,
        trackUrl: settingsUrl,
        sayToPerson: say,
        nextStep: nextStep("connect", say, connectUrl),
      },
      hint: say,
      warnings: [
        others.length
          ? `${others.join(", ")} cannot be submitted yet either; each failing check says what to fix.`
          : null,
        unreadLine,
        "This read wrote nothing.",
      ],
    });
  }

  const notConnected = (store: string, say: string, step: "connect" | "configure" = "connect"): string => {
    const connectUrl = fallbackConnectUrl(api.ref, store, args.api);
    const settingsUrl = storeSettingsUrl(api.ref, args.api);
    const full =
      store === "firefox"
        ? `${say} ${firefoxSourceArchiveLine(reports.firefox, connectUrl)}`
        : say;
    const others = blocked.filter((name) => name !== store);

    return envelope({
      ok: true,
      command: COMMAND,
      status: "store-not-connected",
      value: {
        action: "preflight",
        ...shown(),
        storesPageUrl,
        connectUrl,
        trackUrl: settingsUrl,
        sayToPerson: full,
        nextStep: nextStep(step, full, step === "configure" ? settingsUrl : connectUrl),
      },
      hint: full,
      warnings: [
        others.length
          ? `${others.join(", ")} cannot be submitted yet either; each failing check says what to fix.`
          : null,
        unreadLine,
        "This read wrote nothing.",
      ],
    });
  };

  if (reports.firefox && firefoxNotConnected(reports.firefox)) {
    return notConnected(
      "firefox",
      firefoxConnectSentences(firefoxConnectUrl(api.ref, args.api)),
    );
  }

  const switchedOff = asked.find(
    (store) => reports[store] && storeSwitchOff(reports[store]),
  );

  /* @invariant THE SWITCH IS ONE PLAIN CALL AWAY, SO THE NEXT STEP NAMES
   * IT. A store whose credentials are saved and whose "Store publishing"
   * switch is off needs no person at the console: configure-store with
   * enabled true turns it on under the owner's own token (ledger 142
   * addendum), and for Firefox the same call carries the source archive, so
   * nextStep is "configure" with the settings page, and the console connect
   * page stays only for credentials, which never pass through this server.
   */
  if (switchedOff) {
    return notConnected(
      switchedOff,
      storeSwitchSentences(switchedOff, storeSettingsUrl(api.ref, args.api)),
      "configure",
    );
  }

  /* @invariant THE EDGE PREFLIGHT NAMES A NEVER-SUBMITTED PRODUCT BEFORE
   * ANY APPROVAL. The platform's report carries `edgeFirstSubmission`; when
   * the saved mode would send the upload on to review the preflight answers
   * `first-submission-in-partner-center` with the product page and the
   * one-time steps as the next step, and when the upload would stop at a
   * draft the state is said beside the stores with the same steps, so the
   * person learns the one-time move before the first publish is asked for. */
  const edgeFirst = reports.edge ? edgeFirstSubmissionOf(reports.edge) : null;
  const edgeFirstLine =
    edgeFirst && edgeFirst.state === EDGE_FIRST_SUBMISSION_STATE
      ? firstSubmissionSentences(edgeFirst).replace(/ Nothing was sent and no approval was asked for\.$/, "")
      : "";

  if (edgeFirst && edgeFirst.state === EDGE_FIRST_SUBMISSION_STATE) {
    stores.edge = { ...(stores.edge as Row), firstSubmission: edgeFirst };
  }

  if (edgeFirst && edgeFirst.state === EDGE_FIRST_SUBMISSION_STATE && edgeFirst.blocksSubmit) {
    const settingsUrl = storeSettingsUrl(api.ref, args.api);
    const step = firstSubmissionStep(edgeFirst, settingsUrl);
    const others = blocked.filter((name) => name !== "edge");

    return envelope({
      ok: true,
      command: COMMAND,
      status: EDGE_FIRST_SUBMISSION_STATE,
      value: {
        action: "preflight",
        ...shown(),
        storesPageUrl,
        ...(edgeFirst.partnerCenterUrl ? { partnerCenterUrl: edgeFirst.partnerCenterUrl } : {}),
        steps: edgeFirst.steps,
        trackUrl: settingsUrl,
        sayToPerson: step.say,
        nextStep: step,
      },
      hint: step.say,
      warnings: [
        others.length
          ? `${others.join(", ")} cannot be submitted yet either; each failing check says what to fix.`
          : null,
        unreadLine,
        "This read wrote nothing.",
      ],
    });
  }

  const itemUrl =
    chrome && connection && text(connection.itemId)
      ? text(connection.itemUrl)
      : "";
  const green = blocked.length === 0 && unread.length === 0;
  const notReadyStep = notReady.length
    ? notReadyForReviewStep(notReady, inputsSay, edgeFirst, storesPageUrl, storeSettingsUrl(api.ref, args.api))
    : null;
  const reviewing = chrome ? await chromeReviewInProgress(api) : null;
  const reviewBlocks = Boolean(reviewing) && !uploadStopsAtDraft("chrome", modeIdOf(stores.chrome));
  const reviewLine = reviewing ? (reviewBlocks ? reviewSentence(reviewing) : draftBesideReviewSentence(reviewing)) : "";
  const reviewUrl = consoleProjectUrl(
    api.ref,
    ConsoleProjectPage.submissionsStore("chrome"),
    args.api,
  );
  const reviewSay = reviewing ? reviewSentence(reviewing) : "";
  const modeIds: ModeIds = Object.fromEntries(
    Object.entries(stores).map(([store, view]) => [
      store,
      isRow((view as Row).submissionMode)
        ? text(((view as Row).submissionMode as Row).id)
        : undefined,
    ]),
  );

  return envelope({
    ok: true,
    command: COMMAND,
    status: "preflight-read",
    value: {
      action: "preflight",
      ...shown(),
      storesPageUrl,
      ...(itemUrl ? { itemUrl } : {}),
      ...(reviewing ? { chromeReview: reviewing } : {}),
      trackUrl: reviewing ? reviewUrl : storesPageUrl,
      sayToPerson: [inputsSay, edgeFirstLine, reviewLine, notReadyLine(notReady, green), readinessHint]
        .filter(Boolean)
        .join(" "),
      nextStep: reviewBlocks
        ? nextStep("done", reviewSay, reviewUrl)
        : green
          ? notReadyStep ?? submitStep(asked, modeIds)
          : null,
    },
    hint: [inputsSay, edgeFirstLine, reviewLine, notReadyLine(notReady, green), readinessHint]
      .filter(Boolean)
      .join(" "),
    warnings: [unreadLine],
  });
}

function modeIdOf(view: unknown): string | undefined {
  return isRow(view) && isRow(view.submissionMode) ? text(view.submissionMode.id) || undefined : undefined;
}

function draftBesideReviewSentence(review: Row): string {
  const build = text(review.buildSha);

  return `Chrome is reviewing ${build ? `build ${build}` : "another build"}; under the saved draft mode a submit uploads a new draft beside it and enters no review.`;
}

/* @invariant A PREFLIGHT NAMES THE REVIEW THAT IS ALREADY RUNNING, AND BLOCKS
 * ONLY A SUBMIT THAT WOULD ENTER ONE. The readiness report says whether a
 * build could be submitted, not whether one already was, and on 2026-10-21
 * the answer offered a draft while Chrome was reviewing the same project.
 * The platform's record is the reader of that fact, read no older than a day
 * (the platform re-polls the store before it answers), so the preflight
 * answers done instead of submit when the recorded state is an open review
 * and the saved mode would send the upload to review. A draft mode upload
 * enters no review, so the review is named and the submit step stays; and a
 * record the store has contradicted (no active submission, published,
 * rejected) blocks nothing.
 */
async function chromeReviewInProgress(
  api: Parameters<typeof readSubmissionRecord>[0],
): Promise<Row | null> {
  const read = await readSubmissionRecord(api, { store: "chrome" }).catch(
    () => null,
  );
  if (!read || !read.ok || !read.record) return null;

  const record = read.record;
  const state = text(record.storeReview?.state);
  if (text(record.rawStatus) === "no-active-submission") return null;

  const pending = state
    ? /pending|review/i.test(state) && !/published|rejected|taken|no_active/i.test(state)
    : text(record.status).toLowerCase() === "submitted";
  if (!pending) return null;

  return {
    submissionId: record.id ?? null,
    storeState: state || null,
    buildSha: record.buildSha ?? null,
    version: record.version ?? null,
    since: record.submittedAt ?? null,
  };
}

function reviewSentence(review: Row): string {
  const build = text(review.buildSha);
  const version = text(review.version);
  const since = text(review.since);
  const what = `${build ? `build ${build}` : "a build"}${version ? ` (version ${version})` : ""}`;

  return `Chrome is already reviewing ${what}${since ? ` since ${since.slice(0, 10)}` : ""}, so there is nothing to submit. A new submit would upload another draft beside that review, not replace it; a listing fix goes through extension_submit action:"sync-listing", and the review's outcome lands on the submission page.`;
}
