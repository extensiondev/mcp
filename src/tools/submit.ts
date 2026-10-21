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
import { resolveApiBase, safeApiBase } from "../lib/login-flow";
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
  linksOf,
  madeSentence,
  stampNow,
  type ActLink,
  type Verdict,
} from "../lib/act-outcome";
import {
  readSubmissionRecords,
  type PlatformSubmission,
} from "../lib/platform-submissions";
import { trackUrl as consoleTrackUrl } from "../lib/track-url";
import { readSubmitOutcome } from "../lib/submit-outcome";
import {
  consoleProjectUrl,
  fetchRegistryJson,
  parseChannels,
  registryFileUrl,
  channelsShapeProblem,
  type ProjectRef,
} from "../lib/registry";
import {
  PUBLISH_ACTIONS,
  preflight as readPreflight,
  publishDraft,
} from "./store-acts";
import { cancelSubmission, raiseRollout } from "./store-rollout";
import {
  ITEM_NOT_LINKED_CODE,
  NOT_CONNECTED_CODES,
  chromeItemUrl,
  connectSentences,
  doneStep,
  failedCheckSentence,
  fallbackConnectUrl,
  itemLinkUrls,
  linkItemSentences,
  nextStep,
  storeSettingsUrl,
  withApproveStep,
  withReviewPromise,
  withoutSecretNames,
} from "../lib/store-connection";
import {
  connectionStep,
  dryRunVerdict,
  isConnectionState,
  readConnections,
  readStoreRows,
  rowFromConnection,
} from "../lib/store-readiness";
import { syncListing } from "./store-listing";

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
  deployPercentage?: unknown;
  project?: string;
  browsers?: string[];
  buildSha?: string;
  channel?: string;
  version?: string;
  dryRun?: boolean;
  projectPath?: string;
  screenshots?: unknown;
  approvalId?: string;
  waitSeconds?: unknown;
  api?: string;
}

export const schema = {
  name: "extension_submit",
  description:
    "Submit a built extension to a store's review through extension.dev, which holds the store credentials and runs the upload on the platform (Chrome Web Store, Firefox AMO, Edge Add-ons, App Store for Safari), and run the store steps around it: action preflight, sync-listing, publish, cancel and rollout. It records a submission on the platform and answers what the platform recorded after the act in value.outcome and every link it made or touched in value.links, waiting up to waitSeconds for the record and answering submit-dispatched until the record confirms; submitted-partially names the stores the platform did not record, and submit-unconfirmed means no usable answer came back, so read extension_release_status before submitting again. Not for sharing, deploying or sending a link: that is extension_publish. Not for a local zip: that is extension_build. It defaults to a dry run that dispatches nothing; pass dryRun:false to submit, which needs a token issued by a workspace owner and a workspace owner's approval of that exact submission, every time, and is irreversible. Submissions land least public: Chrome and Edge as drafts that enter review only through action:'publish', Firefox unlisted unless the project saved a release channel, Safari as a TestFlight draft. The project comes from your stored login (extension_auth; tokens live at most 7 days, so CI re-mints from the console's Access tokens page), and project picks one of several logins. Every answer carries value.trackUrl, the console page for what it did, and value.nextStep {kind, say, url}, the next thing to do or say.",
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
        ],
        default: "submit",
        description:
          "submit (the default) sends buildSha to every store in browsers: Chrome and Edge upload a draft that is not published and does not enter review, even for an item that is already live; Firefox uploads to the unlisted channel whenever the project has no saved release channel (AMO is read only as a guard: an add-on AMO already lists, with no saved channel, is refused before upload, because an unlisted upload of a listed add-on burns the version number) and signs it for self distribution; Safari uploads to App Store Connect and stops at the TestFlight draft; no store's API sets listing visibility, and a store that only uploaded is recorded as 'Uploaded, not public', never as live. preflight reads each store's readiness for browsers and writes nothing: the failing checks with what to fix (never a secret value or a secret's name); with projectPath, which failing listing checks the local STORE.md and the built icons already cover (a missing privacy policy URL names the STORE.md line to add); and the store connection: store-not-connected with value.connectUrl, store-connection-failed with the reason, store-item-not-linked with value.linkItemUrl, value.newItemUrl and value.packageUrl, each with the sentences to say in hint, and the store's own page in value.itemUrl as information only. A preflight with failing checks answers nextStep null. sync-listing fills the extension.dev store listing for browsers from projectPath's STORE.md (title, summary, description, category, support email, privacy policy URL, single purpose, permission justifications, reviewer, release and certification notes), the 128 px icon in the built dist/<browser> and the screenshots named, after a workspace owner approves each store's exact change (the first call answers approval-required with the change as the platform computed it; a second call with browsers:[store] and that approvalId writes it once), and answers what changed and what the listing still lacks. publish (alias review) with browsers:['chrome'] sends the newest Chrome draft, or the submissionId named, to Chrome's review, and with browsers:['edge'] the newest Edge Add-ons draft to Edge's certification review: approval-required first, then in-review with value.trackUrl once the record carries the store's own state in outcome.storeState, and publish-dispatched until then even when the run finished; with no store connected or no item linked it answers store-not-connected or store-item-not-linked before anyone is asked. cancel withdraws a submission from review (store, default chrome; submissionId from extension_release_status) and rollout raises the Chrome staged rollout to deployPercentage, which Chrome never lets drop again; both need a workspace owner's approval of the exact act and answer approval-required, or a refusal with the reason before anyone is asked. Recorded statuses (submitted, in-review, canceled, rolled-out, listing-synced) come only with outcome.recorded true; a record that reads failed answers submit-failed or publish-failed; a refusal whose value.approvalRefunded is true keeps its approvalId for the next call.",
      },
      project: PROJECT_TOKEN_INPUT,
      browsers: {
        type: "array",
        items: {
          type: "string",
          enum: ["chrome", "firefox", "edge", "safari"],
        },
        description:
          "Stores to act on: chrome, firefox, edge, safari. A submit takes several; publish takes exactly one of chrome or edge.",
      },
      buildSha: {
        type: "string",
        description:
          "The built commit SHA to submit. It needs a completed build in the project's build index; an unknown sha is rejected.",
      },
      channel: {
        type: "string",
        description: "Release channel to submit from (default stable).",
      },
      version: {
        type: "string",
        description: "Version label for the submission record (optional).",
      },
      dryRun: {
        type: "boolean",
        default: true,
        description:
          "true (the default) rehearses and dispatches nothing: the platform verifies the token and project, finds the store workflow, reads the build from its index and each store's connection record, and answers one value.verdict (ready, not-checked, platform-refused, or the blocking state store-not-connected, store-connection-failed, store-item-not-linked, store-not-configured or store-unhealthy) with value.nextStep and value.trackUrl; it does not run the owner gate, the approval, the build quota, the dispatch pause or the submission-mode check, which the real run does first. false submits: it reads the store connection and refuses before any approval when the store is not ready, needs a token issued by a workspace owner and that owner's approval of this exact submission, dispatches the store workflow, and a Chrome or Edge upload from here always stops at the draft, whatever the project's saved submission mode (Chrome: draft-until-public, the default, public or staged; Edge: draft or review; those modes govern console submissions and are answered by preflight under value.stores.<store>.submissionMode and by extension_release_status under config.submissionMode). Store credentials are never arguments, and no local file is uploaded.",
      },
      projectPath: {
        type: "string",
        description:
          "Path to the extension project root. A submit and a preflight read it only for the local STORE.md advisory, and nothing local is uploaded; without it a submit's check falls back to the server's working directory. sync-listing requires it and sends the listing text parsed from its STORE.md, the 128 px icon from its built dist and the screenshots named, nothing else.",
      },
      approvalId: {
        type: "string",
        description:
          "The approval handle returned by a prior approval-required response for a real submission. A real submission (dryRun:false) is irreversible and needs a workspace owner's approval every time: call once without this to get an approval id and URL, have a human approve at extension.dev, then call again with the same id. A dry run never needs it.",
      },
      screenshots: {
        type: "array",
        items: { type: "string" },
        description:
          "With sync-listing, up to 5 PNG screenshots inside projectPath (for example written by extension_screenshot) to set as the listing's screenshots. The Chrome Web Store takes 1280x800 or 640x400.",
      },
      api: API_BASE,
      store: {
        type: "string",
        enum: ["chrome", "firefox", "edge", "safari"],
        description:
          "With cancel or rollout, the store (default chrome, the one store that supports both).",
      },
      submissionId: {
        type: "string",
        description:
          "With cancel, the platform's id of the submission to withdraw; with publish, the draft to send to review (default the newest draft of that store). From extension_release_status include:['stores'].",
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
const SUBMIT_PENDING = new Set(["pending", "queued", "dispatched"]);

function judgeSubmit(
  byStore: Record<string, PlatformSubmission>,
  stores: string[],
  ids: Record<string, string>,
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
  scope: { buildSha: string; channel: string },
): Promise<string | null> {
  const connections = await readConnections(
    {
      project: args.project,
      api: args.api,
      buildSha: scope.buildSha,
      channel: args.channel,
    },
    browsers,
  );
  const blocked = browsers
    .map(
      (browser) =>
        connections[browser] &&
        rowFromConnection(browser, connections[browser]),
    )
    .find((row) => row && isConnectionState(row.state));
  if (!blocked) return null;

  const ctx = { ref, api: args.api };
  const step = connectionStep(blocked, connections[blocked.browser], ctx);
  const settingsUrl = storeSettingsUrl(ref, args.api);
  const linked = blocked.state === "store-item-not-linked";

  return envelope({
    ok: false,
    command: "extension_submit",
    status: blocked.state,
    error: {
      code: "E_PLATFORM",
      name: linked ? "StoreItemNotLinked" : "StoreNotConnected",
      message: `${blocked.reason} Nothing was submitted and no approval was asked for.`,
    },
    value: {
      browsers,
      buildSha: scope.buildSha,
      channel: scope.channel,
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
}

async function answer(args: SubmitToolArgs): Promise<string> {
  if (args.action === "preflight") return readPreflight(args);
  if (args.action === "cancel") return cancelSubmission(args);
  if (args.action === "rollout") return raiseRollout(args);

  if (args.action && PUBLISH_ACTIONS.has(args.action)) {
    return publishDraft(args);
  }

  if (args.action === "sync-listing") {
    return withReviewPromise(await syncListing(args));
  }

  if (args.action !== undefined && args.action !== "submit") {
    return fail(
      "SubmitInputError",
      `action must be submit, preflight, sync-listing, cancel, rollout or publish (alias review); got "${args.action}". Nothing was sent.`,
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
  const channel = args.channel ? String(args.channel).trim() : "stable";
  const body: Record<string, unknown> = { browsers, buildSha, dryRun };
  if (args.channel) body.channel = String(args.channel).trim();
  if (args.version) body.version = String(args.version).trim();

  const promisesNoReview = browsers.every((browser) =>
    DRAFT_STORES.has(browser),
  );
  const gateInput = {
    command: "extension_submit",
    action: "extension_submit",
    scope: {
      browsers: [...browsers].sort(),
      buildSha: buildSha.toLowerCase(),
      channel,
    },
    description: promisesNoReview
      ? `Upload build ${buildSha} to ${browsers.join(", ")} as a store draft: not published and not sent to review, whatever the saved submission mode. The store keeps the uploaded package, so the upload itself cannot be undone.`
      : `Submit build ${buildSha} to ${browsers.join(", ")} for store review.`,
    approvalId: args.approvalId,
    token,
    api: args.api,
    refusedStatus: "submit-failed",
    irreversible: true,
  };
  const asked = (out: string) =>
    withApproveStep(
      promisesNoReview ? withReviewPromise(out) : out,
      promisesNoReview,
    );

  if (!dryRun) {
    const refused = await connectionPrecheck(args, browsers, credential.ref, {
      buildSha,
      channel,
    });
    if (refused) return refused;

    const gate = await evaluateApproval({
      ...gateInput,
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

  let res: Response;

  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        ...identityHeaders("extension_submit"),
      },
      body: JSON.stringify(body),
    });
  } catch (err: any) {
    if (!dryRun) {
      return envelope({
        ok: false,
        command: "extension_submit",
        status: "submit-unconfirmed",
        error: {
          code: "E_NETWORK",
          name: "SubmitUnconfirmed",
          message: `The submission request for ${browsers.join(", ")} left this machine and no answer came back (${err?.message || err}), so whether any store was submitted is unknown.`,
        },
        value: { browsers, buildSha, channel },
        hint: `Do not submit again blind: a store that was dispatched would be submitted twice. Read ${statusRead} first and submit only the stores with no new submission.`,
      });
    }

    return fail(
      "SubmitNetworkError",
      `Could not reach ${url}: ${err?.message || err}`,
      "network-failed",
      "E_NETWORK",
    );
  }

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
          channel,
          ...urls,
          trackUrl: settingsUrl,
          sayToPerson: say,
          nextStep: nextStep("link-item", say, urls.linkItemUrl),
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
          channel,
          connectUrl,
          trackUrl: settingsUrl,
          sayToPerson: say,
          nextStep: nextStep("connect", say, connectUrl),
        },
        hint: say,
      });
    }

    if (!dryRun && !args.approvalId && platformRequiresApproval(res, data)) {
      return asked(await requestApprovalAfterRefusal(gateInput));
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
            value: { browsers, buildSha, channel },
            stateRead: statusRead,
          })
        : undefined;

    if (answered) return answered;

    const saidNothingDispatched = data?.retryable === true;
    const maybeDispatched =
      !dryRun && res.status >= 500 && !saidNothingDispatched;
    const BEFORE_APPROVAL = new Set([
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
              channel,
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
  let channelNote: string | null = null;
  let statusNote: string | null = null;

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
    const [{ rows, connections }, channelsRes] = await Promise.all([
      readStoreRows(
        {
          project: args.project,
          api: args.api,
          buildSha,
          channel: args.channel,
        },
        browsers,
        ctx,
      ),
      ref
        ? fetchRegistryJson(
            registryFileUrl(ref, "channels.json", args.api),
            fetch,
            { ref, api: args.api },
          )
        : Promise.resolve(null),
    ]);
    const channelRows =
      channelsRes?.ok && !channelsShapeProblem(channelsRes.json)
        ? parseChannels(channelsRes.json)
        : null;
    const channelDefaulted = !String(args.channel || "").trim();
    const resolvedChannel =
      String(data?.channel || "").trim() ||
      (channelDefaulted ? "stable" : String(args.channel).trim());

    if (
      channelRows &&
      !channelRows.some(
        (r) =>
          r.channel === resolvedChannel ||
          r.channel.endsWith(`-${resolvedChannel}`),
      )
    ) {
      warnings.push(
        `Channel "${resolvedChannel}"${channelDefaulted ? " (the default)" : ""} does not exist in this project's channels (existing: ${
          channelRows.map((r) => r.channel).join(", ") || "none"
        }), so a real submission from it has no promoted build to serve. Promote a build there first (extension_release_promote) or pass an existing channel.`,
      );
    }

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
    result.channel = resolvedChannel;
    result.channelDefaulted = channelDefaulted;
    result.consoleStoresUrl = consoleStoresUrl;

    if (typeof data?.message === "string") {
      result.platformMessage = data.message;
    }

    const itemUrl = rows.find((row) => row.itemUrl)?.itemUrl;
    if (itemUrl) result.itemUrl = itemUrl;
    if (channelDefaulted) channelNote = `channel: ${resolvedChannel} (default)`;

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
        value: { browsers, buildSha, channel, platform: data },
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
    result.submittedStores = outcome.stores;

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
    const firstPage =
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
      judge: (byStore) => judgeSubmit(byStore, outcome.stores, ids),
    });
    const made = madeSentence(links);
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

    result.outcome = waited.outcome;
    result.links = links;
    result.nextStep = doneStep(outcome.stores, itemUrl);

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
        warnings: [...warnings, channelNote, credential.note],
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
          channelNote,
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
        hint: `${dispatchedHint({ acceptedAt, trackUrl: firstPage, readCall: statusRead })} A Chrome or Edge upload from here stops at the draft whatever the saved submission mode, and does not enter review. ${made}`,
        warnings: [...warnings, channelNote, statusNote, credential.note],
      });
    }

    return envelope({
      ok: true,
      command: "extension_submit",
      status: "submitted",
      value: result,
      hint: `${
        message ||
        `The platform's record confirms the submission for ${outcome.stores.join(", ")} (${waited.outcome.status}${waited.outcome.storeState ? `, store state ${waited.outcome.storeState}` : ""}). A Chrome or Edge upload from here stops at the draft whatever the saved submission mode, does not enter review and is recorded as "Uploaded, not public"; a store's own review, where it happens, comes after this answer.`
      } ${made}`,
      warnings: [...warnings, channelNote, statusNote, credential.note],
    });
  }

  return envelope({
    ok,
    command: "extension_submit",
    status: "preflight",
    value: result,
    hint: message,
    warnings: [...warnings, channelNote, statusNote, credential.note],
  });
}
