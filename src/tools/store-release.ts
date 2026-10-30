// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { awaitRecordedOutcome, dispatchedHint, linksOf, madeSentence, stampNow } from "../lib/act-outcome";
import { envelope } from "../lib/envelope";
import { readSubmissionRecord, type PlatformSubmission } from "../lib/platform-submissions";
import { badShipRequest, openShipApi, runShipAct, text } from "../lib/ship-act";
import { actLinks, judgeRelease, releaseFailureReason, trackOf } from "../lib/store-act-outcome";
import { COMMAND, safariBuildNumberOf, storesRead, type Row, type StoreActArgs } from "./store-acts";

const RELEASE_CONSEQUENCE = "This puts the version on sale in the App Store now; it cannot be pulled back by the platform.";

function releaseStore(args: StoreActArgs): string {
  const named = text(args.store).toLowerCase();
  const browsers = Array.isArray(args.browsers) ? args.browsers.map((browser) => text(browser).toLowerCase()) : [];

  if (named) return browsers.length && !browsers.every((browser) => browser === named) ? "" : named;
  if (browsers.length === 1) return browsers[0] ?? "";

  return browsers.length ? "" : "safari";
}

export async function releaseVersion(args: StoreActArgs): Promise<string> {
  const store = releaseStore(args);

  if (store !== "safari") {
    return badShipRequest(
      COMMAND,
      "release",
      "ReleaseInputError",
      `release puts an App Store version Apple approved under manual release on sale, so browsers must be ["safari"] (or store "safari"); got ${JSON.stringify(args.browsers ?? args.store ?? null)}. Chrome, Edge and Firefox put an approved version live on their own. Nothing was sent.`,
    );
  }

  const submissionId = text(args.submissionId);
  const buildNumber = safariBuildNumberOf(args.buildNumber);

  if (buildNumber !== null && !Number.isFinite(buildNumber)) {
    return badShipRequest(
      COMMAND,
      "release",
      "ReleaseInputError",
      `buildNumber is the TestFlight build number Apple shows, a whole number above zero; got ${JSON.stringify(args.buildNumber)}. Nothing was sent.`,
    );
  }

  const named = {
    ...(submissionId ? { submissionId } : {}),
    ...(buildNumber ? { buildNumber } : {}),
  };
  const opened = await openShipApi(COMMAND, args, { action: "release", store });
  if ("refused" in opened) return opened.refused;

  const ran = await runShipAct(
    {
      command: COMMAND,
      act: "release",
      action: "extension_store.release",
      route: `stores/${store}/release`,
      body: named,
      approvalId: args.approvalId,
      description: "Release the App Store version Apple approved for manual release.",
      reason: `${RELEASE_CONSEQUENCE} A workspace owner approves releasing this exact version first.`,
      stateRead: storesRead(args),
      irreversible: true,
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

  if (!ran.ok) return ran.out;

  const json = ran.json;
  const sentId = text(json.submissionId) || submissionId;
  const acceptedAt = text(json.dispatchedAt) || stampNow();
  const itemUrl = text(json.itemUrl);
  const base: Row = { action: "release", ...json, store, submissionId: sentId };
  const itemLink = itemUrl ? [{ kind: "item" as const, url: itemUrl, audience: "you" as const }] : [];
  const links = text(json.trackUrl)
    ? linksOf([{ kind: "submission", url: text(json.trackUrl) }, ...itemLink])
    : actLinks(COMMAND, { ...args, action: "release" } as Row, "released", base, itemLink, "submission");
  const trackUrl = text(json.trackUrl) || trackOf(links);
  const version = text(json.version);
  const waited = await awaitRecordedOutcome<PlatformSubmission>({
    waitSeconds: args.waitSeconds,
    read: () => readSubmissionRecord(opened.api, { submissionId: sentId, store }),
    judge: judgeRelease(acceptedAt),
  });
  const made = madeSentence(links);
  const value: Row = { ...base, outcome: waited.outcome, links, trackUrl };

  if (waited.failed) {
    const reason = releaseFailureReason(waited.record, "the release run failed before App Store Connect answered");

    return envelope({
      ok: false,
      command: COMMAND,
      status: "release-failed",
      value,
      error: {
        code: "E_PLATFORM",
        name: "ReleaseFailed",
        message: `App Store Connect did not release version ${version || sentId}: ${reason}`,
      },
      hint: `Nothing went on sale. ${storesRead(args)} reads the state Apple reports now. ${made}`,
    });
  }

  if (waited.outcome.recorded) {
    const onSale = waited.outcome.storeState === "READY_FOR_SALE" || waited.outcome.storeState === "READY_FOR_DISTRIBUTION";

    return envelope({
      ok: true,
      command: COMMAND,
      status: "released",
      value,
      hint: onSale
        ? `The platform's record of submission ${sentId} reads ${waited.outcome.storeState}, so version ${version || "the version"} is on sale in the App Store. ${made}`
        : `The platform's record of submission ${sentId} carries App Store Connect's acceptance of the release${waited.outcome.storeState ? `, with the version reading ${waited.outcome.storeState}` : ""}; the next store poll records when it reads READY_FOR_SALE, and ${storesRead(args)} reads it. ${made}`,
    });
  }

  return envelope({
    ok: true,
    command: COMMAND,
    status: "release-dispatched",
    value,
    hint: `${dispatchedHint({ acceptedAt, trackUrl, readCall: storesRead(args) })} ${made}`,
  });
}
