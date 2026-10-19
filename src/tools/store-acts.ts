// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { ConsoleProjectPage } from "@extension.dev/urls/paths";

import { envelope } from "../lib/envelope";
import { consoleProjectUrl } from "../lib/registry";
import { projectApiReadFailure, projectApiSend } from "../lib/project-api";
import { badShipRequest, isRow, openShipApi, runShipAct, text } from "../lib/ship-act";
import {
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


const COMMAND = "extension_submit";
const STORES = ["chrome", "firefox", "edge", "safari"] as const;

type Row = Record<string, unknown>;

export interface StoreActArgs {
  action?: string;
  store?: string;
  browsers?: string[];
  submissionId?: string;
  deployPercentage?: unknown;
  buildSha?: string;
  channel?: string;
  approvalId?: string;
  project?: string;
  projectPath?: string;
  api?: string;
}

const storesRead = (args: StoreActArgs) =>
  `extension_release_status (include: ["stores"]${args.project ? `, project: "${args.project}"` : ""})`;

function storeOf(args: StoreActArgs, act: string): { store: string } | { refused: string } {
  const store = text(args.store).toLowerCase() || "chrome";

  if (!(STORES as readonly string[]).includes(store)) {
    return { refused: badShipRequest(COMMAND, act, "StoreInputError", `store must be one of ${STORES.join(", ")}; got "${args.store}". Nothing was sent.`) };
  }

  return { store };
}

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

  return envelope({
    ok: true,
    command: COMMAND,
    status: "cancel-dispatched",
    value: { action: "cancel", ...ran.json },
    hint: `The store run that withdraws submission ${submissionId} was dispatched; the store acts when it runs. ${storesRead(args)} reads the submission's state once the run records it.`,
  });
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

  return envelope({
    ok: true,
    command: COMMAND,
    status: "rollout-dispatched",
    value: { action: "rollout", ...ran.json },
    hint: `The store run that raises the rollout to ${percentage}% was dispatched. extension_release_status (include: ["rollout"]) reads the percentage once the run saves it.`,
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

function readinessView(json: Row, store: string, projectPath: string): Row {
  const summary = isRow(json.summary) ? json.summary : {};
  const checks = (Array.isArray(json.checks) ? json.checks : []).filter(isRow);
  const open = checks.filter((c) => text(c.status) === "fail" || text(c.status) === "warn");
  const local = projectPath ? readLocalListing(projectPath, store as ListingStore) : null;
  const connection = connectionOf(json);

  return {
    canSubmit: summary.canSubmit === true,
    ...(connection ? { connection } : {}),
    summary,
    failing: checks.filter((c) => text(c.status) === "fail").map((c) => checkView(c, true)),
    warnings: checks.filter((c) => text(c.status) === "warn").map((c) => checkView(c, true)),
    ...(local ? { storeMd: "problem" in local ? { missing: local.problem } : storeMdAdvisory(local, open) } : {}),
  };
}

/* @invariant A PREFLIGHT IS A READ. The platform assembles each store's
 * readiness from the build repository, the registry and the names of the
 * secrets it holds, never their values, and writes nothing, so this asks for
 * no approval and counts as no shipping call. Prefilled listing text is left
 * out of the answer: it is the project's own words, not a readiness fact.
 */
export async function preflight(args: StoreActArgs): Promise<string> {
  const asked = (Array.isArray(args.browsers) && args.browsers.length ? args.browsers : [text(args.store) || "chrome"]).map((b) => text(b).toLowerCase());
  const unknown = asked.filter((b) => !(STORES as readonly string[]).includes(b));

  if (unknown.length) {
    return badShipRequest(COMMAND, "preflight", "PreflightInputError", `${unknown.join(", ")} is not a store; use ${STORES.join(", ")}. Nothing was sent.`);
  }

  const opened = await openShipApi(COMMAND, args, { action: "preflight" });
  if ("refused" in opened) return opened.refused;

  const api = opened.api;
  const body: Row = {};
  if (text(args.buildSha)) body.buildId = text(args.buildSha);
  if (text(args.channel)) body.channel = text(args.channel);

  const reads = await Promise.all(asked.map((store) => projectApiSend<Row>(api, "POST", `stores/${store}/submissions/preflight`, body)));
  const firstRefusal = reads.find((read) => !read.ok);

  if (firstRefusal && !firstRefusal.ok && reads.every((read) => !read.ok)) {
    return projectApiReadFailure(COMMAND, firstRefusal, { api: args.api, name: "Preflight", value: { action: "preflight", stores: asked } });
  }

  const stores: Row = {};
  const unread: string[] = [];

  asked.forEach((store, i) => {
    const read = reads[i];
    if (read.ok) stores[store] = readinessView(read.json, store, text(args.projectPath));
    else unread.push(`${store}: ${read.message}`);
  });

  const blocked = Object.entries(stores).filter(([, view]) => (view as Row).canSubmit !== true).map(([store]) => store);
  const coverable = Object.entries(stores)
    .filter(([, view]) => isRow((view as Row).storeMd) && Array.isArray(((view as Row).storeMd as Row).covers) && (((view as Row).storeMd as Row).covers as unknown[]).length)
    .map(([store]) => store);
  const syncLine = coverable.length
    ? ` STORE.md and the build already cover part of the ${coverable.join(", ")} listing: extension_submit action:"sync-listing" with browsers:[${coverable.map((s) => `"${s}"`).join(", ")}] and projectPath fills it after a workspace owner approves.`
    : "";
  const unreadLine = unread.length ? `Readiness could not be read for ${unread.join("; ")}.` : null;
  const storesPageUrl = consoleProjectUrl(api.ref, ConsoleProjectPage.stores, args.api);
  const readinessHint = blocked.length
    ? `${blocked.join(", ")} cannot be submitted yet; each failing check says what to fix.${syncLine} This read wrote nothing.`
    : "Every store read here is ready to submit. This read wrote nothing; extension_submit with dryRun:false submits.";
  const chrome = isRow(stores.chrome) ? stores.chrome : null;
  const connection = chrome && isRow(chrome.connection) ? chrome.connection : null;

  if (chrome && connection && (!text(connection.kind) || connection.healthy === false)) {
    const connected = Boolean(text(connection.kind));
    const settingsUrl = storeSettingsUrl(api.ref, args.api);
    const connectUrl = text(connection.connectUrl) || fallbackConnectUrl(api.ref, "chrome", args.api);
    const say = connected
      ? `${failedCheckSentence(text(connection.reason))} ${connectSentences(connectUrl)}`
      : connectSentences(connectUrl);
    const others = blocked.filter((store) => store !== "chrome");

    return envelope({
      ok: true,
      command: COMMAND,
      status: connected ? "store-connection-failed" : "store-not-connected",
      value: { action: "preflight", stores, storesPageUrl, connectUrl, trackUrl: settingsUrl, sayToPerson: say, nextStep: nextStep("connect", say, connectUrl) },
      hint: say,
      warnings: [
        others.length ? `${others.join(", ")} cannot be submitted yet either; each failing check says what to fix.` : null,
        unreadLine,
        "This read wrote nothing.",
      ],
    });
  }

  if (chrome && connection && connection.healthy === true && connection.itemLinked === false) {
    const settingsUrl = storeSettingsUrl(api.ref, args.api);
    const urls = itemLinkUrls([connection], settingsUrl);
    const say = linkItemSentences(urls);

    return envelope({
      ok: true,
      command: COMMAND,
      status: "store-item-not-linked",
      value: { action: "preflight", stores, storesPageUrl, ...urls, trackUrl: settingsUrl, sayToPerson: say, nextStep: nextStep("link-item", say, urls.linkItemUrl) },
      hint: say,
      warnings: [unreadLine, "This read wrote nothing."],
    });
  }

  const itemUrl = chrome && connection && text(connection.itemId) ? text(connection.itemUrl) : "";
  const green = blocked.length === 0 && unread.length === 0;

  return envelope({
    ok: true,
    command: COMMAND,
    status: "preflight-read",
    value: { action: "preflight", stores, storesPageUrl, ...(itemUrl ? { itemUrl } : {}), nextStep: green ? submitStep(asked) : null },
    hint: `${readinessHint}${itemUrl ? ` The Chrome Web Store item is at ${itemUrl}.` : ""}`,
    warnings: [unreadLine],
  });
}
