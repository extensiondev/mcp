// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { awaitRecordedOutcome, dispatchedHint, linksOf, madeSentence, missedRead, stampNow, type Verdict } from "../lib/act-outcome";
import { envelope } from "../lib/envelope";
import { projectApiGet } from "../lib/project-api";
import { MINT_CALL } from "../lib/safari-app-record-step";
import { badShipRequest, isRow, openShipApi, runShipAct, text } from "../lib/ship-act";
import { storeSettingsUrl, nextStep } from "../lib/store-connection";
import { COMMAND, type Row, type StoreActArgs } from "./store-acts";

export const MINT_SIGNING_ACTION = "mint-signing";
export const MINT_ROUTE = "/api/cli/stores/safari/signing-assets";
export const MINT_POLICY_ACTION = "extension_store.mint";

const PREFLIGHT_READ = 'extension_submit_check {action: "preflight", browsers: ["safari"]}';
const CONFIGURE_CALL = 'extension_submit {action: "configure-store", store: "safari", storeSettings: {bundleId: "<id>"}}';
const CONNECT_CALL = 'extension_submit {action: "connect", store: "safari"}';
const RECORD_FIELDS = ["bundleId", "settingsFilled", "dispatchId", "dispatchedAt", "usualSeconds", "runCorrelation", "approvalId"];

function mintHint(code: string, retryAfterSeconds?: number): string | undefined {
  const wait = retryAfterSeconds ? `${retryAfterSeconds} seconds` : "a minute";

  if (code === "RATE_LIMITED" || code === "rate_limited") return `The platform takes at most 10 mint requests a minute from one login, so nothing ran and no approval was requested; call ${MINT_CALL} again after ${wait}.`;
  if (code === "SAFARI_MINT_INPUT_MISSING") return `The mint needs what the message names: save the bundle id with ${CONFIGURE_CALL}, or connect the App Store Connect key with ${CONNECT_CALL}; then call ${MINT_CALL} again.`;
  if (code === "SAFARI_MINT_SECRETS_UNREADABLE") return `The platform could not read whether the App Store Connect key is saved, so it did not guess and nothing ran; call ${MINT_CALL} again in a moment.`;
  if (code === "SAFARI_MINT_NOT_DISPATCHED") return "The platform could not start the mint, so nothing ran.";
  if (code === "INVALID_BUNDLE_ID") return `The saved bundle id is not one this project can submit under; save a reverse-DNS id in a namespace your Apple team owns with ${CONFIGURE_CALL}, then call ${MINT_CALL} again.`;

  return undefined;
}

function mintStore(args: StoreActArgs): string {
  const named = text(args.store).toLowerCase();
  const browsers = Array.isArray(args.browsers) ? args.browsers.map((browser) => text(browser).toLowerCase()).filter(Boolean) : [];

  if (named) return named;
  if (browsers.length) return browsers.find((browser) => browser !== "safari") ?? "safari";

  return "safari";
}

function judgeMint(dispatchId: string) {
  return (config: Row): Verdict => {
    const safari = isRow(config.safari) ? config.safari : {};
    const mint = isRow(safari.mint) ? safari.mint : null;

    if (!mint || (dispatchId && text(mint.dispatchId) !== dispatchId)) return { kind: "waiting" };

    const state = text(mint.runState);
    if (state === "landed") return { kind: "recorded", status: "minted", storeState: state };
    if (state === "failed") return { kind: "recorded", status: "mint-failed", storeState: state, failed: true };

    return { kind: "waiting", status: state || null };
  };
}

export async function mintSigning(args: StoreActArgs): Promise<string> {
  const store = mintStore(args);

  if (store !== "safari") {
    return badShipRequest(
      COMMAND,
      MINT_SIGNING_ACTION,
      "MintNotApplicable",
      `mint-signing registers a bundle id with Apple and mints its App Store certificates and profiles, which does not apply to ${store}; call it with store "safari". Nothing was sent.`,
    );
  }

  const opened = await openShipApi(COMMAND, args, { action: MINT_SIGNING_ACTION, store });
  if ("refused" in opened) return opened.refused;

  const ran = await runShipAct(
    {
      command: COMMAND,
      act: MINT_SIGNING_ACTION,
      action: MINT_POLICY_ACTION,
      route: "",
      path: MINT_ROUTE,
      body: { origin: "mcp" },
      approvalId: args.approvalId,
      hints: mintHint,
      description:
        "Mint the App Store signing assets for the bundle id saved on the Safari store settings: register it and its extension id with your Apple team and create the distribution certificates and provisioning profiles.",
      reason: "Apple keeps a registered bundle id and counts each certificate against the team's limit, so the platform cannot undo it; a workspace owner approves this exact mint first.",
      stateRead: PREFLIGHT_READ,
      irreversible: true,
      scopeFits: (scope) => text(scope.store) === "safari" && text(scope.act) === MINT_SIGNING_ACTION && Boolean(text(scope.bundleId)),
      project: args.project,
      apiHint: args.api,
      value: { store },
    },
    opened.api,
  );

  if (!ran.ok) return ran.out;

  const json = ran.json;
  const record = Object.fromEntries(RECORD_FIELDS.filter((key) => json[key] !== undefined).map((key) => [key, json[key]]));
  const bundleId = text(json.bundleId) || "the saved bundle id";
  const dispatchId = text(json.dispatchId);
  const acceptedAt = text(json.dispatchedAt) || stampNow();
  const trackUrl = text(json.trackUrl) || storeSettingsUrl(opened.api.ref, args.api);
  const links = linksOf([{ kind: "track", url: trackUrl }]);
  const waited = await awaitRecordedOutcome<Row>({
    waitSeconds: args.waitSeconds,
    read: async () => {
      const read = await projectApiGet<Row>(opened.api, "stores/config");
      if (!read.ok) return missedRead(read);

      return { ok: true, record: isRow(read.json) ? read.json : {} };
    },
    judge: judgeMint(dispatchId),
  });
  const value: Row = { action: MINT_SIGNING_ACTION, store, ...record, outcome: waited.outcome, links, trackUrl };
  const made = madeSentence(links);
  const usual = typeof json.usualSeconds === "number" ? ` It usually takes about ${Math.round(json.usualSeconds / 60) || 1} minutes.` : "";

  if (waited.failed) {
    const mint = isRow(waited.record?.safari) && isRow((waited.record.safari as Row).mint) ? ((waited.record.safari as Row).mint as Row) : {};
    const reason = text(mint.failedReason) || "the platform recorded the mint as failed without a reason";
    const say = `The mint for ${bundleId} failed: ${reason}. The store settings page at ${trackUrl} shows it.`;

    return envelope({
      ok: false,
      command: COMMAND,
      status: "mint-failed",
      value: { ...value, sayToPerson: say, nextStep: nextStep("configure", say, trackUrl) },
      error: { code: "E_PLATFORM", name: "MintFailed", message: `The platform's record of the mint for ${bundleId} reads failed: ${reason}` },
      hint: `${say} ${made}`,
    });
  }

  if (waited.outcome.recorded) {
    const say = `${bundleId} and its extension id are registered with your Apple team, and the signing certificates and profiles are saved. ${PREFLIGHT_READ} reads the Safari readiness again.`;

    return envelope({
      ok: true,
      command: COMMAND,
      status: "minted",
      value: { ...value, sayToPerson: say, nextStep: nextStep("preflight", say, trackUrl) },
      hint: `${say} ${made}`,
    });
  }

  const say = `The platform started minting the App Store signing assets for ${bundleId}: it registers the bundle id and its extension id with your Apple team and creates the certificates and profiles.${usual} The store settings page at ${trackUrl} shows its state.`;

  return envelope({
    ok: true,
    command: COMMAND,
    status: "mint-dispatched",
    value: { ...value, sayToPerson: say, nextStep: nextStep("watch", say, trackUrl) },
    hint: `${say} ${dispatchedHint({ acceptedAt, trackUrl, readCall: PREFLIGHT_READ })} ${made}`,
  });
}
