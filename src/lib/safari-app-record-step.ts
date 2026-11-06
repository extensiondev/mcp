// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { isRow, text } from "./ship-act";
import { storeSettingsUrl } from "./store-connection";
import { STORE_MD_FILENAME } from "./store-md";
import { LISTING_TEXT_LIMITS } from "./store-md-declarations";

import type { PackageScope } from "./package-address";
import type { BringList } from "./store-bring-list";
import type { LocalListingRead, RequirementsView } from "./store-requirements";

type Row = Record<string, unknown>;

export const APP_RECORD_ROW = "safari.app_record";
export const BUNDLE_IDS_ROW = "safari.bundle_identifiers";
export const BUNDLE_IDS_CHECK = "store.safari_bundle_identifiers";
export const SIGNING_ASSETS_ROUTE = "POST /api/projects/<projectId>/stores/safari/signing-assets";
export const NEW_APP_URL = "https://appstoreconnect.apple.com/apps";

export type BundleRegistration = "registered" | "unconfirmed" | "unsaved";

export interface AppRecordValues {
  platform: "macOS";
  name: string | null;
  nameFrom: string;
  bundleId: string | null;
  sku: string | null;
  skuFrom: string;
  primaryLanguage: null;
  primaryLanguageFrom: string;
}

export interface SafariAppRecordStep {
  registration: BundleRegistration;
  bundleIds: { app: string; extension: string } | null;
  mint: { console: string; route: string; mcpAction: null };
  newAppUrl: string;
  values: AppRecordValues;
  say: string;
}

export const SKU_FROM = `${STORE_MD_FILENAME} has no SKU row and the platform sets none, so the bundle id serves as the SKU`;
export const LANGUAGE_FROM = `${STORE_MD_FILENAME} has no primary language row and the platform sets none, so pick the language the listing is written in`;

function bundleIdsOf(requirements: RequirementsView | null): { app: string; extension: string } | null {
  const row = requirements?.items.find((item) => item.id === BUNDLE_IDS_ROW);
  if (!row || row.status !== "have" || !row.satisfiedBy.startsWith("store-config")) return null;

  const app = text(row.actual).split(" and ")[0]?.trim() || "";

  return app ? { app, extension: `${app}.extension` } : null;
}

function registrationOf(checks: Row[], bundleIds: { app: string } | null): BundleRegistration {
  if (!bundleIds) return "unsaved";

  const check = checks.find((row) => text(row.id) === BUNDLE_IDS_CHECK);

  return check && text(check.status) === "pass" ? "registered" : "unconfirmed";
}

function nameOf(local: LocalListingRead): { name: string | null; from: string } {
  if (!local || "problem" in local) return { name: null, from: `no ${STORE_MD_FILENAME} read: add \`- App Store name:\` under \`## Safari\`, or \`- Name:\` under \`## Listing\` (up to ${LISTING_TEXT_LIMITS.appStoreName} characters)` };

  const listing = local.patch.listing;
  if (listing.appStoreName) return { name: listing.appStoreName, from: `\`- App Store name:\` under \`## Safari\` in ${STORE_MD_FILENAME}` };
  if (listing.title) return { name: listing.title, from: `\`- Name:\` under \`## Listing\` in ${STORE_MD_FILENAME}` };
  if (local.unread.title) return { name: null, from: `${STORE_MD_FILENAME}'s \`${local.unread.title.line}\` ${local.unread.title.reason}` };

  return { name: null, from: `${STORE_MD_FILENAME} has no \`- App Store name:\` under \`## Safari\` and no \`- Name:\` under \`## Listing\`; add one (up to ${LISTING_TEXT_LIMITS.appStoreName} characters)` };
}

function valuesSentence(values: AppRecordValues): string {
  const name = values.name ? `name ${values.name} (from ${values.nameFrom})` : `name: ${values.nameFrom}`;
  const bundle = values.bundleId ? `bundle ID ${values.bundleId}` : "bundle ID: the one saved on the store settings";
  const sku = values.sku ? `SKU ${values.sku} (${values.skuFrom})` : `SKU: ${values.skuFrom}`;

  return `create the app record once at ${NEW_APP_URL} (New App) with platform macOS, ${name}, ${bundle}, ${sku}, primary language: ${values.primaryLanguageFrom}; then run the credential test on the store settings page so the App Store id is captured.`;
}

export function safariAppRecordStep(args: { requirements: RequirementsView | null; checks: Row[]; local: LocalListingRead; scope: PackageScope }): SafariAppRecordStep | null {
  const row = args.requirements?.items.find((item) => item.id === APP_RECORD_ROW);
  if (!row || row.status === "have") return null;

  const bundleIds = bundleIdsOf(args.requirements);
  const registration = registrationOf(args.checks.filter(isRow), bundleIds);
  const name = nameOf(args.local);
  const settings = storeSettingsUrl(args.scope.ref, args.scope.api);
  const values: AppRecordValues = {
    platform: "macOS",
    name: name.name,
    nameFrom: name.from,
    bundleId: bundleIds?.app ?? null,
    sku: bundleIds?.app ?? null,
    skuFrom: SKU_FROM,
    primaryLanguage: null,
    primaryLanguageFrom: LANGUAGE_FROM,
  };
  const mintDoor = `Mint signing assets on the project's Safari store settings page (${settings}) registers both ${bundleIds ? `${bundleIds.app} and ${bundleIds.extension}` : "the app id and its .extension id"} with your Apple team along with the certificates and profiles; no extension_submit action runs that mint yet, since it takes the owner's browser session on ${SIGNING_ASSETS_ROUTE}.`;
  const lead =
    registration === "registered"
      ? `App record: both bundle ids are registered with your Apple team (${bundleIds!.app} and ${bundleIds!.extension}, by Mint signing assets), so App Store Connect lists the bundle id;`
      : registration === "unconfirmed"
        ? `App record: ${bundleIds!.app} is not confirmed registered with Apple, and App Store Connect's New App form lists only registered bundle ids, so register it first. ${mintDoor} Then`
        : `App record: no bundle id is saved yet, so nothing is registered with Apple; save one with extension_submit {action: "configure-store", store: "safari", storeSettings: {bundleId: "<id>"}} first. ${mintDoor} Then`;

  return {
    registration,
    bundleIds,
    mint: { console: settings, route: SIGNING_ASSETS_ROUTE, mcpAction: null },
    newAppUrl: NEW_APP_URL,
    values,
    say: `${lead} ${valuesSentence(values)}`,
  };
}

export function withSafariAppRecordStep(bringList: BringList | null, step: SafariAppRecordStep | null): BringList | null {
  if (!bringList || !step) return bringList;

  const rows = bringList.rows.map((row) => (row.id === APP_RECORD_ROW ? { ...row, clearedBy: step.say } : row));

  return { ...bringList, rows, say: `${bringList.say} ${step.say}` };
}
