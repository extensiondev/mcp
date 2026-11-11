// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import fs from "node:fs";
import path from "node:path";

import { ConsoleProjectPage } from "@extension.dev/urls/paths";

import { API_BASE } from "../lib/common-schema";
import { resolveCredential } from "../lib/credential-source";
import { expiredLoginRefusal } from "../lib/login-expired";
import { chromeItemLeftOf } from "../lib/chrome-item-left";
import { CHROME_SLOTS_SENTENCE } from "../lib/chrome-publisher-slots";
import { linkItemAnswer } from "../lib/link-item-answer";
import { approvalRefundOf, approvalRefundSentence } from "../lib/approval-refund-words";
import { envelope, type ErrorCode } from "../lib/envelope";
import { PROJECT_TOKEN_INPUT, noStoredLoginHint } from "../lib/credentials";
import {
  firefoxConnectUrl,
  firefoxSourcesOutcome,
  sourceArchiveOf,
} from "../lib/firefox-store";
import { resolveApiBase, safeApiBase } from "../lib/login-flow";
import { platformFetch } from "../lib/platform-fetch";
import { bearerHeaders } from "../lib/request-fetch";
import { identityHeaders } from "../lib/session-identity";
import { REFUNDED_SAY, REFUNDED_STEP } from "../lib/ship-act";
import { STORE_MD_FILENAME, parseStoreMd } from "../lib/store-md";
import { platformHoldEnvelope, pricedRefusal, sawPlatformHold } from "../lib/platform-hold";
import {
  approvalGateEnabled,
  evaluateApproval,
  platformRequiresApproval,
  requestApprovalAfterRefusal,
} from "../lib/approval-gate";
import { spendNarration } from "../lib/allowance";
import {
  VERSION_ACTION,
  linesSentence,
  readLines,
  retryStores,
  storesInState,
  versionScopeFor,
} from "../lib/approval-lines";
import { approvalRoundTrip } from "../lib/approval-outcome";
import {
  FAILED_STATUSES,
  WAIT_SECONDS_INPUT,
  awaitRecordedOutcome,
  dispatchedHint,
  isRow,
  linksOf,
  madeSentence,
  recordedOutcome,
  stampNow,
  type ActLink,
  type Verdict,
} from "../lib/act-outcome";
import {
  RETRIED_SENTENCE,
  queuedActOf,
  queuedActSentence,
  readSubmissionRecords,
  type PlatformSubmission,
  type QueuedStoreActView,
} from "../lib/platform-submissions";
import { trackUrl as consoleTrackUrl } from "../lib/track-url";
import { readSubmitOutcome } from "../lib/submit-outcome";
import { consoleProjectUrl, type ProjectRef } from "../lib/registry";
import {
  PUBLISH_ACTIONS,
  preflight as readPreflight,
  publishDraft,
} from "./store-acts";
import { CONFIGURE_STORE, configureStore } from "./store-configure";
import { connectStoreAccount } from "./store-connect";
import { FIRST_SUBMISSION_ACTION, openFirstSubmission } from "./store-first-submission";
import { MINT_SIGNING_ACTION, mintSigning } from "./store-mint";
import { releaseVersion } from "./store-release";
import { cancelSubmission, raiseRollout } from "./store-rollout";
import { firefoxUpdateManifestOutcome } from "../lib/firefox-update-url";
import { rowsWithSentVersion } from "../lib/store-answer";
import { STORES_READ_CALL, storeVersionStatus } from "./store-version-status";
import {
  ITEM_NOT_LINKED_CODE,
  NOT_CONNECTED_CODES,
  chromeItemUrl,
  connectSentences,
  dispatchedStep,
  doneStep,
  submitFailedStep,
  failedCheckSentence,
  fallbackConnectUrl,
  itemLinkUrls,
  nextStep,
  runPublishRefusedStep,
  runPublishesAfterUpload,
  runPublishesStep,
  storeSettingsUrl,
  uploadedStepFailedStep,
  uploadStopsAtDraft,
  withApproveStep,
  withReviewPromise,
  withoutSecretNames,
  type ModeIds,
} from "../lib/store-connection";
import { browserBuildRefusal, browserBuildVerdicts } from "../lib/browser-builds";
import { installRefusedAfterRun, installRefusedAnswer, installRefusedRecords, storeRefusedInstall } from "../lib/store-refused-install";
import { LOCAL_CHECK_FAILED_STATE, localCheckRefusal, localSubmitPrecheck } from "../lib/submit-local-precheck";
import { dryRunStoreRead, platformUnavailableAnswer, storeRunUnavailable } from "../lib/store-run-unavailable";
import { FIREFOX_AGREEMENT_URL, firefoxAgreementCheck, firefoxAgreementOf } from "../lib/firefox-enterprise";
import { appendWarnings } from "../lib/envelope-warnings";
import { reviewPromiseFromApproval } from "../lib/review-promise";
import { SUBMIT_ACTION_SAFETY } from "../lib/submit-action-safety";
import { readStoresAfterUnconfirmed, submitDispatchBoundMs, unconfirmedStoresHint } from "../lib/submit-dispatch-bound";
import { failureLineOf, uploadRefused, uploadTaken } from "../lib/store-upload-words";
import {
  connectionStep,
  dryRunVerdict,
  isConnectionState,
  nextVersionSentence,
  NOT_CHECKED,
  readConnectionsAndModes,
  readStoreRows,
  rowFromConnection,
} from "../lib/store-readiness";
import { syncListing } from "./store-listing";
import { screenshotDoor } from "../lib/store-bring-list";
import { readSafariReleaseIntentFor, safariApprovalReleaseSentence } from "../lib/safari-release-intent";
import { withSafariPublishStep } from "../lib/safari-testflight-step";
import { LISTING_INCOMPLETE_CODE, listingIncompleteOf, listingIncompleteSentence } from "../lib/store-listing-incomplete";

import type { InputIssue } from "../lib/validate-input";

export function storeMdWarnings(browsers: string[], cwd: string): string[] {
  const wantsFirefox = browsers.includes("firefox");
  const wantsEdge = browsers.includes("edge");
  if (!wantsFirefox && !wantsEdge) return [];

  const filePath = path.join(cwd, STORE_MD_FILENAME);
  let content: string;

  try {
    content = fs.readFileSync(filePath, "utf8");
  } catch {
    return [
      `No ${STORE_MD_FILENAME} found in the current working directory. Platform submissions read ${STORE_MD_FILENAME} from the project's source repository at the built commit, so this may not apply here; make sure ${STORE_MD_FILENAME} exists there for Firefox reviewer notes and Edge certification notes. See the extension-dev skill's store-md reference.`,
    ];
  }

  const data = parseStoreMd(content);
  const warnings: string[] = [];

  if (wantsFirefox && !data.firefox?.approvalNotes) {
    warnings.push(
      `${STORE_MD_FILENAME} has no Firefox reviewer notes; AMO reviews go faster with test credentials and steps.`,
    );
  }

  if (wantsEdge && !data.edge?.certificationNotes) {
    warnings.push(
      `${STORE_MD_FILENAME} has no Edge certification notes; the certification team gets no testing guidance.`,
    );
  }

  if (warnings.length === 0) {
    warnings.push(
      `The notes above were read from ${filePath}. The submission reads ${STORE_MD_FILENAME} from the project's source repository at the built commit, so an uncommitted or unpushed edit here does not travel with it.`,
    );
  }

  return warnings;
}

export interface SubmitToolArgs {
  action?: string;
  store?: string;
  submissionId?: string;
  buildNumber?: unknown;
  deployPercentage?: unknown;
  project?: string;
  browsers?: string[];
  buildSha?: string;
  version?: string;
  dryRun?: boolean;
  projectPath?: string;
  screenshots?: unknown;
  storeSettings?: unknown;
  connectSession?: string;
  replace?: unknown;
  approvalId?: string;
  useBuild?: string;
  detail?: unknown;
  waitSeconds?: unknown;
  api?: string;
}

export const SUBMIT_ACTIONS = [
  "submit",
  "status",
  "preflight",
  "sync-listing",
  "cancel",
  "rollout",
  "release",
  "publish",
  "review",
  "configure-store",
  "connect",
  "first-submission",
  "mint-signing",
] as const;

export function invalidArgumentsHint(issues: InputIssue[]): string | undefined {
  if (!issues.some((issue) => issue.path === "action")) return undefined;

  return `The store's own state for the newest version is extension_submit_check {action: "status", browsers: [<store>]}, and the full store picture is ${STORES_READ_CALL}.`;
}

export const schema = {
  name: "extension_submit",
  description:
    "Submit a platform build to the Chrome, Firefox, Edge and Safari stores through extension.dev. Start with extension_submit_check action:'preflight' and follow value.nextStep. A real submit needs a workspace owner's token and approval of that exact submission, every time: extension_submit_check asks, and this tool runs the approvalId. Uploads land least public (Chrome and Edge drafts, Firefox unlisted, Safari TestFlight) unless a saved store mode says otherwise. For a link use extension_publish.",
  inputSchema: {
    type: "object" as const,
    properties: {
      action: {
        type: "string",
        enum: [...SUBMIT_ACTIONS],
        default: "submit",
        description:
          `${SUBMIT_ACTION_SAFETY} ` +
          "submit: buildSha to the stores. preflight: readiness checks. status: each store's word. sync-listing: listing from STORE.md. publish (alias review): draft to review. release (Safari): approved version on sale. cancel: withdraw from review. rollout: raise Chrome's staged rollout. configure-store: storeSettings. connect: page where the person gives the platform the key. first-submission: page for a first Chrome or Edge upload. mint-signing (Safari): register the bundle id, mint certificates and profiles.",
      },
      project: PROJECT_TOKEN_INPUT,
      browsers: {
        type: "array",
        items: {
          type: "string",
          enum: ["chrome", "firefox", "edge", "safari"],
        },
        description: "Stores; submit, publish and sync-listing take several under one approval.",
      },
      buildSha: {
        type: "string",
        description: "Commit sha of a completed platform build (extension_builds).",
      },
      version: {
        type: "string",
        description: "Optional label; default the built manifest's version.",
      },
      dryRun: {
        type: "boolean",
        default: true,
        description:
          "true (the default) sends nothing and spends no approval or quota; false submits once approved and stops at the draft under the default modes.",
      },
      projectPath: {
        type: "string",
        description: "Project root; sync-listing needs it; nothing local is uploaded.",
      },
      approvalId: {
        type: "string",
        description:
          "From an approval-required answer, once approved; same arguments again. A real submission needs a workspace owner's approval every time.",
      },
      screenshots: {
        type: "array",
        items: { type: "string" },
        description:
          "With sync-listing, PNG screenshots in projectPath; a wrong size or weight is answered with what the store accepts.",
      },
      useBuild: {
        type: "string",
        description: "With sync-listing, a completed build's sha to take icons from.",
      },
      detail: {
        type: ["boolean", "array"],
        items: { type: "string" },
        description: 'With preflight, true or a list like ["chrome", "safari.subtitle"] answers those rows in full.',
      },
      api: API_BASE,
      store: {
        type: "string",
        enum: ["chrome", "firefox", "edge", "safari"],
        description: "With cancel or rollout (default chrome), release (safari) or configure-store (required).",
      },
      storeSettings: {
        type: "object",
        properties: {
          enabled: { type: "boolean", description: "Submit to this store at all." },
          submissionMode: { type: "string", description: "chrome draft-until-public|draft|public|staged, edge draft|review, firefox unlisted|listed, safari draft|review, or dry-run; public, staged, review and listed publish on review." },
          sourceArchive: { type: "string", enum: ["repository", "none"], description: "Firefox: attach the source at the built commit." },
          releaseChannel: { type: "string", enum: ["listed", "unlisted"], description: "Firefox: the AMO channel." },
          chromeItemId: { type: "string", description: "Chrome: the 32-letter item id." },
          publisherId: { type: "string", description: "Chrome: the publisher id after /devconsole/." },
          edgeProductId: { type: "string", description: "Edge: the Partner Center Product ID." },
          firefoxAddonGuid: { type: "string", description: "Firefox: the add-on GUID, never a slug." },
          appStoreId: { type: "string", description: "Safari: the app's Apple ID." },
          bundleId: { type: "string", description: "Safari: the reverse-DNS bundle id." },
          firstSubmitted: { type: "boolean", description: "Edge: submitted once in Partner Center." },
          storeUrl: { type: "string", description: "Edge listing or Chrome dashboard URL; \"\" clears." },
          dashboardPasted: { type: "boolean", description: "Chrome: dashboard-only fields pasted." },
        },
        description:
          "With configure-store, only what changes; a publishing mode asks approval; no credentials; Safari release mode is STORE.md's `- Release:` line.",
      },
      submissionId: {
        type: "string",
        description: "With cancel, publish or release, which submission; default the newest.",
      },
      buildNumber: {
        type: "integer",
        minimum: 1,
        description: "Safari publish or release: TestFlight build number (default newest).",
      },
      deployPercentage: {
        type: "number",
        description: "With rollout, the new share of users, 1 to 100, above the current one.",
      },
      connectSession: {
        type: "string",
        description: "With connect, value.connectSession to wait on with waitSeconds.",
      },
      replace: {
        type: "boolean",
        description: "With connect, true replaces a working key; only when asked.",
      },
      waitSeconds: WAIT_SECONDS_INPUT,
    },
    required: [],
  },
};

function fail(
  name: string,
  message: string,
  status: string,
  code: ErrorCode,
): string {
  return envelope({
    ok: false,
    command: "extension_submit",
    status,
    error: { code, name, message },
  });
}

export async function handler(args: SubmitToolArgs): Promise<string> {
  return withoutSecretNames(await answer(args));
}

const DRAFT_STORES = new Set(["chrome", "edge"]);

function safariReviewLineClause(releaseSentence: string): string {
  return `; the saved safari mode "review" adds the line that sends the TestFlight build on to Apple's App Review, so the publish asks no second approval. ${(releaseSentence || safariApprovalReleaseSentence(null)).replace(/\.$/, "")}`;
}

/* @invariant THE SAVED SAFARI REVIEW MODE PUTS THE PUBLISH LINE ON THE
 * SUBMIT'S OWN APPROVAL (ledger 324). The Safari upload always stops at the
 * TestFlight draft, so the send to App Review is a second act and cost a
 * second approval where Chrome public costs one. When the preflight reads the
 * Safari mode as review (the owner approved that setting once), the submit
 * asks for the version act even for Safari alone, with "safari:publish"
 * beside "safari:upload", and the answer tells the agent to call publish
 * with the same approvalId once TestFlight holds the build; the release stays
 * its own approval. A mode the preflight did not answer is a draft.
 */
export function safariReviewCovers(browsers: string[], modes: ModeIds): boolean {
  return browsers.includes("safari") && modes.safari === "review";
}

const STORE_WORDS: Record<string, string> = {
  chrome: "The Chrome Web Store",
  edge: "Edge Add-ons",
  firefox: "Firefox AMO",
  safari: "The App Store",
};
const SUBMIT_PENDING = new Set(["pending", "queued", "dispatched"]);
const EDGE_PACKAGE_HAS_ARCHIVES_CODE = "EDGE_PACKAGE_HAS_ARCHIVES";
const TESSERACT_HINT = "ship `.traineddata` uncompressed (Tesseract.js takes `gzip: false`)";

function packageRefusedSentences(args: {
  buildSha: string;
  files: string[];
  buildUrl: string;
}): string {
  const count = args.files.length;
  const named = count
    ? ` (${args.files.join(", ")})`
    : "";

  return `The Edge package of build ${args.buildSha} carries ${count || "some"} compressed ${count === 1 ? "file" : "files"}${named}, and Partner Center refuses any archive inside an extension package, so nothing was submitted. Ship the files uncompressed and rebuild; for Tesseract, ${TESSERACT_HINT}. Then submit again; the build is at ${args.buildUrl}.`;
}

interface StoreRetry {
  retryOf: string;
  submissionId: string;
}

/* @invariant A RUN GITHUB CANCELED BEFORE UPLOAD IS FOLLOWED TO ITS RETRY,
 * NEVER CALLED FAILED.
 *
 * The platform settles such a run on the first read of its record and starts
 * the store once more; the record this call dispatched then reads `failed`
 * and names the retry in `retriedAs`. Judging that record would answer
 * submit-failed and tell the person to submit again, which is the second
 * submission the retry exists to spare them. So the judge moves the store's
 * id to the retry, keeps waiting, and later reads judge the retry's own
 * record; a retry is never retried, so its own failure is a real one.
 */
/* @invariant A SUBMIT OF SEVERAL STORES ANSWERS ONE OUTCOME PER STORE.
 * Rebeccat 2026-10-29: a three-store draft upload answered one outcome whose
 * status read "chrome: draft; edge: draft; safari: draft" with no store state,
 * so an agent had to parse a sentence to learn what each store holds. Each
 * store answers its own record: whether it settled, its status and store
 * state, the version the store received, the submission and its page; the
 * combined line stays the hint's sentence and leaves value.outcome.status.
 */
export function storeOutcomes(args: {
  stores: string[];
  byStore: Record<string, PlatformSubmission> | null;
  ids: Record<string, string>;
  checkedAt: string;
  trackUrl: (store: string) => string;
}): Record<string, Record<string, unknown>> {
  return Object.fromEntries(
    args.stores.map((store) => {
      const record = args.byStore?.[store];
      const own = record && (!args.ids[store] || record.id === args.ids[store]) ? record : undefined;
      const status = own ? String(own.status ?? "").trim().toLowerCase() : "";

      return [
        store,
        {
          recorded: Boolean(status) && !SUBMIT_PENDING.has(status),
          status: status || null,
          storeState: own?.storeUpload?.state ?? own?.storeReview?.state ?? null,
          ...(own?.storeUpload?.message ? { storeMessage: own.storeUpload.message } : {}),
          ...approvalRefundOf(own),
          storeVersion: own?.storeVersion?.packaged ?? null,
          checkedAt: args.checkedAt,
          source: "platform-record",
          submissionId: args.ids[store] || own?.id || null,
          trackUrl: args.trackUrl(store),
        },
      ];
    }),
  );
}

const PACKAGE_HELD_STATUSES = new Set(["draft", "uploaded"]);

function runStillGoing(record: PlatformSubmission): boolean {
  const status = String(record.run?.status ?? "").trim().toLowerCase();

  return Boolean(status) && status !== "completed" && record.run?.settled !== true;
}

/* @invariant A DRAFT UNDER A SAVED MODE THAT PUBLISHES IS NOT A SETTLED
 * RECORD. store.yml records the upload before its publish step runs, so under
 * Chrome's "public" mode the record reads draft for the seconds between the
 * two (ledger 480, 2026-11-09: answered at one second, published at thirty).
 * While the call still has waitSeconds, a draft or uploaded record of a store
 * whose saved mode sends the upload on, with no publish answer and no failed
 * step yet, is waited on like a pending one; a record whose run the platform
 * still reports as running is waited on the same way.
 */
export function awaitsRunPublish(store: string, record: PlatformSubmission | undefined, modes: ModeIds): boolean {
  if (!record || !runPublishesAfterUpload(store, modes)) return false;

  const status = String(record.status ?? "").trim().toLowerCase();

  return PACKAGE_HELD_STATUSES.has(status) && !record.publish && !record.failure && !uploadRefused(record.storeUpload);
}

function judgeSubmit(
  byStore: Record<string, PlatformSubmission>,
  stores: string[],
  ids: Record<string, string>,
  retried: Record<string, StoreRetry> = {},
  modes: ModeIds = {},
): Verdict {
  const settled: Array<{
    store: string;
    status: string;
    state: string | null;
    failed: boolean;
  }> = [];
  const waiting: string[] = [];

  for (const store of stores) {
    const record = byStore[store];
    const retriedAs = String(record?.retriedAs ?? "").trim();

    if (record && retriedAs && (!ids[store] || record.id === ids[store])) {
      retried[store] = { retryOf: String(record.id ?? "").trim(), submissionId: retriedAs };
      ids[store] = retriedAs;
      waiting.push(`${store}: ${RETRIED_SENTENCE}`);
      continue;
    }

    const status = record
      ? String(record.status ?? "")
          .trim()
          .toLowerCase()
      : "";

    if (
      !record ||
      (ids[store] && record.id !== ids[store]) ||
      !status ||
      SUBMIT_PENDING.has(status)
    ) {
      waiting.push(`${store}: ${status || "no record yet"}`);
      continue;
    }

    if (awaitsRunPublish(store, record, modes)) {
      waiting.push(`${store}: ${status}, the run goes on to publish it under the saved mode "${String(modes[store])}"`);
      continue;
    }

    if (!FAILED_STATUSES.has(status) && runStillGoing(record)) {
      waiting.push(`${store}: ${status}, the run is still going`);
      continue;
    }

    settled.push({
      store,
      status,
      state: record.storeUpload?.state ?? record.storeReview?.state ?? null,
      failed: FAILED_STATUSES.has(status) || uploadRefused(record.storeUpload),
    });
  }

  const summary = [
    ...settled.map((row) => `${row.store}: ${row.status}`),
    ...waiting,
  ].join("; ");
  if (waiting.length) return { kind: "waiting", status: summary };

  return {
    kind: "recorded",
    status: settled.length === 1 ? settled[0].status : summary,
    storeState: settled.length === 1 ? settled[0].state : null,
    failed: settled.every((row) => row.failed),
  };
}

function chromeItemOf(data: any): string {
  const rows = [
    ...(Array.isArray(data?.submissions) ? data.submissions : []),
    data?.stores?.chrome?.connection,
    data?.connection,
    data,
  ].filter(
    (row) =>
      row && typeof row === "object" && (!row.store || row.store === "chrome"),
  );

  for (const row of rows) {
    const url = chromeItemUrl(row as Record<string, unknown>);
    if (url) return url;
  }

  return "";
}

async function connectionPrecheck(
  args: SubmitToolArgs,
  browsers: string[],
  ref: ProjectRef | null,
  scope: { buildSha: string },
): Promise<{ refused: string | null; modes: ModeIds; reports: Record<string, Record<string, unknown>>; warnings: string[] }> {
  const read = await readConnectionsAndModes(
    {
      project: args.project,
      api: args.api,
      buildSha: scope.buildSha,
    },
    browsers,
  );
  const connections = read.connections;
  const modes: ModeIds = Object.fromEntries(
    Object.entries(read.modes).map(([store, mode]) => [store, mode.id]),
  );
  const blocked = browsers
    .map(
      (browser) =>
        connections[browser] &&
        rowFromConnection(browser, connections[browser]),
    )
    .find((row) => row && isConnectionState(row.state));
  const ctx = { ref, api: args.api, sha: scope.buildSha };

  if (!blocked) {
    const verdicts = read.api ? await browserBuildVerdicts(read.api, browsers, scope.buildSha, ctx) : {};
    const verdict = browsers.map((browser) => verdicts[browser]).find(Boolean);

    if (verdict) return { refused: browserBuildRefusal(verdict, browsers, scope.buildSha), modes, reports: read.reports, warnings: [] };

    const local = await localSubmitPrecheck({ api: read.api, browsers, buildSha: scope.buildSha, projectPath: args.projectPath, ref, apiBase: args.api });
    if (local.refused) return { refused: local.refused, modes, reports: read.reports, warnings: local.warnings };

    const dryRun = read.api && !String(args.approvalId ?? "").trim() ? await dryRunStoreRead(read.api, browsers, scope.buildSha) : null;
    const unavailable = dryRun?.fault ?? null;
    const agreement = browsers.includes("firefox") && dryRun?.body ? firefoxAgreementCheck(firefoxAgreementOf(dryRun.body)) : null;
    const refused = unavailable
      ? platformUnavailableAnswer({ command: "extension_submit", found: unavailable, dryRun: false, ref, stores: browsers, buildSha: scope.buildSha })
      : agreement && agreement.status === "fail"
        ? localCheckRefusal([{ store: "firefox", row: agreement }], { api: read.api, browsers, buildSha: scope.buildSha, projectPath: args.projectPath, ref, apiBase: args.api })
        : null;
    const warnings = agreement && agreement.status === "warn" ? [...local.warnings, String(agreement.message)] : local.warnings;

    return { refused, modes, reports: read.reports, warnings };
  }

  const step = connectionStep(blocked, connections[blocked.browser], ctx);
  const settingsUrl = storeSettingsUrl(ref, args.api);
  const linked = blocked.state === "store-item-not-linked";
  const firstSubmission = blocked.state === "first-submission-in-partner-center";
  const packageScope = { ...ctx, browser: blocked.browser };
  const linkAnswer = linked
    ? linkItemAnswer(itemLinkUrls([connections[blocked.browser]], settingsUrl, packageScope), chromeItemLeftOf(connections[blocked.browser], read.reports[blocked.browser]))
    : { sayToPerson: step.say, nextStep: step, hint: step.say };

  const refused = envelope({
    ok: false,
    command: "extension_submit",
    status: blocked.state,
    error: {
      code: "E_PLATFORM",
      name: linked ? "StoreItemNotLinked" : firstSubmission ? "FirstSubmissionInPartnerCenter" : "StoreNotConnected",
      message: `${blocked.reason} Nothing was submitted and no approval was asked for.`,
    },
    value: {
      browsers,
      buildSha: scope.buildSha,
      verdict: blocked.state,
      ...(linked
        ? itemLinkUrls([connections[blocked.browser]], settingsUrl, packageScope)
        : { connectUrl: step.url }),
      trackUrl: settingsUrl,
      sayToPerson: linkAnswer.sayToPerson,
      nextStep: linkAnswer.nextStep,
    },
    hint: linkAnswer.hint,
    ...(linked && blocked.browser === "chrome" ? { warnings: [CHROME_SLOTS_SENTENCE] } : {}),
  });

  return { refused, modes, reports: read.reports, warnings: [] };
}

async function answer(args: SubmitToolArgs): Promise<string> {
  if (args.action === "status") return storeVersionStatus(args);
  if (args.action === "preflight") return readPreflight(args);
  if (args.action === "cancel") return cancelSubmission(args);
  if (args.action === "rollout") return raiseRollout(args);
  if (args.action === "release") return releaseVersion(args);
  if (args.action === CONFIGURE_STORE) return configureStore(args);
  if (args.action === "connect") return connectStoreAccount(args);
  if (args.action === FIRST_SUBMISSION_ACTION) return openFirstSubmission(args);
  if (args.action === MINT_SIGNING_ACTION) return mintSigning(args);

  if (args.action && PUBLISH_ACTIONS.has(args.action)) {
    return publishDraft(args);
  }

  if (args.action === "sync-listing") {
    return withReviewPromise(await syncListing(args));
  }

  if (args.action !== undefined && args.action !== "submit") {
    return fail(
      "SubmitInputError",
      `action must be one of ${SUBMIT_ACTIONS.join(", ")} (review is an alias of publish); got "${args.action}". Nothing was sent. ${invalidArgumentsHint([{ path: "action", message: "" }])}`,
      "bad-request",
      "E_BAD_REQUEST",
    );
  }

  const credential = resolveCredential({
    project: args.project,
    api: args.api,
  });
  const token = credential.token;

  if (!token && credential.expired) {
    return expiredLoginRefusal({ command: "extension_submit", expired: credential.expired, api: args.api, extra: { action: "submit" } });
  }

  if (!token && args.project) {
    return fail(
      "SubmitAuthError",
      noStoredLoginHint(args.project),
      "auth-required",
      "E_AUTH_REQUIRED",
    );
  }

  if (!token) {
    return fail(
      "SubmitAuthError",
      "No token. Run extension_auth (action: login), or set EXTENSION_DEV_TOKEN (create one in the extension.dev dashboard under project settings -> Access tokens; tokens live at most 7 days, so CI must re-mint before expiry).",
      "auth-required",
      "E_AUTH_REQUIRED",
    );
  }

  const browsers = (Array.isArray(args.browsers) ? args.browsers : [])
    .map((b) => String(b).trim().toLowerCase())
    .filter(Boolean);

  if (browsers.length === 0) {
    return fail(
      "SubmitInputError",
      'browsers is required (e.g. ["chrome","firefox","edge","safari"]).',
      "bad-request",
      "E_BAD_REQUEST",
    );
  }

  const buildSha = String(args.buildSha || "").trim();

  if (!buildSha) {
    return fail(
      "SubmitInputError",
      "buildSha is required (the built commit to submit).",
      "bad-request",
      "E_BAD_REQUEST",
    );
  }

  const apiCheck = safeApiBase(resolveApiBase(args.api), args.api);

  if (!apiCheck.ok) {
    return fail(
      "SubmitConfigError",
      apiCheck.message,
      "bad-config",
      "E_CONFIG",
    );
  }

  const url = `${apiCheck.base}/api/cli/stores/submit`;

  const dryRun = args.dryRun !== false;
  const body: Record<string, unknown> = { browsers, buildSha, dryRun };
  if (args.version) body.version = String(args.version).trim();

  let modes: ModeIds = {};
  let localWarnings: string[] = [];
  let safariRelease = "";
  let firefoxSetting: string | undefined;

  const version = String(args.version || "").trim();

  const gateInputFor = (known: ModeIds) => {
    const drafts = browsers.every((browser) => uploadStopsAtDraft(browser, known[browser]));
    const broad = browsers.filter((browser) => DRAFT_STORES.has(browser) && !uploadStopsAtDraft(browser, known[browser]));
    const safariReview = safariReviewCovers(browsers, known);
    const perVersion = browsers.length > 1 || safariReview;
    const lines = [
      ...browsers.map((store) => ({ store, act: "upload" })),
      ...(safariReview ? [{ store: "safari", act: "publish" }] : []),
    ];
    const modeClause = drafts
      ? ": each upload stops at the store's draft under the saved submission mode"
      : broad.length > 0
        ? `: the saved ${broad.map((store) => `${store} mode "${known[store]}"`).join(" and ")} sends the upload on to review`
        : "";
    const reviewClause = safariReview ? safariReviewLineClause(safariRelease) : "";

    return {
      command: "extension_submit",
      action: perVersion ? VERSION_ACTION : "extension_submit",
      scope: perVersion
        ? versionScopeFor(lines, buildSha, version)
        : {
            browsers: [...browsers].sort(),
            buildSha: buildSha.toLowerCase(),
          },
      description: perVersion
        ? `Send build ${buildSha}${version ? ` (version ${version})` : ""} to ${browsers.join(", ")} under one approval, one line per store that the owner can leave out${modeClause}${reviewClause}. A store keeps an uploaded package, so an upload cannot be undone.`
        : drafts
          ? `Upload build ${buildSha} to ${browsers.join(", ")} as a store draft: not published and not sent to review under the saved submission mode. The store keeps the uploaded package, so the upload itself cannot be undone.`
          : broad.length > 0
            ? `Submit build ${buildSha} to ${browsers.join(", ")} for store review: the saved ${broad.map((store) => `${store} mode "${known[store]}"`).join(" and ")} sends the upload on to review.`
            : `Submit build ${buildSha} to ${browsers.join(", ")} for store review.`,
      nextCall: {
        tool: "extension_submit",
        args: { action: "submit", dryRun: false, browsers, buildSha, ...(version ? { version } : {}) },
        waits: true,
      },
      approvalId: args.approvalId,
      token,
      ref: credential.ref,
      api: args.api,
      refusedStatus: "submit-failed",
      irreversible: true,
    };
  };

  const asked = (out: string) => {
    const sentence = reviewPromiseFromApproval(out, browsers, modes);

    return withApproveStep(sentence ? withReviewPromise(out, sentence) : out, sentence);
  };

  if (!dryRun) {
    const precheck = await connectionPrecheck(args, browsers, credential.ref, {
      buildSha,
    });
    if (precheck.refused) return precheck.refused;

    modes = precheck.modes;
    localWarnings = precheck.warnings;
    if (safariReviewCovers(browsers, modes)) safariRelease = safariApprovalReleaseSentence(await readSafariReleaseIntentFor({ command: "extension_submit", project: args.project, api: args.api }));

    firefoxSetting = sourceArchiveOf(precheck.reports.firefox ?? {})?.setting;

    const gate = await evaluateApproval({
      ...gateInputFor(modes),
      enabled: approvalGateEnabled(true),
    });
    if (gate.blocked) return appendWarnings(asked(gate.envelope), localWarnings);

    const approvalId =
      gate.approvalId ??
      (args.approvalId ? String(args.approvalId).trim() : "");
    if (approvalId) body.approvalId = approvalId;
  }

  const statusRead = `extension_release_status (include: ['stores']${
    args.project ? `, project: '${args.project}'` : ""
  })`;

  const startedAt = Date.now();
  const sent = await platformFetch(
    url,
    {
      method: "POST",
      headers: {
        ...bearerHeaders(token, credential.ref),
        "content-type": "application/json",
        ...identityHeaders("extension_submit"),
      },
      body: JSON.stringify(body),
    },
    { kind: "dispatch", ...(dryRun ? {} : { boundMs: submitDispatchBoundMs(browsers.length, args.waitSeconds) }) },
  );

  if (!sent.ok) {
    const unreached = sent.unreached.message;

    if (!dryRun) {
      const read = await readStoresAfterUnconfirmed({
        api: { base: apiCheck.base, token, command: "extension_submit" },
        browsers,
        startedAt,
      });

      return envelope({
        ok: false,
        command: "extension_submit",
        status: "submit-unconfirmed",
        error: {
          code: "E_NETWORK",
          name: "SubmitUnconfirmed",
          message: `The submission request for ${browsers.join(", ")} left this machine and no answer came back (${unreached}), so whether any store was submitted is unknown from the answer; value.stores says per store whether a submission newer than this call is recorded.`,
        },
        value: {
          browsers,
          buildSha,
          stores: read.stores,
          submittedStores: read.went,
          missingStores: read.stayed,
          readAt: read.readAt,
          ...(read.readProblem ? { readProblem: read.readProblem } : {}),
        },
        hint: unconfirmedStoresHint(read, statusRead),
      });
    }

    return fail("SubmitNetworkError", unreached, "network-failed", "E_NETWORK");
  }

  const res = sent.res;
  const text = await res.text();
  let data: any;

  try {
    data = JSON.parse(text);
  } catch {
    data = { message: text };
  }

  if (!res.ok) {
    if (sawPlatformHold(res, data)) {
      return platformHoldEnvelope({
        command: "extension_submit",
        name: "SubmitHeld",
        body: data,
        api: args.api,
        value: { browsers, buildSha, dryRun },
      });
    }

    const unavailable = storeRunUnavailable(res.status, data);

    if (unavailable) {
      return platformUnavailableAnswer({
        command: "extension_submit",
        found: unavailable,
        dryRun,
        ref: credential.ref,
        stores: browsers,
        buildSha,
        ...(body.approvalId ? { approvalId: String(body.approvalId), refundSaid: data?.approvalRefunded } : {}),
      });
    }

    const installRefused = storeRefusedInstall(res.status, data);

    if (installRefused) {
      return installRefusedAnswer({
        command: "extension_submit",
        found: installRefused,
        dryRun,
        ref: credential.ref,
        stores: browsers,
        buildSha,
        api: args.api,
        ...(body.approvalId ? { approvalId: String(body.approvalId), refundSaid: data?.approvalRefunded } : {}),
      });
    }

    const refusedCode = typeof data?.code === "string" ? data.code : "";

    if (refusedCode === ITEM_NOT_LINKED_CODE) {
      const settingsUrl = storeSettingsUrl(credential.ref, args.api);
      const urls = itemLinkUrls([data, data?.connection], settingsUrl, { ref: credential.ref, sha: buildSha, browser: browsers[0] || "chrome", api: args.api });
      const linkAnswer = linkItemAnswer(urls);

      return envelope({
        ok: false,
        command: "extension_submit",
        status: "store-item-not-linked",
        error: {
          code: "E_PLATFORM",
          name: "StoreItemNotLinked",
          message:
            "No Chrome Web Store item is linked to this project yet, so nothing was submitted by this call.",
          platformCode: refusedCode,
        },
        value: {
          browsers,
          buildSha,
          ...urls,
          trackUrl: settingsUrl,
          sayToPerson: linkAnswer.sayToPerson,
          nextStep: linkAnswer.nextStep,
        },
        hint: linkAnswer.hint,
      });
    }

    const incomplete = refusedCode === LISTING_INCOMPLETE_CODE ? listingIncompleteOf(refusedCode, data, browsers[0] || "chrome") : null;

    if (incomplete) {
      const store = incomplete.store;
      const trackUrl = consoleTrackUrl(
        "store",
        { ...(credential.ref ? { workspace: credential.ref.workspace, project: credential.ref.project } : {}), store },
        args.api,
      );
      const name = STORE_WORDS[store] ?? store;
      const say = `${listingIncompleteSentence(incomplete, name)}${incomplete.bringList ? ` ${incomplete.bringList.say}` : ""}`;
      const needsImage = incomplete.missing.some((row) => /\.screenshots$/.test(row.id));

      return envelope({
        ok: false,
        command: "extension_submit",
        status: "listing-incomplete",
        error: { code: "E_PLATFORM", name: "ListingIncomplete", platformCode: refusedCode, message: data?.message || say },
        value: {
          browsers,
          buildSha,
          store,
          refusedBeforeApproval: true,
          missing: incomplete.missing,
          ...(incomplete.bringList ? { bringList: incomplete.bringList } : {}),
          trackUrl,
          sayToPerson: say,
          nextStep: nextStep(needsImage ? "screenshot" : "sync-listing", say, trackUrl),
        },
        hint: `${say} ${needsImage ? `${screenshotDoor(store)}. ` : ""}Fill the rows, run extension_submit action:"sync-listing" for ${store}, then submit again; the preflight reads the same rows.`,
      });
    }

    if (refusedCode === EDGE_PACKAGE_HAS_ARCHIVES_CODE) {
      const files = (Array.isArray(data?.files) ? data.files : [])
        .map((file: unknown) => String(file ?? "").trim())
        .filter(Boolean);
      const buildUrl = consoleTrackUrl(
        "build",
        {
          ...(credential.ref
            ? { workspace: credential.ref.workspace, project: credential.ref.project }
            : {}),
          buildId: buildSha,
          browser: "edge",
        },
        args.api,
      );
      const say = packageRefusedSentences({ buildSha, files, buildUrl });

      return envelope({
        ok: false,
        command: "extension_submit",
        status: "package-refused",
        error: {
          code: "E_PLATFORM",
          name: "EdgePackageRefused",
          message:
            "The Edge package carries compressed files, which Partner Center refuses in an extension package, so nothing was submitted by this call.",
          platformCode: refusedCode,
        },
        value: {
          browsers,
          buildSha,
          store: "edge",
          files,
          trackUrl: buildUrl,
          sayToPerson: say,
          nextStep: nextStep("resubmit", say, buildUrl),
        },
        hint: say,
      });
    }

    if (
      NOT_CONNECTED_CODES.has(refusedCode) ||
      (typeof data?.connectUrl === "string" && data.connectUrl.trim())
    ) {
      const settingsUrl = storeSettingsUrl(credential.ref, args.api);
      const connectUrl =
        (typeof data?.connectUrl === "string" && data.connectUrl.trim()) ||
        fallbackConnectUrl(credential.ref, "chrome", args.api);
      const failedCheck = refusedCode === "STORE_CONNECTION_UNHEALTHY";
      const say = failedCheck
        ? `${failedCheckSentence(typeof data?.reason === "string" ? data.reason : typeof data?.message === "string" ? data.message : "")} ${connectSentences(connectUrl)}`
        : connectSentences(connectUrl);

      return envelope({
        ok: false,
        command: "extension_submit",
        status: failedCheck ? "store-connection-failed" : "store-not-connected",
        error: {
          code: "E_PLATFORM",
          name: "StoreNotConnected",
          message: failedCheck
            ? "The Chrome Web Store connection failed its last check, so nothing was submitted by this call."
            : "The Chrome Web Store is not connected to this project, so nothing was submitted by this call.",
          ...(refusedCode ? { platformCode: refusedCode } : {}),
        },
        value: {
          browsers,
          buildSha,
          connectUrl,
          trackUrl: settingsUrl,
          sayToPerson: say,
          nextStep: nextStep("connect", say, connectUrl),
        },
        hint: say,
      });
    }

    if (!dryRun && !args.approvalId && platformRequiresApproval(res, data)) {
      return asked(await requestApprovalAfterRefusal(gateInputFor(modes)));
    }

    const refusedLines = readLines(data?.lines);
    const lineValue = refusedLines.length ? { lines: refusedLines } : {};
    const leftOut = storesInState(refusedLines, "denied");
    const answered =
      !dryRun && body.approvalId
        ? approvalRoundTrip({
            command: "extension_submit",
            platformCode: typeof data?.code === "string" ? data.code : "",
            message: typeof data?.message === "string" ? data.message : "",
            approvalId: String(body.approvalId),
            undone: refusedLines.length
              ? `Nothing was submitted by this call (${linesSentence(refusedLines)}).`
              : "Nothing was submitted by this call.",
            api: args.api,
            value: { browsers, buildSha, ...lineValue },
            stateRead: statusRead,
            ...(leftOut.length
              ? {
                  next: {
                    declined: `The owner left ${leftOut.join(", ")} out on the approval page, so nothing ran for ${leftOut.length === 1 ? "it" : "them"}. Ask the person before requesting a fresh approval by calling again with no approvalId.`,
                  },
                }
              : {}),
          })
        : undefined;

    if (answered) return answered;

    const saidNothingDispatched = data?.retryable === true;
    const maybeDispatched =
      !dryRun && res.status >= 500 && !saidNothingDispatched;
    const BEFORE_APPROVAL = new Set([
      LISTING_INCOMPLETE_CODE,
      "BUILD_DISPATCH_DISABLED",
      "OWNER_REQUIRED",
      "TOKEN_ISSUER_UNKNOWN",
      "APPROVAL_REQUIRED",
      "APPROVAL_NOT_FOUND",
      "APPROVAL_SCOPE_MISMATCH",
      "APPROVAL_USED",
      "APPROVAL_EXPIRED",
    ]);
    const platformCode = typeof data?.code === "string" ? data.code : "";
    const approvalRefunded =
      !dryRun && Boolean(body.approvalId) && data?.approvalRefunded === true;
    const approvalSpent =
      !dryRun &&
      Boolean(body.approvalId) &&
      res.status < 500 &&
      data?.refusedBeforeApproval !== true &&
      !BEFORE_APPROVAL.has(platformCode) &&
      !approvalRefunded;
    const retry = retryStores(refusedLines);
    const priced = pricedRefusal(platformCode, data);
    const upgradeValue = priced?.upgradeUrl ? { upgradeUrl: priced.upgradeUrl } : {};

    return envelope({
      ok: false,
      command: "extension_submit",
      status: "submit-failed",
      ...(approvalRefunded
        ? {
            value: {
              browsers,
              buildSha,
              approvalId: String(body.approvalId),
              approvalRefunded: true,
              ...lineValue,
              ...upgradeValue,
              sayToPerson: REFUNDED_SAY,
              nextStep: REFUNDED_STEP,
            },
          }
        : refusedLines.length
          ? { value: { browsers, buildSha, approvalId: String(body.approvalId), ...lineValue, ...upgradeValue } }
          : priced?.upgradeUrl
            ? { value: { browsers, buildSha, ...upgradeValue } }
            : {}),
      error: {
        code: "E_PLATFORM",
        name: "SubmitError",
        message: priced ? priced.hint : `${dryRun ? "preflight" : "submit"} failed (${res.status}): ${data?.message || text || "unknown error"}`,
        ...(typeof data?.code === "string" ? { platformCode: data.code } : {}),
      },
      ...(approvalRefunded && refusedLines.length
        ? {
            hint: `The platform could not start a store run and says nothing ran for it, so that line was given back (${linesSentence(refusedLines)}): call again with the same approvalId ${String(body.approvalId)} and browsers limited to ${retry.join(", ") || "the stores that did not run"}.`,
          }
        : approvalRefunded
        ? {
            hint: `The platform could not start the store run and says nothing was dispatched, so the approval was not spent: call again with the same arguments and approvalId ${String(body.approvalId)}.`,
          }
        : maybeDispatched
          ? {
              hint: `The platform failed after the request was accepted, and it dispatches each store before it records it, so ${
                browsers.length === 1
                  ? browsers[0]
                  : `one or more of ${browsers.join(", ")}`
              } may already be submitted. Read ${statusRead} before submitting again.`,
            }
          : saidNothingDispatched
            ? {
                hint: `The platform says nothing was dispatched or recorded and that this call can be repeated as it is${
                  res.headers.get("retry-after")
                    ? `, after ${res.headers.get("retry-after")} seconds`
                    : ""
                }.`,
              }
            : approvalSpent
              ? {
                  hint: `The approval presented with this call was spent by the platform before this refusal (it consumes the grant once the owner, runner-class, dispatch-pause and allowance checks pass, and ${platformCode || "this refusal"} came after). Fix the cause, then call again with no approvalId to request a fresh approval.`,
                }
              : {}),
    });
  }

  const warnings: Array<string | null | undefined | false> = Array.isArray(
    data?.warnings,
  )
    ? (data.warnings as unknown[]).map((w) => {
        if (typeof w === "string") return w;
        if (!w || typeof w !== "object") return null;

        const row = w as {
          code?: unknown;
          store?: unknown;
          message?: unknown;
          docsUrl?: unknown;
        };
        const rowText = String(row.message ?? row.code ?? "").trim();
        if (!rowText) return null;

        return `${row.store ? `${String(row.store)}: ` : ""}${rowText}${row.docsUrl ? ` (${String(row.docsUrl)})` : ""}`;
      })
    : [];
  warnings.push(
    ...storeMdWarnings(
      browsers,
      String(args.projectPath || "").trim() || process.cwd(),
    ),
    ...localWarnings,
  );

  const result: Record<string, unknown> = { mode: "platform", dryRun, ...data };
  delete result.ok;
  delete result.warnings;
  delete result.message;
  const platformOk = data?.ok !== false;
  let ok = platformOk;
  let message = typeof data?.message === "string" ? data.message : "";
  let statusNote: string | null = null;
  const platformChannel = typeof data?.channel === "string" ? data.channel.trim() : "";

  if (dryRun) {
    const ref = credential.ref;
    const ctx = { ref, api: args.api, sha: buildSha };
    const consoleStoresUrl = consoleProjectUrl(
      ref,
      ConsoleProjectPage.submissions,
      args.api,
    );
    const storePageUrl =
      browsers.length === 1
        ? consoleProjectUrl(
            ref,
            ConsoleProjectPage.store(browsers[0]),
            args.api,
          )
        : consoleStoresUrl;
    const { rows, connections } = await readStoreRows(
      {
        project: args.project,
        api: args.api,
        buildSha,
      },
      browsers,
      ctx,
    );

    const verdict = dryRunVerdict(
      rows,
      {
        ok: platformOk,
        message: typeof data?.message === "string" ? data.message : "",
      },
      connections,
      { ...ctx, storePageUrl },
    );
    const ready = rows.filter((row) => row.ok).map((row) => row.browser);
    const checked =
      verdict.verdict === "ready" || verdict.verdict === "not-checked"
        ? ` The platform verified the token and project and read build ${data?.buildId ?? buildSha}${ready.length ? `, and ${ready.join(", ")} passed ${ready.length > 1 ? "their" : "its"} store connection check` : ""}. Not checked by a dry run: the owner gate, the approval, the build quota, the dispatch pause and the submission mode, which the real run checks first.`
        : "";

    ok = verdict.ok;
    result.verdict = verdict.verdict;
    result.preflight = rows;
    result.nextStep = verdict.nextStep;
    result.trackUrl = verdict.trackUrl;

    const agreement = browsers.includes("firefox") ? firefoxAgreementCheck(firefoxAgreementOf(data)) : null;

    if (agreement && agreement.status === "fail" && verdict.ok) {
      ok = false;
      result.verdict = LOCAL_CHECK_FAILED_STATE;
      result.nextStep = nextStep("configure", String(agreement.message), FIREFOX_AGREEMENT_URL);
      result.trackUrl = FIREFOX_AGREEMENT_URL;
      result.firefoxAgreement = agreement;
    } else if (agreement) {
      warnings.push(String(agreement.message));
    }

    if (platformChannel) result.channel = platformChannel;
    else delete result.channel;

    result.consoleStoresUrl = consoleStoresUrl;

    if (typeof data?.message === "string") {
      result.platformMessage = data.message;
    }

    const itemUrl = rows.find((row) => row.itemUrl)?.itemUrl;
    if (itemUrl) result.itemUrl = itemUrl;

    const modesRead = rows.filter((row) => row.publishMode !== NOT_CHECKED);
    const modesUnread = rows.filter((row) => row.publishMode === NOT_CHECKED).map((row) => row.browser);
    const modeLine = modesRead.length
      ? ` Saved submission mode: ${modesRead.map((row) => `${row.browser} ${row.publishMode}`).join(", ")}.`
      : "";
    const versioned = rows.filter((row) => row.nextVersion);
    const versionLine = versioned
      .map((row) => nextVersionSentence(row.browser, { nextVersion: row.nextVersion as string, landing: row.landing }))
      .join(" ");

    if (versioned.length) {
      result.nextVersions = Object.fromEntries(versioned.map((row) => [row.browser, row.nextVersion]));
    }

    if (modesUnread.length) {
      warnings.push(
        `The platform's preflight did not answer the submission mode of ${modesUnread.join(", ")}, so this dry run cannot name it; the per-store settings are at ${consoleStoresUrl}.`,
      );
    }

    message = result.firefoxAgreement
      ? `Not ready for firefox: ${String(agreement?.message)}`
      : `${verdict.say}${checked}${modeLine}${versionLine ? ` ${versionLine}` : ""}`;
  }

  if (!dryRun) {
    const lines = readLines(data?.lines);
    const ran = lines.length
      ? browsers.filter((store) => lines.some((line) => line.store === store && line.state === "spent"))
      : browsers;
    const outcome = readSubmitOutcome(data, ran);
    const coveredApproval = safariReviewCovers(browsers, modes) && ran.includes("safari") ? String(body.approvalId ?? "") : "";
    const coveredLine = coveredApproval
      ? ` The safari publish line of approval ${coveredApproval} still stands: once TestFlight holds the build (${statusRead} shows it), call extension_submit action "publish" with browsers ["safari"] and approvalId ${coveredApproval}; it spends that line and asks no second approval. ${safariRelease || safariApprovalReleaseSentence(null)}`
      : "";

    if (coveredApproval) result.approvalCovers = { approvalId: coveredApproval, lines: ["safari:publish"], say: coveredLine.trim() };

    if (lines.length) {
      result.lines = lines;
      warnings.push(`Approval lines: ${linesSentence(lines)}.`);

      for (const store of storesInState(lines, "denied")) {
        warnings.push(`NOT submitted: ${store}. The owner left it out on the approval page; ask before requesting a fresh approval for it.`);
      }
    }

    if (outcome.state === "unconfirmed") {
      return envelope({
        ok: false,
        command: "extension_submit",
        status: "submit-unconfirmed",
        error: {
          code: "E_PLATFORM",
          name: "SubmitUnconfirmed",
          message: `The platform answered ${res.status} but ${outcome.why}, so whether ${browsers.join(", ")} ${browsers.length === 1 ? "was" : "were"} submitted is unknown.`,
        },
        value: { browsers, buildSha, platform: data },
        hint: `Do not submit again blind: a store that was dispatched would be submitted twice. Read ${statusRead} first and submit only the stores with no new submission.`,
      });
    }

    if (outcome.state === "refused") {
      return envelope({
        ok: false,
        command: "extension_submit",
        status: "submit-refused",
        error: {
          code: "E_PLATFORM",
          name: "SubmitRefused",
          message: message || "The platform refused the submission.",
        },
        value: result,
        warnings,
      });
    }

    statusNote = `Track this submission with ${statusRead}: the record appears in the registry's stores/submissions.json when the store workflow reports, so a read right after this answer may still show none; that is not a reason to submit again.`;

    /* @invariant A STORE LOCKED BY A REVIEW IN PROGRESS QUEUES THE ACT, AND
     * THE QUEUE IS THE RECORD (decision C, 2026-10-28). A submission row the
     * platform answered as queued carries the lock's store word, the sentence
     * for when it clears and when the platform last checked; it is not waited
     * on as a submission record, because none exists yet, and it is answered
     * recorded with status queued. When every store asked for was queued the
     * answer is submit-queued; when some were sent, those are waited on as
     * before and the queued ones are said beside them.
     */
    const queuedActs: QueuedStoreActView[] = (
      Array.isArray(data?.submissions) ? data.submissions : []
    )
      .filter((row: unknown) => isRow(row) && String(row.status ?? "").toLowerCase() === "queued")
      .map((row: Record<string, unknown>) => queuedActOf({ ...(isRow(row.queued) ? row.queued : {}), store: row.store }))
      .filter((act: QueuedStoreActView | undefined): act is QueuedStoreActView => Boolean(act));
    const queuedStores = queuedActs.map((act) => act.store);

    if (queuedStores.length) {
      outcome.stores = outcome.stores.filter((store) => !queuedStores.includes(store));
      result.queued = queuedActs;
      result.queuedStores = queuedStores;
    }

    result.submittedStores = outcome.stores;

    if (queuedStores.length && outcome.stores.length === 0) {
      const first = queuedActs[0]!;
      const queuedPage = consoleProjectUrl(
        credential.ref,
        ConsoleProjectPage.submissionsStore(first.store),
        args.api,
      );
      const queuedLines = queuedActs.map(
        (act) => `${act.store}: ${queuedActSentence(act)}; it sends on its own once ${act.clearsWhen}`,
      );
      const say = `${queuedLines.join(". ")}. The approval stays bound to the queued ${queuedActs.length === 1 ? "act" : "acts"}; nothing was sent and nothing needs to be submitted again. Read ${statusRead} to follow it.`;

      result.outcome = recordedOutcome("queued", first.storeWord);
      result.links = linksOf([{ kind: "submission", url: queuedPage }]);
      result.nextStep = { kind: "watch", say, url: queuedPage };
      result.sayToPerson = say;

      return envelope({
        ok: true,
        command: "extension_submit",
        status: "submit-queued",
        value: result,
        hint: say,
        warnings: [...warnings, credential.note],
      });
    }

    const queuedLine = queuedActs.length
      ? ` ${queuedActs.map((act) => `${act.store}: ${queuedActSentence(act)}; it sends on its own once ${act.clearsWhen}`).join(". ")}.`
      : "";

    const itemUrl = outcome.stores.includes("chrome") ? chromeItemOf(data) : "";
    if (itemUrl) result.itemUrl = itemUrl;

    result.allowance = spendNarration({
      what: "This submission",
      body: data,
      api: args.api,
    });

    const acceptedAt =
      typeof data?.dispatchedAt === "string" && data.dispatchedAt
        ? data.dispatchedAt
        : stampNow();
    const rows = (
      Array.isArray(data?.submissions) ? data.submissions : []
    ).filter((row: unknown) => row && typeof row === "object") as Array<
      Record<string, unknown>
    >;
    const ids: Record<string, string> = {};

    for (const row of rows) {
      const store = String(row.store ?? "")
        .trim()
        .toLowerCase();
      const id = String(row.id ?? row.submissionId ?? "").trim();
      if (store && id) ids[store] = id;
    }

    const refTarget = credential.ref
      ? { workspace: credential.ref.workspace, project: credential.ref.project }
      : {};
    const links: ActLink[] = linksOf([
      ...outcome.stores.map((store) => ({
        kind: "submission" as const,
        url: consoleTrackUrl(
          "submission",
          { ...refTarget, store, submissionId: ids[store] },
          args.api,
        ),
        made: Boolean(ids[store]),
      })),
      ...(itemUrl
        ? [{ kind: "item" as const, url: itemUrl, audience: "you" as const }]
        : []),
    ]);
    const retried: Record<string, StoreRetry> = {};
    const openingPage =
      links.find((link) => link.kind === "submission")?.url ??
      consoleProjectUrl(
        credential.ref,
        ConsoleProjectPage.submissions,
        args.api,
      );
    const waited = await awaitRecordedOutcome<
      Record<string, PlatformSubmission>
    >({
      waitSeconds: args.waitSeconds,
      read: () =>
        readSubmissionRecords({
          base: apiCheck.base,
          token,
          command: "extension_submit",
        }),
      judge: (byStore) => judgeSubmit(byStore, outcome.stores, ids, retried, modes),
    });
    const retries = Object.entries(retried).map(([store, row]) => ({
      store,
      retryOf: row.retryOf,
      submissionId: row.submissionId,
      trackUrl: consoleTrackUrl(
        "submission",
        { ...refTarget, store, submissionId: row.submissionId },
        args.api,
      ),
    }));
    const actLinks: ActLink[] = retries.length
      ? [
          ...linksOf(
            retries.map((row) => ({
              kind: "submission" as const,
              url: row.trackUrl,
              made: true,
            })),
          ),
          ...links,
        ]
      : links;
    const firstPage = retries[0]?.trackUrl ?? openingPage;
    const retryLine = retries.length
      ? `${retries.map((row) => row.store).join(", ")}: ${RETRIED_SENTENCE}`
      : "";
    const made = [retryLine, madeSentence(actLinks)].filter(Boolean).join(" ");

    if (retries.length) result.retried = retries;

    const failedStores = waited.outcome.recorded
      ? outcome.stores.filter(
          (store) =>
            FAILED_STATUSES.has(String(waited.record?.[store]?.status ?? "").toLowerCase()) ||
            uploadRefused(waited.record?.[store]?.storeUpload),
        )
      : [];
    const failureLines = failedStores.map((store) =>
      failureLineOf(store, waited.record?.[store]?.storeUpload, String(waited.record?.[store]?.failureReason ?? "")),
    );

    const uploadedFailures = waited.outcome.recorded
      ? outcome.stores
          .map((store) => ({ store, record: waited.record?.[store] }))
          .filter(
            (row) =>
              String(row.record?.status ?? "").toLowerCase() === "uploaded" &&
              Boolean(row.record?.failure?.step),
          )
      : [];
    const awaitingPublish = outcome.stores.filter((store) => awaitsRunPublish(store, waited.record?.[store], modes));
    const publishRefusals = waited.outcome.recorded
      ? outcome.stores
          .filter((store) => runPublishesAfterUpload(store, modes) && String(waited.record?.[store]?.publish?.status ?? "").toLowerCase() === "failed")
          .map((store) => ({ store, message: String(waited.record?.[store]?.publish?.storeMessage ?? "") }))
      : [];
    const judgedStep = !waited.outcome.recorded
      ? awaitingPublish.length
        ? runPublishesStep(awaitingPublish, modes, false, firstPage)
        : dispatchedStep(outcome.stores, firstPage)
      : failedStores.length
        ? submitFailedStep(failureLines, firstPage)
        : uploadedFailures.length
          ? uploadedStepFailedStep(
              uploadedFailures.map((row) => row.store),
              uploadedFailures.map((row) => String(row.record?.failure?.step)).join("; "),
              firstPage,
            )
          : publishRefusals.length
            ? runPublishRefusedStep(publishRefusals, firstPage)
            : withSafariPublishStep(
                doneStep(
                  outcome.stores,
                  itemUrl,
                  outcome.stores.filter((store) => uploadTaken(waited.record?.[store]?.storeUpload)),
                  modes,
                ),
                { stores: outcome.stores, approvalId: coveredApproval, statusRead },
              );
    const refundLine = failedStores
      .map((store) => ({ store, sentence: approvalRefundSentence(waited.record?.[store]) }))
      .filter((row) => row.sentence)
      .map((row) => `${row.store}: ${row.sentence}.`)
      .join(" ");
    const step = {
      ...judgedStep,
      say: [retryLine, judgedStep.say, refundLine].filter(Boolean).join(" "),
    };

    const storeVersions = Object.fromEntries(
      outcome.stores
        .map((store) => [store, waited.record?.[store]?.storeVersion] as const)
        .filter((entry): entry is readonly [string, NonNullable<PlatformSubmission["storeVersion"]>] => Boolean(entry[1])),
    );

    const several = outcome.stores.length > 1;

    result.outcome = {
      ...waited.outcome,
      ...(several ? { status: null } : {}),
      ...(Object.keys(storeVersions).length
        ? { storeVersions: Object.fromEntries(Object.entries(storeVersions).map(([store, recorded]) => [store, recorded.packaged])) }
        : {}),
    };

    result.outcomes = storeOutcomes({
      stores: outcome.stores,
      byStore: waited.record,
      ids,
      checkedAt: waited.outcome.checkedAt,
      trackUrl: (store) => consoleTrackUrl("submission", { ...refTarget, store, submissionId: ids[store] }, args.api),
    });

    result.submissions = rowsWithSentVersion(result.submissions, storeVersions);

    result.links = actLinks;
    result.nextStep = step;
    result.sayToPerson = step.say;

    const firefoxSources = outcome.stores.includes("firefox")
      ? firefoxSourcesOutcome(
          waited.record?.firefox,
          firefoxSetting,
          firefoxConnectUrl(credential.ref, args.api),
        )
      : null;
    const firefoxUpdates = outcome.stores.includes("firefox")
      ? firefoxUpdateManifestOutcome(waited.record?.firefox as Record<string, unknown> | undefined, result.submissions)
      : null;
    const sourcesLine = `${firefoxSources ? ` ${firefoxSources.say}` : ""}${firefoxUpdates ? ` ${firefoxUpdates.say}` : ""}`;
    if (firefoxSources) result.firefoxSourceArchive = firefoxSources;
    if (firefoxUpdates) result.firefoxUpdateManifest = firefoxUpdates;

    const installRefusals = waited.failed ? installRefusedRecords(failedStores, waited.record) : null;

    if (installRefusals) {
      return installRefusedAfterRun({
        command: "extension_submit",
        refusals: installRefusals,
        result,
        ref: credential.ref,
        buildSha,
        statusRead,
        warnings: [...warnings, credential.note],
        api: args.api,
      });
    }

    if (waited.failed) {
      return envelope({
        ok: false,
        command: "extension_submit",
        status: "submit-failed",
        error: {
          code: "E_PLATFORM",
          name: "SubmitFailed",
          message: `The platform's record says the submission did not reach ${failedStores.join(", ")}: ${failureLines.join("; ")}.`,
        },
        value: result,
        hint: `Fix the cause and submit again; ${statusRead} reads the record. ${made}`,
        warnings: [...warnings, credential.note],
      });
    }

    if (outcome.state === "partial" || failedStores.length) {
      const missing = [
        ...new Set([
          ...(outcome.state === "partial" ? outcome.missing : []),
          ...failedStores,
        ]),
      ];
      result.missingStores = missing;

      return envelope({
        ok: true,
        command: "extension_submit",
        status: waited.outcome.recorded
          ? "submitted-partially"
          : "submit-dispatched",
        value: result,
        hint: `${
          waited.outcome.recorded
            ? `The platform's record confirms ${outcome.stores.filter((store) => !failedStores.includes(store)).join(", ") || "no store"} and not ${missing.join(", ")}.`
            : dispatchedHint({
                acceptedAt,
                trackUrl: firstPage,
                readCall: statusRead,
              })
        } Submit again with browsers limited to ${missing.join(", ")}; do not repeat ${outcome.stores.filter((store) => !failedStores.includes(store)).join(", ") || "the others"}. ${made}`,
        warnings: [
          outcome.state === "partial"
            ? `NOT submitted: ${outcome.missing.join(", ")}. The platform's answer has no submission row for ${outcome.missing.length === 1 ? "it" : "them"}.`
            : null,
          ...failureLines.map((line) => `NOT reached: ${line}.`),
          ...warnings,
          statusNote,
        ],
      });
    }

    if (!waited.outcome.recorded) {
      return envelope({
        ok: true,
        command: "extension_submit",
        status: "submit-dispatched",
        value: result,
        hint: `${dispatchedHint({ acceptedAt, trackUrl: firstPage, readCall: statusRead })} A Chrome or Edge upload under the default modes (Chrome draft-until-public, Edge draft) stops at the draft and does not enter review; a saved public, staged or review mode sends it on.${queuedLine}${coveredLine}${sourcesLine} ${made}`,
        warnings: [...warnings, statusNote, credential.note],
      });
    }

    if (uploadedFailures.length) {
      return envelope({
        ok: true,
        command: "extension_submit",
        status: "submitted",
        value: result,
        hint: `${judgedStep.say}${sourcesLine} ${made}`,
        warnings: [...warnings, statusNote, credential.note],
      });
    }

    return envelope({
      ok: true,
      command: "extension_submit",
      status: "submitted",
      value: result,
      hint: `${
        message ||
        `The platform's record confirms the submission for ${outcome.stores.join(", ")} (${waited.outcome.status}${waited.outcome.storeState ? `, store state ${waited.outcome.storeState}` : ""}). A Chrome or Edge upload under the default modes (Chrome draft-until-public, Edge draft) stops at the draft, does not enter review and is recorded as "Uploaded, not public"; a saved public, staged or review mode sends it on, and a store's own review, where it happens, comes after this answer.`
      }${queuedLine}${coveredLine}${sourcesLine} ${made}`,
      warnings: [...warnings, statusNote, credential.note],
    });
  }

  return envelope({
    ok,
    command: "extension_submit",
    status: "preflight",
    value: result,
    hint: message,
    warnings: [...warnings, statusNote, credential.note],
  });
}
