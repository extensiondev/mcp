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
  readSubmissionRecord,
  type PlatformSubmission,
} from "../lib/platform-submissions";
import { consoleProjectUrl } from "../lib/registry";
import { projectApiReadFailure, projectApiSend } from "../lib/project-api";
import { actLinks, judgePublish, trackOf } from "../lib/store-act-outcome";
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
  connectSentences,
  connectionOf,
  failedCheckSentence,
  fallbackConnectUrl,
  itemLinkUrls,
  linkItemSentences,
  nextStep,
  storeSettingsUrl,
  submitStep,
} from "../lib/store-connection";
import { readLocalListing, storeMdAdvisory } from "./store-listing";

import type { ListingStore } from "../lib/store-md-listing";

export const COMMAND = "extension_submit";
export const STORES = ["chrome", "firefox", "edge", "safari"] as const;

export type Row = Record<string, unknown>;

export interface StoreActArgs {
  action?: string;
  store?: string;
  browsers?: string[];
  submissionId?: string;
  deployPercentage?: unknown;
  buildSha?: string;
  channel?: string;
  approvalId?: string;
  waitSeconds?: unknown;
  project?: string;
  projectPath?: string;
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

  if (code === ITEM_NOT_LINKED_CODE) {
    const words = storeWords(store);
    const urls =
      store === "edge"
        ? { linkItemUrl: `${settingsUrl}?link=edge` }
        : itemLinkUrls([], settingsUrl);
    const say =
      store === "edge"
        ? `No Edge Add-ons product is linked to this project yet. Create it once in Partner Center with this build's package, then paste its product ID in the store settings at ${urls.linkItemUrl}; after that, say publish again.`
        : linkItemSentences(urls as ReturnType<typeof itemLinkUrls>);

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
        sayToPerson: say,
        nextStep: nextStep("link-item", say, urls.linkItemUrl),
      },
      hint: say,
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

type PublishStore = "chrome" | "edge";

const PUBLISH_STORES: readonly PublishStore[] = ["chrome", "edge"];

function storeWords(store: PublishStore): {
  name: string;
  reviewer: string;
  noun: string;
  reviewWord: string;
} {
  return store === "edge"
    ? {
        name: "Edge Add-ons",
        reviewer: "Edge",
        noun: "product",
        reviewWord: "certification review",
      }
    : {
        name: "the Chrome Web Store",
        reviewer: "Chrome",
        noun: "item",
        reviewWord: "review",
      };
}

function publishApprovalSentence(store: PublishStore): string {
  return store === "edge"
    ? "This sends the product to Edge's certification review."
    : PUBLISH_APPROVAL_SENTENCE;
}

export async function publishDraft(args: StoreActArgs): Promise<string> {
  const asked = (
    Array.isArray(args.browsers) && args.browsers.length
      ? args.browsers
      : [text(args.store) || "chrome"]
  ).map((b) => text(b).toLowerCase());
  const store = asked[0] as PublishStore;

  if (asked.length !== 1 || !PUBLISH_STORES.includes(store)) {
    return badShipRequest(
      COMMAND,
      "publish",
      "PublishInputError",
      `publish sends one store's draft to review, so browsers must be ["chrome"] or ["edge"]; got ${JSON.stringify(args.browsers ?? args.store ?? null)}. Firefox and Safari enter review when they are submitted. Nothing was sent.`,
    );
  }

  const words = storeWords(store);
  const submissionId = text(args.submissionId);
  const opened = await openShipApi(COMMAND, args, { action: "publish", store });
  if ("refused" in opened) return opened.refused;

  const ran = await runShipAct(
    {
      command: COMMAND,
      act: "publish",
      action: "extension_store.publish",
      route: `stores/${store}/publish`,
      body: submissionId ? { submissionId } : {},
      approvalId: args.approvalId,
      description: `Send the ${words.name.replace(/^the /, "")} draft to review.`,
      reason: `${publishApprovalSentence(store)} Nothing changes for current users until ${words.reviewer} approves it, so a workspace owner approves this exact draft first.`,
      stateRead: storesRead(args),
      scopeFits: (scope) =>
        text(scope.store) === store &&
        Boolean(text(scope.submissionId)) &&
        (!submissionId || text(scope.submissionId) === submissionId),
      project: args.project,
      apiHint: args.api,
      value: { store, ...(submissionId ? { submissionId } : {}) },
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
  const waited = await awaitRecordedOutcome<PlatformSubmission>({
    waitSeconds: args.waitSeconds,
    read: () =>
      readSubmissionRecord(opened.api, { submissionId: sentId, store }),
    judge: judgePublish,
  });
  const made = madeSentence(links);
  const value: Row = {
    ...base,
    ...(trackUrl ? { trackUrl } : {}),
    outcome: waited.outcome,
    links,
  };

  if (waited.failed) {
    const reason =
      text(waited.record?.failureReason) ||
      `the platform's record of submission ${sentId} reads ${waited.outcome.status}`;

    return envelope({
      ok: false,
      command: COMMAND,
      status: "publish-failed",
      value,
      error: {
        code: "E_PLATFORM",
        name: "PublishFailed",
        message: `The publish did not reach ${words.reviewer}'s ${words.reviewWord}: ${reason}.`,
      },
      hint: `Fix the cause and call extension_submit action "publish" again; ${storesRead(args)} reads the record. ${made}`,
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
      hint: `The platform's record of submission ${sentId} carries ${words.reviewer}'s own state, ${waited.outcome.storeState}, so the draft is in ${words.reviewer}'s ${words.reviewWord}. ${say} ${made}`,
    });
  }

  return envelope({
    ok: true,
    command: COMMAND,
    status: "publish-dispatched",
    value: {
      ...value,
      sayToPerson: say,
      nextStep: nextStep("done", say, trackUrl),
    },
    hint: `${dispatchedHint({ acceptedAt, trackUrl, readCall: storesRead(args) })} ${made}`,
  });
}

function checkView(check: Row, withLabel: boolean): Row {
  const out: Row = { id: text(check.id) };

  if (withLabel && text(check.label)) out.label = text(check.label);
  if (text(check.severity)) out.severity = text(check.severity);

  for (const key of ["message", "expected", "actual", "docsUrl"]) {
    if (text(check[key])) out[key] = text(check[key]);
  }

  return out;
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

function privacyReconciled(
  check: Row,
  local: ReturnType<typeof readLocalListing> | null,
): Row {
  if (
    !local ||
    "problem" in local ||
    !/privacy_policy_present$/.test(text(check.id))
  ) {
    return check;
  }

  const url = text(local.patch.listing.privacyPolicyUrl);
  if (!url) return check;

  return {
    ...check,
    message:
      `${text(check.message)} STORE.md carries ${url}; sync-listing writes it to the listing.`.trim(),
  };
}

function readinessView(
  json: Row,
  store: string,
  projectPath: string,
  buildNamed: boolean,
): Row {
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
  const local = projectPath
    ? readLocalListing(projectPath, store as ListingStore)
    : null;
  const connection = connectionOf(json);
  const failing = checks
    .filter((c) => text(c.status) === "fail")
    .map((c) => checkView(privacyReconciled(c, local), true));

  return {
    canSubmit:
      summary.canSubmit === true ||
      (deferred.length > 0 && failing.length === 0),
    ...(connection ? { connection } : {}),
    summary,
    ...(deferred.length ? { namedBySubmit: ["build"] } : {}),
    failing,
    warnings: checks
      .filter((c) => text(c.status) === "warn")
      .map((c) => checkView(privacyReconciled(c, local), true)),
    ...(local
      ? {
          storeMd:
            "problem" in local
              ? { missing: local.problem }
              : storeMdAdvisory(local, open),
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

  const opened = await openShipApi(COMMAND, args, { action: "preflight" });
  if ("refused" in opened) return opened.refused;

  const api = opened.api;
  const body: Row = { channel: text(args.channel) || "stable" };
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
  const unread: string[] = [];

  asked.forEach((store, i) => {
    const read = reads[i];
    if (read.ok) {
      stores[store] = readinessView(
        read.json,
        store,
        text(args.projectPath),
        Boolean(text(args.buildSha)),
      );
    } else unread.push(`${store}: ${read.message}`);
  });

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
  const readinessHint = blocked.length
    ? `${blocked.join(", ")} cannot be submitted yet; each failing check says what to fix.${syncLine} This read wrote nothing.`
    : `Every store read here is ready to submit.${buildLine} This read wrote nothing; extension_submit with dryRun:false submits.`;
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
      ? `${failedCheckSentence(text(connection.reason))} ${connectSentences(connectUrl)}`
      : connectSentences(connectUrl);
    const others = blocked.filter((store) => store !== "chrome");

    return envelope({
      ok: true,
      command: COMMAND,
      status: connected ? "store-connection-failed" : "store-not-connected",
      value: {
        action: "preflight",
        stores,
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
    const urls = itemLinkUrls([connection], settingsUrl);
    const say = linkItemSentences(urls);

    return envelope({
      ok: true,
      command: COMMAND,
      status: "store-item-not-linked",
      value: {
        action: "preflight",
        stores,
        storesPageUrl,
        ...urls,
        trackUrl: settingsUrl,
        sayToPerson: say,
        nextStep: nextStep("link-item", say, urls.linkItemUrl),
      },
      hint: say,
      warnings: [unreadLine, "This read wrote nothing."],
    });
  }

  const itemUrl =
    chrome && connection && text(connection.itemId)
      ? text(connection.itemUrl)
      : "";
  const green = blocked.length === 0 && unread.length === 0;

  return envelope({
    ok: true,
    command: COMMAND,
    status: "preflight-read",
    value: {
      action: "preflight",
      stores,
      storesPageUrl,
      ...(itemUrl ? { itemUrl } : {}),
      nextStep: green ? submitStep(asked) : null,
    },
    hint: readinessHint,
    warnings: [unreadLine],
  });
}
