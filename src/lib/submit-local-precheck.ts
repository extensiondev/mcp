// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { chromeWebStoreMdCheck } from "./chromewebstore-md";
import { envelope } from "./envelope";
import { FIREFOX_AGREEMENT_CHECK, FIREFOX_AGREEMENT_URL } from "./firefox-enterprise";
import { projectApiGet, type ProjectApi } from "./project-api";
import { type ProjectRef } from "./registry";
import { text } from "./ship-act";
import { nextStep } from "./store-connection";
import { builtToolchainFor, reviewerNoteToolchainCheck } from "./store-md-toolchain";
import { FIREFOX_LISTING_CHECK, SAFARI_DESCRIPTION_CHECK, SAFARI_DESCRIPTION_MAX, firefoxListingCheck, safariDescriptionCheck } from "./store-preflight-local";
import { trackUrl as consoleTrackUrl } from "./track-url";
import { readLocalListing } from "../tools/store-listing";

import type { ListingStore } from "./store-md-declarations";

type Row = Record<string, unknown>;

export const LOCAL_CHECK_FAILED_STATE = "preflight-failed" as const;

export const SAFARI_DESCRIPTION_UNCHECKED = `The Safari manifest description check (${SAFARI_DESCRIPTION_CHECK}: ${SAFARI_DESCRIPTION_MAX} characters or fewer, App Store Connect error 90849) did not run because no projectPath was given; pass projectPath to run it before the approval is asked for.`;

export interface LocalPrecheckArgs {
  api: ProjectApi | null;
  browsers: string[];
  buildSha: string;
  projectPath?: string;
  ref: ProjectRef | null;
  apiBase?: string;
}

const REFUSAL_NAMES: Record<string, { name: string; code: string }> = {
  [SAFARI_DESCRIPTION_CHECK]: { name: "SafariDescriptionTooLong", code: "E_MANIFEST_BLOCKING" },
  [FIREFOX_LISTING_CHECK]: { name: "FirefoxListingMissing", code: "E_PLATFORM" },
  [FIREFOX_AGREEMENT_CHECK]: { name: "FirefoxAgreementNotAccepted", code: "E_PLATFORM" },
};

async function firefoxRow(api: ProjectApi | null): Promise<Row | null> {
  if (!api) return null;

  return firefoxListingCheck(await projectApiGet<Row>(api, "stores/firefox/listing").catch(() => null));
}

export function localCheckRefusal(rows: Array<{ store: string; row: Row }>, args: LocalPrecheckArgs): string {
  const first = rows[0]!;
  const id = text(first.row.id);
  const named = REFUSAL_NAMES[id] ?? { name: "PreflightFailed", code: "E_PLATFORM" };
  const say = rows.map(({ row }) => text(row.message)).join(" ");
  const sync = id === FIREFOX_LISTING_CHECK;
  const agreement = id === FIREFOX_AGREEMENT_CHECK;
  const trackUrl = agreement
    ? FIREFOX_AGREEMENT_URL
    : consoleTrackUrl(
        sync ? "store" : "build",
        {
          ...(args.ref ? { workspace: args.ref.workspace, project: args.ref.project } : {}),
          ...(sync ? { store: first.store } : { buildId: args.buildSha, browser: first.store }),
        },
        args.apiBase,
      );

  return envelope({
    ok: false,
    command: "extension_submit",
    status: LOCAL_CHECK_FAILED_STATE,
    error: {
      code: named.code,
      name: named.name,
      checkId: id,
      message: `${say} Nothing was submitted and no approval was asked for.`,
    },
    value: {
      browsers: args.browsers,
      buildSha: args.buildSha,
      store: first.store,
      refusedBeforeApproval: true,
      failing: rows.map(({ store, row }) => ({ store, ...row })),
      trackUrl,
      sayToPerson: say,
      nextStep: nextStep(sync ? "sync-listing" : agreement ? "configure" : "resubmit", say, trackUrl),
    },
    hint: say,
  });
}

const refusal = localCheckRefusal;

export async function localSubmitPrecheck(args: LocalPrecheckArgs): Promise<{ refused: string | null; warnings: string[] }> {
  const projectPath = text(args.projectPath);
  const safari = args.browsers.includes("safari");
  const wantsFirefox = args.browsers.includes("firefox");
  const warnings = safari && !projectPath ? [SAFARI_DESCRIPTION_UNCHECKED] : [];
  const safariRow = safari && projectPath ? safariDescriptionCheck(projectPath) : null;
  const firefox = wantsFirefox ? await firefoxRow(args.api) : null;
  const toolchain = wantsFirefox && projectPath ? reviewerNoteToolchainCheck(projectPath, await builtToolchainFor(args.api, projectPath, args.buildSha)) : null;
  if (toolchain) warnings.push(text(toolchain.message));

  for (const store of projectPath ? args.browsers : []) {
    const held = chromeWebStoreMdCheck(projectPath, store as ListingStore, readLocalListing(projectPath, store as ListingStore));
    if (held) warnings.push(`${store}: ${text(held.message)}`);
  }

  const rows = [
    ...(safariRow ? [{ store: "safari", row: safariRow }] : []),
    ...(firefox ? [{ store: "firefox", row: firefox }] : []),
  ];

  return { refused: rows.length ? refusal(rows, args) : null, warnings };
}
