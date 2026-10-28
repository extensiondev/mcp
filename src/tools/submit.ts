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
import { envelope, type ErrorCode } from "../lib/envelope";
import { PROJECT_TOKEN_INPUT, noStoredLoginHint } from "../lib/credentials";
import {
  firefoxConnectUrl,
  firefoxSourcesOutcome,
  sourceArchiveOf,
} from "../lib/firefox-store";
import { resolveApiBase, safeApiBase } from "../lib/login-flow";
import { platformFetch } from "../lib/platform-fetch";
import { identityHeaders } from "../lib/session-identity";
import { REFUNDED_SAY, REFUNDED_STEP } from "../lib/ship-act";
import { STORE_MD_FILENAME, parseStoreMd } from "../lib/store-md";
import { platformHoldEnvelope, sawPlatformHold } from "../lib/platform-hold";
import {
  approvalGateEnabled,
  evaluateApproval,
  platformRequiresApproval,
  requestApprovalAfterRefusal,
} from "../lib/approval-gate";
import { spendNarration } from "../lib/allowance";
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
import { cancelSubmission, raiseRollout } from "./store-rollout";
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
  linkItemSentences,
  nextStep,
  reviewSentenceFor,
  storeSettingsUrl,
  uploadedStepFailedStep,
  uploadStopsAtDraft,
  withApproveStep,
  withReviewPromise,
  withoutSecretNames,
  type ModeIds,
} from "../lib/store-connection";
import {
  connectionStep,
  dryRunVerdict,
  isConnectionState,
  readConnectionsAndModes,
  readStoreRows,
  rowFromConnection,
} from "../lib/store-readiness";
import { syncListing } from "./store-listing";
import { screenshotDoor } from "../lib/store-bring-list";
import { LISTING_INCOMPLETE_CODE, listingIncompleteOf, listingIncompleteSentence } from "../lib/store-listing-incomplete";

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
  approvalId?: string;
  useBuild?: string;
  detail?: unknown;
  waitSeconds?: unknown;
  api?: string;
}

export const schema = {
  name: "extension_submit",
  description:
    "Submit a built extension to a store's review through extension.dev, which holds the store credentials and runs the upload (Chrome Web Store, Firefox AMO, Edge Add-ons, App Store for Safari), and run the store steps around it: action preflight, sync-listing, configure-store, publish, cancel and rollout. It records a submission and answers what the platform recorded in value.outcome and every link it touched in value.links, waiting up to waitSeconds for the record and answering submit-dispatched until it confirms; submitted-partially names the stores not recorded, and submit-unconfirmed means no usable answer came back, so read extension_release_status before submitting again. Not for sharing, deploying or sending a link (extension_publish) or a local zip (extension_build). It defaults to a dry run that dispatches nothing; dryRun:false submits, which needs a token issued by a workspace owner and a workspace owner's approval of that exact submission, every time, and is irreversible. Submissions land least public: Chrome and Edge as drafts and Safari as a TestFlight build, each entering review only through action:'publish'; Firefox unlisted unless the project saved a release channel. A Firefox upload carries the source repository at the built commit when the Firefox store setting Source archive says so. The project comes from your stored login (extension_auth; tokens live at most 7 days, CI re-mints before expiry); project picks one of several logins. Every answer carries value.trackUrl, the console page for it, and value.nextStep {kind, say, url}, what to do or say next.",
  inputSchema: {
    type: "object" as const,
    properties: {
      action: {
        type: "string",
        enum: [
          "submit",
          "preflight",
          "sync-listing",
          "cancel",
          "rollout",
          "publish",
          "review",
          "configure-store",
        ],
        default: "submit",
        description:
          "submit (the default) sends buildSha to every store in browsers: Chrome and Edge upload a draft that is not published and does not enter review, even for an item that is already live; Firefox uploads to the unlisted channel whenever the project has no saved release channel (AMO is read only as a guard: an add-on AMO already lists, with no saved channel, is refused before upload, because an unlisted upload of a listed add-on burns the version number) and signs it for self distribution; Safari uploads to App Store Connect and stops at the TestFlight draft; no store's API sets listing visibility, and a store that only uploaded is recorded as 'Uploaded, not public', never as live. A store whose review of another version holds the act answers submit-queued: the platform queued it with the approval bound to it and sends it on its own when that review ends; value.queued names the store's own word and when the platform last checked, nothing is submitted again, and extension_release_status include:['stores'] follows it. preflight reads each store's readiness for browsers and writes nothing: the failing checks with what to fix (never a secret value or a secret's name); with projectPath, which failing listing checks the local STORE.md and the built icons already cover (a missing privacy policy URL names the STORE.md line to add); and the store connection: store-not-connected with value.connectUrl, store-connection-failed with the reason, store-item-not-linked with value.linkItemUrl, value.newItemUrl and value.packageUrl, each with the sentences to say in hint, and the store's own page in value.itemUrl as information only. For Chrome every field only the item's dashboard holds (description, category, language, icon, screenshots, single purpose, permission justifications, remote code, data usage, privacy policy URL, visibility, test instructions) reads unknown with its tab and value.dashboardUrl, never have from STORE.md; the visibility check compares STORE.md's `- Visibility:` (public, unlisted or private; unlisted when absent) with the Public a new item starts at, and the host check names every content script match and host permission of the built Chrome package no justification bullet covers, a localhost or loopback match flagged as a review risk. The Chrome preflight also reads Google's own rules from the built package and from the item (fetchStatus): Manifest V3 only, the 128 px icon in the package, the manifest name (75 characters) and description (132), a version above the one Chrome holds, a page that loads a script from outside the package, a missing privacy policy URL on a package that reaches user data, the staged rollout rules (an already-published item, one partial rollout at a time, 100% after a takedown or warning), and a review or upload Chrome is still running; these answer beside the checks as chromePreflight {act, checks, blocking, warnings, lock, inFlight, approval}, the same shape Edge answers as edgePreflight, where a review or upload Chrome is still running is a check with status locked (chrome.review_in_progress, chrome.upload_in_progress) carrying lock {kind, clearsWhen, storeWord, readAt}, a store state that clears by itself and that the platform queues the act on instead of failing it, inFlight names the package Chrome holds in review and approval is the sentence the owner approves. Each store's requirements and bringList list only the rows not on file and count the rest in onFile, so four stores answer in a few KB; detail: true, or the stores and requirement ids it names, answers those rows in full. A preflight with failing checks answers nextStep null, and one whose requirements list reads readyForReview false never answers a submit step: an Edge product never submitted in Partner Center answers the product page as a dashboard step, naming configure-store with storeSettings {firstSubmitted: true} as the write that records it once the owner did. For Edge the platform's report also carries edgePreflight: every rule from Microsoft's own pages as a check {id, severity blocking or warn, lock?} (compressed files and the manifest inside the package, the version against the one the store serves, the first submission, a draft with nothing new, and what Partner Center's listing pages flag: description length, screenshot sizes and count, search-term limits, notes for certification), the review in flight, and edgePreflight.approval, the sentence the approval shows, naming what the act does to what is in flight; a check with lock is a review Partner Center is still running, which clears by itself. sync-listing fills the extension.dev store listing for browsers from projectPath's STORE.md (title, summary, description, category, license, support email, homepage URL, search terms, privacy policy URL, single purpose, permission justifications, reviewer, release and certification notes; a trailing parenthetical note on a category, license, support email or homepage line stays out of the value), the 128 px icon of the build the store receives and the screenshots named, written at once under the owner's own token (listing-synced), and answers what changed and what the listing still lacks; the icon is read from the completed platform build of the commit projectPath has checked out (or the build useBuild names), falling back with no such build to the local dist/<browser> only when its icon matches the source manifest's icon, else to the source icon, and a dist older than the source icon is withheld with the sentence to say (run a build, or pass useBuild), its store answering icon-stale rather than unchanged; each store's row names where its icon came from in value.stores.<store>.icon (build with its sha, dist, or source), and value.iconSource says whether a platform build was used or why not (its build still running per its own record, never pushed, or no git commit), the list's lag never hiding a completed build since the commit's own record is read; Chrome's API cannot write or read any listing field, so a Chrome sync is a record only: its row reads recorded with value.stores.chrome.pasteInDashboard (every field the item's dashboard alone takes, with its tab, Store listing, Privacy, Distribution or Test instructions, the STORE.md line to paste from, and the dashboard address), and a sync of Chrome alone answers listing-recorded, never listing-synced; when the platform still asks for an approval, the first call answers approval-required with the change as the platform computed it and a second call with browsers:[store] and that approvalId writes it once. publish (alias review) with browsers:['chrome'] sends the newest Chrome draft, or the submissionId named, to Chrome's review (while Chrome reviews another package the approval says so, PENDING_REVIEW with the package and the read date, and that this publish waits for that review, which nothing here withdraws; a draft upload meanwhile lands beside the reviewed package without entering review), with browsers:['edge'] the newest Edge Add-ons draft to Edge's certification review (while Partner Center is still reviewing an earlier submission its Publish API answers InProgressSubmission: Can't publish extension as your extension submission is in progress. Please try again later., so a publish the preflight reads as locked is queued behind that review, never failed, and never cancels it; an Edge upload while a submission is in certification review replaces the draft package only and touches no review), and with browsers:['safari'] the App Store version holding the newest TestFlight build, or the build buildNumber names, to Apple's App Review (one review submission for the version; the act creates the version holding the build when none does, set to manual release, so Apple's approval does not put it on sale; a withdrawn or lower build than a newer draft is refused as SAFARI_NEWER_BUILD; another version Apple already holds WAITING_FOR_REVIEW, IN_REVIEW or READY_FOR_REVIEW answers SAFARI_VERSION_IN_REVIEW before any approval, naming the withdrawal that clears it, and the preflight names the same version as a lock on its store.safari_app_review_lock check; a build Apple is still processing or Apple's own refusal per field is answered as the reason; the release mode of a version the owner made is kept): approval-required first, then in-review with value.trackUrl once the record carries the store's own state for the draft in outcome.storeState, read after the act (outcome.liveState is what the store serves meanwhile, never the draft's state), and publish-dispatched until then even when the run finished; with no store connected or no item linked it answers store-not-connected or store-item-not-linked before anyone is asked. An Edge submission whose package carries a compressed file (.zip, .gz, .tgz, .tar, .br, .bz2, .xz, .7z, .rar, .jar, .crx, .xpi, or gzip bytes under any name), which Partner Center refuses in an extension package, answers package-refused with value.files and the build page in value.trackUrl before any approval; the fix is in the build (Tesseract .traineddata ships uncompressed with gzip: false), never in a file this server rewrites. cancel withdraws a submission from review (store, default chrome; submissionId from extension_release_status); with store 'safari' it removes the App Store version from Apple's App Review (refused before any approval when the record says nothing is in review; canceled once the record reads draft, with Apple's version state, DEVELOPER_REJECTED, in outcome.storeState, and the build stays on TestFlight) and rollout raises the Chrome staged rollout to deployPercentage, which Chrome never lets drop again; both need a workspace owner's approval of the exact act and answer approval-required, or a refusal with the reason before anyone is asked. configure-store changes one store's settings (store, and storeSettings with only what changes: enabled, submissionMode among the store's own mode ids, the store's listing id, the Safari bundleId, the Edge firstSubmitted (the owner's word that the product was submitted once in Partner Center) and storeUrl (the Edge Add-ons listing URL, which names the crx id), and for Firefox sourceArchive and releaseChannel) at once under the owner's own token, the same as extension_builds configure: store-configured answers what changed, the console store settings page in value.trackUrl and preflight as nextStep; a listed or public submission mode changes who can find the extension, so it answers approval-required first with the change as the platform computed it, and a second call with that approvalId applies it once; a storeSettings key that names a credential answers credentials-console-only before anything is sent, with the console connect page in value.connectUrl and the form's own field labels, since store credentials never pass through this server. Recorded statuses (submitted, in-review, canceled, rolled-out, listing-synced, listing-recorded) come only with outcome.recorded true; a record that reads failed answers submit-failed or publish-failed; a refusal whose value.approvalRefunded is true keeps its approvalId for the next call.",
      },
      project: PROJECT_TOKEN_INPUT,
      browsers: {
        type: "array",
        items: {
          type: "string",
          enum: ["chrome", "firefox", "edge", "safari"],
        },
        description:
          "Stores to act on: chrome, firefox, edge, safari. A submit takes several; publish takes exactly one of chrome, edge or safari.",
      },
      buildSha: {
        type: "string",
        description:
          "The built commit SHA to submit. It needs a completed build in the project's build index; an unknown sha is rejected.",
      },
      version: {
        type: "string",
        description: "Version label for the submission record (optional).",
      },
      dryRun: {
        type: "boolean",
        default: true,
        description:
          "true (the default) rehearses and dispatches nothing: the platform verifies the token and project, finds the store workflow, reads the build from its index and each store's connection record, and answers one value.verdict (ready, not-checked, platform-refused, or the blocking state store-not-connected, store-connection-failed, store-item-not-linked, store-not-configured or store-unhealthy) with value.nextStep and value.trackUrl; it does not run the owner gate, the approval, the build quota, the dispatch pause or the submission-mode check, which the real run does first. false submits: it reads the store connection and refuses before any approval when the store is not ready, needs a token issued by a workspace owner and that owner's approval of this exact submission, dispatches the store workflow, and a Chrome or Edge upload from here stops at the draft under the default modes (Chrome draft-until-public, Edge draft), while a mode saved in the console store settings is honored whoever saved it: Chrome public or staged and Edge review send the upload on to review, and the approval says so (preflight answers the saved mode under value.stores.<store>.submissionMode, extension_release_status under config.submissionMode). Store credentials are never arguments, and no local file is uploaded.",
      },
      projectPath: {
        type: "string",
        description:
          "Path to the extension project root. A submit and a preflight read it only for the local STORE.md advisory, and nothing local is uploaded; without it a submit's check falls back to the server's working directory. sync-listing requires it and sends the listing text parsed from its STORE.md, the 128 px icon of the build the store receives (the platform build of its checked out commit, else its dist when current, else its source icon) and the screenshots named, nothing else.",
      },
      approvalId: {
        type: "string",
        description:
          "The approval handle returned by a prior approval-required response for a real submission, a publish, a cancel, a rollout, or a sync-listing or configure-store the platform asked an approval for (a listed or public submission mode). A real submission (dryRun:false) is irreversible and needs a workspace owner's approval every time: call once without this to get an approval id and URL, have a human approve at extension.dev, then call again with the same id. A dry run never needs it.",
      },
      screenshots: {
        type: "array",
        items: { type: "string" },
        description:
          "With sync-listing, up to 5 PNG screenshots inside projectPath (for example written by extension_screenshot) to set as the listing's screenshots. The Chrome Web Store takes 1280x800 or 640x400.",
      },
      useBuild: {
        type: "string",
        description:
          "With sync-listing, the sha of a completed platform build to take each store's 128 px icon from, in place of the build of the commit projectPath has checked out; extension_builds lists the shas, and an unknown or unfinished one is refused before anything is sent.",
      },
      detail: {
        type: ["boolean", "array"],
        items: { type: "string" },
        description:
          'With preflight: what to answer in full. Omitted, each store answers its failing and warning checks whole, and its requirements and bringList list only the rows not on file (an unknown row as its id, label, status and dashboard tab), counting the rest in onFile, so a four-store preflight stays a few KB. true answers every row with its format, how and docs; a list of stores and requirement ids, such as ["chrome", "safari.subtitle"], answers only those in full.',
      },
      api: API_BASE,
      store: {
        type: "string",
        enum: ["chrome", "firefox", "edge", "safari"],
        description:
          "With cancel or rollout, the store (default chrome, the one store that supports both); with configure-store, the store whose settings change (required).",
      },
      storeSettings: {
        type: "object",
        properties: {
          enabled: { type: "boolean", description: "Whether the platform submits to this store at all." },
          submissionMode: { type: "string", description: "The store's own mode id; dry-run on any store rehearses without uploading." },
          sourceArchive: { type: "string", enum: ["repository", "none"], description: "Firefox only: whether the upload carries the source repository at the built commit." },
          releaseChannel: { type: "string", enum: ["listed", "unlisted"], description: "Firefox only: the AMO channel, the same write as submissionMode." },
          chromeItemId: { type: "string", description: "Chrome only: the item's 32-letter id, or the item's address from the Chrome Web Store developer dashboard." },
          edgeProductId: { type: "string", description: "Edge only: the Product ID GUID from Partner Center." },
          firefoxAddonGuid: { type: "string", description: "Firefox only: the add-on GUID (name@example.com or {uuid}); never an AMO slug or numeric id." },
          appStoreId: { type: "string", description: "Safari only: the App Store id of the app record, the 6 to 15 digit Apple ID shown under App Information in App Store Connect." },
          bundleId: {
            type: "string",
            description:
              "Safari only: the project's bundle identifier, reverse-DNS with two or more labels (such as com.yourcompany.yourextension), the one extension.config.js names as browser.safari.bundleId. Not a secret; a plain write. When the Safari preflight reads it from extension.config.js and none is saved, it offers this exact write.",
          },
          firstSubmitted: {
            type: "boolean",
            description:
              "Edge only: true once the owner has submitted the product once in Partner Center (the console's \"Submitted once in Partner Center\" switch), false to withdraw it. A plain owner write; the platform stamps the time and the Edge first-submission requirement then reads have.",
          },
          storeUrl: {
            type: "string",
            description:
              "Edge only: the product's Edge Add-ons listing URL (https://microsoftedge.microsoft.com/addons/detail/<slug>/<crxId> or .../detail/<crxId>), the console's \"Store listing URL\" field; \"\" clears it. A link without the 32-letter crx id is refused before anything is sent. A plain owner write, saved as the canonical crx id link, and how the platform reads what Edge Add-ons serves while its search does not list a new product yet.",
          },
        },
        description:
          "With configure-store, only the settings that change for store: enabled (boolean: whether the platform submits to this store at all), submissionMode (the store's own mode id: chrome draft-until-public, draft, public or staged; edge draft or review; firefox unlisted or listed; safari draft; dry-run on any store rehearses without uploading), the store's listing id (chromeItemId, edgeProductId, firefoxAddonGuid or appStoreId, a plain write checked in the store's own terms), for Safari bundleId (the project's reverse-DNS bundle identifier, a plain write), for Edge firstSubmitted (true once the product was submitted once in Partner Center, a plain owner write) and storeUrl (the Edge Add-ons listing URL carrying the crx id, a plain owner write), and for Firefox sourceArchive (repository attaches the source repository at the built commit, which Mozilla requires for a bundled build; none sends nothing) and releaseChannel (listed or unlisted, the same write as submissionMode). Never a credential, a publisher id or another store's URL: those stay in the console.",
      },
      submissionId: {
        type: "string",
        description:
          "With cancel, the platform's id of the submission to withdraw; with publish, the draft to send to review (default the newest draft of that store). From extension_release_status include:['stores'].",
      },
      buildNumber: {
        type: "integer",
        minimum: 1,
        description:
          "With publish and browsers ['safari'], the TestFlight build number Apple shows (extension_release_status include:['stores'] lists each Safari submission's build) to send to App Review, in place of submissionId; omitted, the newest TestFlight build on record is sent. A number no submission carries answers publish-refused with value.knownBuildNumbers, a withdrawn or lower build than a newer draft answers SAFARI_NEWER_BUILD, and the approval names the build: 'Send App Store version 0.2.0 with TestFlight build 13 to Apple's App Review'.",
      },
      deployPercentage: {
        type: "number",
        description:
          "With rollout, the share of users to raise the staged rollout to: a whole number from 1 to 100, above the current one.",
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
function judgeSubmit(
  byStore: Record<string, PlatformSubmission>,
  stores: string[],
  ids: Record<string, string>,
  retried: Record<string, StoreRetry> = {},
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

    settled.push({
      store,
      status,
      state: record.storeUpload?.state ?? record.storeReview?.state ?? null,
      failed: FAILED_STATUSES.has(status),
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
): Promise<{ refused: string | null; modes: ModeIds; reports: Record<string, Record<string, unknown>> }> {
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
  if (!blocked) return { refused: null, modes, reports: read.reports };

  const ctx = { ref, api: args.api };
  const step = connectionStep(blocked, connections[blocked.browser], ctx);
  const settingsUrl = storeSettingsUrl(ref, args.api);
  const linked = blocked.state === "store-item-not-linked";
  const firstSubmission = blocked.state === "first-submission-in-partner-center";

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
        ? itemLinkUrls([connections[blocked.browser]], settingsUrl)
        : { connectUrl: step.url }),
      trackUrl: settingsUrl,
      sayToPerson: step.say,
      nextStep: step,
    },
    hint: step.say,
  });

  return { refused, modes, reports: read.reports };
}

async function answer(args: SubmitToolArgs): Promise<string> {
  if (args.action === "preflight") return readPreflight(args);
  if (args.action === "cancel") return cancelSubmission(args);
  if (args.action === "rollout") return raiseRollout(args);
  if (args.action === CONFIGURE_STORE) return configureStore(args);

  if (args.action && PUBLISH_ACTIONS.has(args.action)) {
    return publishDraft(args);
  }

  if (args.action === "sync-listing") {
    return withReviewPromise(await syncListing(args));
  }

  if (args.action !== undefined && args.action !== "submit") {
    return fail(
      "SubmitInputError",
      `action must be submit, preflight, sync-listing, configure-store, cancel, rollout or publish (alias review); got "${args.action}". Nothing was sent.`,
      "bad-request",
      "E_BAD_REQUEST",
    );
  }

  const credential = resolveCredential({
    project: args.project,
    api: args.api,
  });
  const token = credential.token;

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
  let firefoxSetting: string | undefined;

  const gateInputFor = (known: ModeIds) => {
    const drafts = browsers.every((browser) => uploadStopsAtDraft(browser, known[browser]));
    const broad = browsers.filter((browser) => DRAFT_STORES.has(browser) && !uploadStopsAtDraft(browser, known[browser]));

    return {
      command: "extension_submit",
      action: "extension_submit",
      scope: {
        browsers: [...browsers].sort(),
        buildSha: buildSha.toLowerCase(),
      },
      description: drafts
        ? `Upload build ${buildSha} to ${browsers.join(", ")} as a store draft: not published and not sent to review under the saved submission mode. The store keeps the uploaded package, so the upload itself cannot be undone.`
        : broad.length > 0
          ? `Submit build ${buildSha} to ${browsers.join(", ")} for store review: the saved ${broad.map((store) => `${store} mode "${known[store]}"`).join(" and ")} sends the upload on to review.`
          : `Submit build ${buildSha} to ${browsers.join(", ")} for store review.`,
      approvalId: args.approvalId,
      token,
      api: args.api,
      refusedStatus: "submit-failed",
      irreversible: true,
    };
  };

  const asked = (out: string) => {
    const sentence = reviewSentenceFor(browsers, modes);

    return withApproveStep(sentence ? withReviewPromise(out, sentence) : out, sentence);
  };

  if (!dryRun) {
    const precheck = await connectionPrecheck(args, browsers, credential.ref, {
      buildSha,
    });
    if (precheck.refused) return precheck.refused;

    modes = precheck.modes;
    firefoxSetting = sourceArchiveOf(precheck.reports.firefox ?? {})?.setting;

    const gate = await evaluateApproval({
      ...gateInputFor(modes),
      enabled: approvalGateEnabled(true),
    });
    if (gate.blocked) return asked(gate.envelope);

    const approvalId =
      gate.approvalId ??
      (args.approvalId ? String(args.approvalId).trim() : "");
    if (approvalId) body.approvalId = approvalId;
  }

  const statusRead = `extension_release_status (include: ['stores']${
    args.project ? `, project: '${args.project}'` : ""
  })`;

  const sent = await platformFetch(
    url,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        ...identityHeaders("extension_submit"),
      },
      body: JSON.stringify(body),
    },
    { kind: "dispatch" },
  );

  if (!sent.ok) {
    const unreached = sent.unreached.message;

    if (!dryRun) {
      return envelope({
        ok: false,
        command: "extension_submit",
        status: "submit-unconfirmed",
        error: {
          code: "E_NETWORK",
          name: "SubmitUnconfirmed",
          message: `The submission request for ${browsers.join(", ")} left this machine and no answer came back (${unreached}), so whether any store was submitted is unknown.`,
        },
        value: { browsers, buildSha },
        hint: `Do not submit again blind: a store that was dispatched would be submitted twice. Read ${statusRead} first and submit only the stores with no new submission.`,
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

    const refusedCode = typeof data?.code === "string" ? data.code : "";

    if (refusedCode === ITEM_NOT_LINKED_CODE) {
      const settingsUrl = storeSettingsUrl(credential.ref, args.api);
      const urls = itemLinkUrls([data, data?.connection], settingsUrl);
      const say = linkItemSentences(urls);

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
          sayToPerson: say,
          nextStep: nextStep("link-item", say, urls.linkItemUrl),
        },
        hint: say,
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

    const answered =
      !dryRun && body.approvalId
        ? approvalRoundTrip({
            command: "extension_submit",
            platformCode: typeof data?.code === "string" ? data.code : "",
            message: typeof data?.message === "string" ? data.message : "",
            approvalId: String(body.approvalId),
            undone: "Nothing was submitted by this call.",
            api: args.api,
            value: { browsers, buildSha },
            stateRead: statusRead,
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
              sayToPerson: REFUNDED_SAY,
              nextStep: REFUNDED_STEP,
            },
          }
        : {}),
      error: {
        code: "E_PLATFORM",
        name: "SubmitError",
        message: `${dryRun ? "preflight" : "submit"} failed (${res.status}): ${data?.message || text || "unknown error"}`,
        ...(typeof data?.code === "string" ? { platformCode: data.code } : {}),
      },
      ...(approvalRefunded
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
    const ctx = { ref, api: args.api };
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
    if (platformChannel) result.channel = platformChannel;
    else delete result.channel;

    result.consoleStoresUrl = consoleStoresUrl;

    if (typeof data?.message === "string") {
      result.platformMessage = data.message;
    }

    const itemUrl = rows.find((row) => row.itemUrl)?.itemUrl;
    if (itemUrl) result.itemUrl = itemUrl;

    warnings.push(
      `Store publish mode (draft, skip-publish or live) is not readable with this token, so a dry run does not check it; the per-store settings are at ${consoleStoresUrl}.`,
    );

    message = `${verdict.say}${checked}`;
  }

  if (!dryRun) {
    const outcome = readSubmitOutcome(data, browsers);

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
      judge: (byStore) => judgeSubmit(byStore, outcome.stores, ids, retried),
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
      ? outcome.stores.filter((store) =>
          FAILED_STATUSES.has(
            String(waited.record?.[store]?.status ?? "").toLowerCase(),
          ),
        )
      : [];
    const failureLines = failedStores.map(
      (store) =>
        `${store}: ${String(waited.record?.[store]?.failureReason ?? "").trim() || "the store run failed"}`,
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
    const judgedStep = !waited.outcome.recorded
      ? dispatchedStep(outcome.stores, firstPage)
      : failedStores.length
        ? submitFailedStep(failureLines, firstPage)
        : uploadedFailures.length
          ? uploadedStepFailedStep(
              uploadedFailures.map((row) => row.store),
              uploadedFailures.map((row) => String(row.record?.failure?.step)).join("; "),
              firstPage,
            )
          : doneStep(outcome.stores, itemUrl);
    const step = retryLine
      ? { ...judgedStep, say: `${retryLine} ${judgedStep.say}` }
      : judgedStep;

    result.outcome = waited.outcome;
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
    const sourcesLine = firefoxSources ? ` ${firefoxSources.say}` : "";
    if (firefoxSources) result.firefoxSourceArchive = firefoxSources;

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
        hint: `${dispatchedHint({ acceptedAt, trackUrl: firstPage, readCall: statusRead })} A Chrome or Edge upload under the default modes (Chrome draft-until-public, Edge draft) stops at the draft and does not enter review; a saved public, staged or review mode sends it on.${queuedLine}${sourcesLine} ${made}`,
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
      }${queuedLine}${sourcesLine} ${made}`,
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
