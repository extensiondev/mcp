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

import {
  awaitRecordedOutcome,
  linksOf,
  madeSentence,
  missedRead,
  recordedOutcome,
  trackLinks,
  unrecordedOutcome,
} from "../lib/act-outcome";
import { envelope } from "../lib/envelope";
import { deferWarning } from "../lib/deferred-warnings";
import { consoleProjectUrl } from "../lib/registry";
import {
  projectApiGet,
  projectApiReadFailure,
  projectApiSend,
  tokenRefusal,
  type ProjectApi,
} from "../lib/project-api";
import {
  actionFingerprint,
  requestApprovalAfterRefusal,
  type ApprovalScope,
} from "../lib/approval-gate";
import { askingOnly } from "../lib/ask-only";
import { checkDigestPatch, type StageFailure } from "../lib/listing-check-stage";
import { checkRefused, plainListingAsk } from "../lib/submit-action-safety";
import {
  VERSION_ACTION,
  linesSentence,
  readLines,
  versionScopeFor,
  type ApprovalLineRow,
} from "../lib/approval-lines";
import { approvalRoundTrip } from "../lib/approval-outcome";
import { mintedApproval } from "../lib/approval-record";
import { chromeDashboardPaste, chromePasteSentence } from "../lib/chrome-dashboard-paste";
import { withChromeVisibility } from "../lib/chrome-visibility";
import { onRecordRow, onRecordSentence, screenshotsOnRecord } from "../lib/listing-on-record";
import { onListingLine, type ListingRecordRead } from "../lib/listing-record-compare";
import { chromePasteLines, type PasteLines } from "../lib/chrome-paste-lines";
import { SCREENSHOTS_DOOR, screenshotsAdvice, screenshotsLineSentence } from "../lib/store-md-screenshots";
import { storeSizeSentence } from "../lib/store-screenshot-sizes";
import { listStoreScreenshots, storeScreenshotsFolder } from "../lib/store-capture";
import { approvalVerdict } from "../lib/approval-policy";
import { badShipRequest, isRow, openShipApi, text } from "../lib/ship-act";
import {
  behindSentence,
  deferredSentence,
  digestMismatchOf,
  withoutFields,
  type DigestMismatch,
} from "../lib/store-listing-digest";
import { pushAnswer, pushSentence, readPushState, sendListing } from "../lib/store-listing-push";
import {
  LISTING_TOO_LARGE_STATUS,
  PLATFORM_REQUEST_BODY_LIMIT_BYTES,
  listingBodyView,
  listingTooLargeHint,
  listingTooLargeMessage,
  measureListingBody,
} from "../lib/listing-body-limit";
import {
  IMAGES_DOOR_MISSING_WARNING,
  IMAGE_NOT_ON_LISTING,
  IMAGE_NOT_ON_LISTING_NEXT,
  stageListingImages,
  stagedImageGuard,
  stagedSentence,
  stagedPatch,
  stagedWriteBody,
  type StagedImage,
} from "../lib/listing-image-stage";
import { firefoxCategoryCover } from "../lib/firefox-category-cover";
import { iconPaddingView } from "../lib/chrome-icon-padding";
import { CHROMEWEBSTORE_MD_FILENAME, CHROMEWEBSTORE_MD_PREFILL_CALL, chromeWebStoreHeld, chromeWebStoreHeldSentence, readChromeWebStoreMd, type ChromeWebStoreHeld } from "../lib/chromewebstore-md";
import { STORE_MD_FILENAME } from "../lib/store-md";
import { EDGE_STORE_LOGO_RECIPE } from "../lib/store-bring-list";
import {
  OVER_LIMIT_CODE,
  overLimitHint,
  overLimitRefusalMessage,
  overLimitSentence,
  overLimitSentences,
  platformOverLimitOf,
  storeMdOverLimitOf,
  syncRetryCall,
  type StoreMdOverLimit,
} from "../lib/store-md-over-limit";
import { reconcileChromeCheck } from "../lib/store-md-chrome-reconcile";
import { requirementsView, type RequirementsView } from "../lib/store-requirements";
import { linesNotFound, storeMdLineOf, storeMdSectionOf, type StoreMdLineNotFound } from "../lib/store-md-fields";
import {
  LISTING_STORES,
  LISTING_TEXT_LIMITS,
  PRIVACY_SECTION,
  STORE_FIELDS,
  STORE_SECTIONS,
  derivedListingFields,
  listingForStore,
  parseStoreMdListing,
  type ListingField,
  type ListingStore,
  type StoreMdPrivacy,
  type UnreadLine,
} from "../lib/store-md-listing";
import { categoriesSentences, type CategoryRead, type StoreCategoryRow } from "../lib/store-categories";
import {
  localIcon,
  platformBuildIcons,
  staleSentence,
  type IconOrigin,
  type IconStale,
} from "../lib/store-listing-icon";
import {
  STORE_LISTING_ACTION,
  approvalBody,
  listingDigest,
  readScreenshots,
  screenshotRefusal,
  screenshotRule,
  writeBody,
  type ListingDigestPatch,
  type ListingImage,
  type ListingPatch,
} from "../lib/store-listing-media";

const COMMAND = "extension_submit";
const ACT = "sync-listing";
const DONE_STATUSES = new Set(["synced", "unchanged", "icon-stale"]);
const LANDED_STATUSES = new Set(["synced", "recorded", "unchanged", "icon-stale"]);
const SETTLED_STATUSES = new Set([...LANDED_STATUSES, "nothing-to-sync", "approval-required", "left-out"]);
const OWNER_FILE_CODES = new Set([OVER_LIMIT_CODE, "INVALID_LISTING"]);

export { overLimitSentences };

type Row = Record<string, unknown>;

interface StoreShots {
  screenshots: ListingImage[];
  from?: { folder: string; files: string[] };
}

export interface ListingArgs {
  browsers?: string[];
  store?: string;
  projectPath?: string;
  screenshots?: unknown;
  approvalId?: string;
  useBuild?: string;
  project?: string;
  api?: string;
  waitSeconds?: unknown;
}

export interface LocalListing {
  file: string;
  store: ListingStore;
  patch: ListingPatch;
  icon?: IconOrigin;
  iconMissing?: string;
  iconStale?: IconStale;
  iconNote?: string;
  skipped: string[];
  unread: Partial<Record<ListingField, UnreadLine>>;
  overLimit: StoreMdOverLimit[];
  borrowed?: Partial<Record<ListingField, string>>;
  screenshotsLine?: string;
  lines: Partial<Record<ListingField, string>>;
  privacy: StoreMdPrivacy;
  categories?: CategoryRead;
  screenshotsNamed?: number;
  pasteLines?: PasteLines;
}

export { SCREENSHOTS_DOOR };

const privacyCoveredFact = (url: string): string =>
  `privacy policy URL found in ${STORE_MD_FILENAME} (${url}), not yet in the console listing`;

export const privacyMissingLine = (): string =>
  `privacy policy URL: ${STORE_MD_FILENAME} has no \`${storeMdLineOf("privacyPolicyUrl")}\` under \`${PRIVACY_SECTION}\``;

/* @invariant A FIREFOX SYNC IS NOT A RECORD ONLY. AMO keeps categories,
 * summary, description, homepage and support on the add-on and refuses the
 * first listed version of an add-on with none (Rebeccat, 2026-10-26); the
 * platform writes them onto the add-on with the next listed upload, in the
 * same run, and a refusal there fails that upload with AMO's own words. */
export const FIREFOX_METADATA_SENTENCE =
  "For firefox, the listing's categories, summary, description, homepage and support reach the AMO add-on with the next listed upload, in the same run, before the version is created; AMO's refusal of any of them fails that upload with AMO's own words in the submission record. An unlisted upload leaves the AMO listing untouched.";

export const PLAIN_LISTING_SENTENCE =
  "This listing sync was a plain act under the owner's own token and asked for no approval, since every value is the owner's own STORE.md line; only a value the platform derives takes a workspace owner's approval.";

export const EDGE_STORE_LOGO_SENTENCE = `For edge, the store logo is still open: ${EDGE_STORE_LOGO_RECIPE}.`;

export function borrowedSentence(store: string, borrowed: Partial<Record<ListingField, string>>): string {
  const fields = Object.keys(borrowed) as ListingField[];
  if (!fields.length) return "";

  const lines = fields.map((field) => `\`${storeMdLineOf(field)}\``);
  const joined = lines.length > 1 ? `${lines.slice(0, -1).join(", ")} and ${lines[lines.length - 1]}` : lines[0];

  return `For ${store}, ${joined} ${lines.length === 1 ? "was" : "were"} read from the \`${borrowed[fields[0]!]}\` section of ${STORE_MD_FILENAME}, since \`${STORE_SECTIONS[store as ListingStore]}\` has none of its own; Edge takes the same text Chrome does.`;
}

/* @invariant WITH NO APP STORE NAME LINE, THE APP STORE TITLE IS THE RECORD'S
 * OWN NAME. The credential test reads the app record's name from Apple for
 * the saved bundle id and the platform keeps it beside the Safari settings;
 * the record's name is what Apple shows and what the listing must match, so
 * it stands in for a Name that is over the limit or different from it
 * (ledger 160). A `- App Store name:` line is the owner's word and wins, and
 * a config read that fails changes nothing.
 */
async function adoptAppRecordName(api: ProjectApi, local: LocalListing): Promise<void> {
  if (local.patch.listing.appStoreName) return;

  const read = await projectApiGet<Row>(api, "stores/config").catch(() => null);
  if (!read || !read.ok) return;

  const safari = isRow(read.json) && isRow(read.json.safari) ? read.json.safari : null;
  const record = safari && isRow(safari.appRecord) ? safari.appRecord : null;
  const name = record ? text(record.name) : "";

  if (!name || name.length > LISTING_TEXT_LIMITS.appStoreName) return;

  local.patch.listing.title = name;
  delete local.unread.title;
  local.skipped = local.skipped.filter((line) => !line.startsWith("title in STORE.md"));
}

export function readLocalListing(
  projectPath: string,
  store: ListingStore,
  screenshots?: ListingImage[],
): LocalListing | { problem: string } {
  const file = path.join(projectPath, STORE_MD_FILENAME);
  let content: string;

  try {
    content = fs.readFileSync(file, "utf8");
  } catch {
    const held = chromeWebStoreHeld(readChromeWebStoreMd(projectPath), store, STORE_FIELDS[store]);

    return {
      problem: `No ${STORE_MD_FILENAME} at ${file}. ${held.length ? chromeWebStoreHeldSentence(held, false) : "Create it with the listing copy first (the browser-extension skill's store-md reference has the shape)."}`,
    };
  }

  const parsed = parseStoreMdListing(content);
  const read = listingForStore(parsed, store);
  const { listing, skipped, unread } = withChromeVisibility(read, parsed.lines.visibility);
  const icon = localIcon(projectPath, store);
  const patch: ListingPatch = { listing };
  const screenshotsLine = parsed.screenshotsLine && !screenshots?.length ? screenshotsLineSentence(parsed.screenshotsLine, parsed.screenshotFiles ?? 0) : "";

  if ("icon" in icon) patch.icons = [icon.icon];
  if (screenshots?.length) patch.screenshots = screenshots;

  return {
    file,
    store,
    patch,
    skipped,
    unread,
    overLimit: read.overLimit.map(({ field, ...measure }) => storeMdOverLimitOf(store, field, measure, parsed.lines[field])),
    ...(read.borrowed ? { borrowed: read.borrowed } : {}),
    ...(screenshotsLine ? { screenshotsLine } : {}),
    lines: parsed.lines,
    privacy: parsed.privacy,
    ...(parsed.screenshotsLine ? { screenshotsNamed: parsed.screenshotFiles ?? 0 } : {}),
    ...(store === "chrome" ? { pasteLines: chromePasteLines(content) } : {}),
    ...(read.categories ? { categories: read.categories } : {}),
    ...("icon" in icon ? { icon: icon.origin } : { iconMissing: icon.missing }),
    ...("stale" in icon && icon.stale ? { iconStale: icon.stale } : {}),
  };
}

/* @invariant THE ICON A BUILD CARRIES REPLACES THE LOCAL READ; A LOCAL READ
 * THE PLATFORM BUILD CANNOT BE READ FOR STAYS WHAT IT WAS. With a completed
 * platform build of the checked out commit (or of useBuild), the store's icon
 * is the one in that build's package, whatever dist holds; the local pick is
 * kept only when the package cannot be read, with the reason beside it, and a
 * dist older than the source stays withheld either way, now naming the newest
 * platform build to take the icon from.
 */
async function adoptBuildIcon(
  builds: Awaited<ReturnType<typeof platformBuildIcons>>,
  store: ListingStore,
  local: LocalListing,
): Promise<void> {
  if (builds.build) {
    const taken = await builds.take(store);

    if ("icon" in taken) {
      local.patch.icons = [taken.icon];
      local.icon = taken.origin;
      delete local.iconMissing;
      delete local.iconStale;

      return;
    }

    local.iconNote = `The icon of build ${builds.build} could not be read for ${store} (${taken.problem})${local.icon ? `; the ${local.icon.from} icon was sent instead` : ""}.`;
  }

  if (local.iconStale) local.iconMissing = staleSentence(local.iconStale, builds.newest);
}

interface CheckCoverage {
  test: RegExp;
  fields: ListingField[];
  label: string;
  shape: string;
}

const CHECK_COVERAGE: CheckCoverage[] = [
  {
    test: /^listing\.title_present$/,
    fields: ["title"],
    label: "title",
    shape: "`- Name: <name>`",
  },
  {
    test: /description_present$|summary_present$/,
    fields: ["shortDescription", "fullDescription"],
    label: "description",
    shape:
      "`- Summary: <one sentence>` and `- Description:` with its paragraphs indented below it",
  },
  {
    test: /license_present$/,
    fields: ["license"],
    label: "license",
    shape: "`- License: <SPDX identifier or license name>`",
  },
  {
    test: /categories_present$/,
    fields: ["categories"],
    label: "category",
    shape:
      "`- Category: <name>` for every store, `- Category: <name> (Chrome), <name> (Firefox)` per store, or `- Category: <name>` under the store's own `##` section",
  },
  {
    test: /support_email_present$/,
    fields: ["supportEmail"],
    label: "support email",
    shape: "`- Support email: <address>`",
  },
  {
    test: /search_terms_present$/,
    fields: ["searchTerms"],
    label: "search terms",
    shape: "`- Search terms: <term>, <term>`",
  },
  {
    test: /privacy_policy_present$/,
    fields: ["privacyPolicyUrl"],
    label: "privacy policy URL",
    shape: "`- Privacy policy URL: <address>` under `## Privacy and data use`",
  },
  {
    test: /certification_notes$/,
    fields: ["certificationNotes"],
    label: "certification notes",
    shape: "`### Certification notes` under `## Edge Add-ons` with the notes below it",
  },
];

function notFoundLine(local: LocalListing, rule: CheckCoverage): string {
  const lines = rule.fields.map((field) => `\`${storeMdLineOf(field)}\``);
  const joined = lines.length > 1 ? `${lines.slice(0, -1).join(", ")} or ${lines[lines.length - 1]}` : lines[0];
  const { section } = storeMdSectionOf(rule.fields[0]!, local.store);

  return `${rule.label}: ${STORE_MD_FILENAME} has no ${joined} under \`${section}\``;
}

function unreadLine(local: LocalListing, rule: CheckCoverage): string | null {
  for (const field of rule.fields) {
    const unread = local.unread[field];
    if (!unread) continue;

    return `${rule.label}: the \`${unread.line}\` line in ${STORE_MD_FILENAME} ${unread.reason}; the reader takes ${rule.shape}`;
  }

  return null;
}

function onListingLines(listing: Row, settled: Row[], record: ListingRecordRead): string[] {
  const lines: string[] = [];

  for (const check of settled) {
    const id = text(check.id);

    if (/privacy_policy_present$/.test(id)) {
      if (listing.privacyPolicyUrl !== undefined) {
        lines.push(onListingLine("privacy policy URL", text(listing.privacyPolicyUrl), listing, ["privacyPolicyUrl"], record));
      }

      continue;
    }

    const rule = CHECK_COVERAGE.find((entry) => entry.test.test(id));
    if (!rule) continue;

    if (rule.fields.some((field) => listing[field] !== undefined)) {
      lines.push(onListingLine(rule.label, "it", listing, rule.fields, record));
    }
  }

  return lines;
}

type Coverage =
  | { covered: string }
  | { missing: string }
  | { unread: string }
  | null;

function coverageOf(local: LocalListing, id: string): Coverage {
  const listing = local.patch.listing as Row;

  if (/privacy_policy_present$/.test(id)) {
    return listing.privacyPolicyUrl !== undefined
      ? { covered: privacyCoveredFact(text(listing.privacyPolicyUrl)) }
      : { missing: privacyMissingLine() };
  }

  if (/icon_present$/.test(id)) {
    const icon = local.patch.icons?.[0];

    return icon
      ? {
          covered: `icon 128 px found in ${icon.source}, not yet in the listing`,
        }
      : {
          missing: `icon: ${local.iconMissing ?? "no 128 px icon in the built dist"}`,
        };
  }

  if (/screenshots_present$/.test(id)) {
    const shots = local.patch.screenshots;

    if (shots?.length) return { covered: `screenshots: ${shots.length} passed to sync-listing, not yet in the listing` };

    return { missing: `screenshots: ${screenshotsAdvice(local.screenshotsNamed)}; ${storeSizeSentence(local.store)}` };
  }

  if (/categories_present$/.test(id) && local.store === "firefox") {
    const cover = firefoxCategoryCover(local);

    if (cover && "unread" in cover) return { unread: cover.unread };
    if (cover) return { covered: `category ${cover.names.join(", ")} (${cover.origin}) found in ${STORE_MD_FILENAME}, not yet in the console listing` };
  }

  const rule = CHECK_COVERAGE.find((entry) => entry.test.test(id));
  if (!rule) return null;

  if (rule.fields.some((field) => listing[field] !== undefined)) {
    return {
      covered: `${rule.label} found in ${STORE_MD_FILENAME}, not yet in the console listing`,
    };
  }

  const unread = unreadLine(local, rule);

  return unread ? { unread } : { missing: notFoundLine(local, rule) };
}

/* @invariant ONE INSTRUCTION PER CHECK. The platform's fix text for a
 * listing check tells the author what to write in STORE.md. When STORE.md
 * (or the built dist, for the icon) already carries that value, the only
 * thing left to do is sync-listing, so the check's message becomes the
 * coverage fact and the platform's "add it to STORE.md" sentence is dropped;
 * the two never appear together. When STORE.md has the line and the reader
 * could not take it, "add it to STORE.md" would send the author to a line
 * that is already there, so the check's message becomes the line shape the
 * reader takes instead. A check STORE.md does not cover at all keeps the
 * platform's words untouched.
 */
export function reconciledWithStoreMd(
  check: Row,
  local: LocalListing | { problem: string } | null,
): Row {
  if (!local || "problem" in local) return check;

  const chrome = reconcileChromeCheck(check, local);
  if (chrome) return chrome;

  const coverage = coverageOf(local, text(check.id));
  if (!coverage || "missing" in coverage) return check;

  return "unread" in coverage
    ? { ...check, message: `${coverage.unread}.` }
    : { ...check, message: `${coverage.covered}; sync-listing writes it.` };
}

export function storeMdAdvisory(
  local: LocalListing,
  checks: Row[],
  settled: Row[] = [],
  _requirements: RequirementsView | null = null,
  record: ListingRecordRead = { read: false },
): Row {
  const covers: string[] = [];
  const notCovered: string[] = [];
  const listing = local.patch.listing as Row;
  const onListing = onListingLines(listing, settled, record);
  const skipped = local.skipped;

  for (const check of checks) {
    const id = text(check.id);
    const coverage = coverageOf(local, id);
    if (!coverage) continue;

    if ("missing" in coverage) {
      notCovered.push(coverage.missing);
    } else if ("unread" in coverage) {
      notCovered.push(coverage.unread);
    } else if (/privacy_policy_present$/.test(id)) {
      covers.push(`${coverage.covered}; sync-listing writes it`);
    } else covers.push(coverage.covered);
  }

  return {
    file: local.file,
    covers,
    notCovered,
    ...(onListing.length ? { onListing } : {}),
    ...(skipped.length ? { skipped } : {}),
    ...(local.overLimit.length ? { overLimit: overLimitRows(local.overLimit) } : {}),
    ...(local.screenshotsLine ? { screenshotsLine: local.screenshotsLine } : {}),
  };
}

function overLimitRows(overs: StoreMdOverLimit[]): Row[] {
  return overs.map((over) => ({ ...over, say: overLimitSentence(over) }));
}

/* @invariant ONE SENTENCE THAT HOLDS FOR EVERY STORE IS SAID ONCE. The
 * screenshots line of STORE.md is one line, read the same way for each
 * store, so its sentence is lifted out of every store's storeMd block into
 * one screenshotsLine at the top of the answer (ledger 407), and the per
 * store blocks keep only what differs between stores.
 */
export function screenshotsLineOnce(stores: Row): { stores: Row; screenshotsLine: string | null } {
  let screenshotsLine: string | null = null;
  const lifted: Row = {};

  for (const [store, view] of Object.entries(stores)) {
    if (!isRow(view) || !isRow(view.storeMd) || !text(view.storeMd.screenshotsLine)) {
      lifted[store] = view;
      continue;
    }

    const { screenshotsLine: line, ...storeMd } = view.storeMd;
    screenshotsLine ??= text(line);
    lifted[store] = { ...view, storeMd };
  }

  return { stores: lifted, screenshotsLine };
}

function heldRow(row: StoreMdLineNotFound, held: ChromeWebStoreHeld[]): Row {
  const holder = held.find((entry) => entry.field === row.field);

  return holder ? { ...row, heldBy: `${CHROMEWEBSTORE_MD_FILENAME} ${holder.heading}`, prefill: CHROMEWEBSTORE_MD_PREFILL_CALL } : { ...row };
}

function filledFields(patch: ListingPatch): string[] {
  return [
    ...Object.keys(patch.listing),
    ...(patch.icons ? ["icons"] : []),
    ...(patch.screenshots ? ["screenshots"] : []),
  ];
}

interface StoreReadBack {
  blocking: string[];
  dashboardUrl: string | null;
  images?: ImageRows;
  screenshotsOnRecord: string | null;
}

/* @invariant WHAT STILL BLOCKS AFTER A WRITE IS EVERY ROW THE PLATFORM
 * STILL CALLS MISSING, NOT ONLY THE listing.* CHECKS. The read back after
 * the write carries the store's requirement rows too; a required row the
 * platform reads missing (an Edge single purpose the sync did not send, a
 * store logo nobody uploaded) is named in stillBlocking beside the failing
 * checks, so a sync never answers "nothing still blocking" for a store the
 * preflight calls not ready (ledger 412).
 */
function readBackOf(store: string, json: Row): StoreReadBack {
  const checks = (Array.isArray(json.checks) ? json.checks : []).filter(isRow);
  const requirements = requirementsView(json.requirements);
  const missingRows = requirements ? requirements.items.filter((row) => row.required && row.status === "missing").map((row) => row.id) : [];

  return {
    ...(requirements ? { images: imageRows(store, requirements) } : {}),
    screenshotsOnRecord: screenshotsOnRecord(requirements),
    blocking: [
      ...checks
        .filter(
          (check) =>
            text(check.id).startsWith("listing.") &&
            (text(check.status) === "fail" || text(check.status) === "warn"),
        )
        .map(
          (check) =>
            `${text(check.id)}${text(check.status) === "warn" ? " (warning)" : ""}`,
        ),
      ...missingRows,
    ],
    dashboardUrl: text(json.dashboardUrl) || null,
  };
}

async function stillBlocking(
  api: ProjectApi,
  store: string,
  waitSeconds: unknown,
): Promise<{ readBack: StoreReadBack | null; problem: string | null }> {
  const waited = await awaitRecordedOutcome<StoreReadBack>({
    waitSeconds,
    read: async () => {
      const read = await projectApiSend<Row>(
        api,
        "POST",
        `stores/${store}/submissions/preflight`,
        {},
      );
      if (!read.ok) return missedRead(read);

      return { ok: true, record: readBackOf(store, read.json) };
    },
    judge: () => ({ kind: "recorded", status: "read" }),
  });

  return { readBack: waited.record, problem: waited.outcome.readProblem ?? null };
}

export interface ImageRows {
  clears: string[];
  remain: string[];
  storeLogo?: "missing" | "unknown";
}

const IMAGE_ROW = /\.(screenshots|store_icon|icon|app_icon|store_logo)$/;

/* @invariant THE ROWS AN IMAGE CLEARS ARE THE PLATFORM'S VERDICT, READ BACK
 * AFTER THE WRITE. Once the listing record holds the screenshots and the
 * icon, the same preflight read that names the still-blocking checks also
 * carries the store's requirement rows; the image rows among them are
 * answered as cleared (have) or remaining (missing or unknown, with the
 * store's own format), so the owner learns which store rows the files just
 * sent satisfy without a second call, and from the platform's judgment, not
 * this server's.
 */
function imageRows(store: string, view: RequirementsView): ImageRows {
  const rows = view.items.filter((row) => IMAGE_ROW.test(row.id));
  const logo = rows.find((row) => row.id.endsWith(".store_logo") && row.status !== "have");

  return {
    clears: rows.filter((row) => row.status === "have").map((row) => row.label),
    remain: rows
      .filter((row) => row.status !== "have")
      .map((row) =>
        row === logo
          ? `${row.label} (${row.format}), not filled by the icon sync-listing sent: ${EDGE_STORE_LOGO_RECIPE}`
          : `${row.label} (${row.format})${row.status === "unknown" ? ", confirmed only on the store's dashboard" : ""}`,
      ),
    ...(logo ? { storeLogo: logo.status === "unknown" ? "unknown" : "missing" } : {}),
  };
}

const STORE_NAMES: Record<string, string> = {
  chrome: "Chrome Web Store",
  edge: "Edge Add-ons",
  firefox: "Firefox AMO",
  safari: "App Store",
};

export function imagesSentence(store: string, sent: number, images: ImageRows): string {
  const name = STORE_NAMES[store] ?? store;
  const files = `${sent} screenshot${sent === 1 ? "" : "s"}`;
  const cleared = images.clears.length ? `${files} clear${sent === 1 ? "s" : ""} the ${name} ${images.clears.join(" and ")} row${images.clears.length === 1 ? "" : "s"}` : `${files} sent; no ${name} image row reads have yet`;
  const remain = images.remain.length ? `; still open: ${images.remain.join("; ")}` : "";

  return `${cleared}${remain}.`;
}

const LISTING_NEXT = {
  declined:
    "A workspace owner declined it, so the listing was not changed. Ask the person whether they still want it before requesting a fresh approval by calling again with no approvalId.",
  mismatch:
    "STORE.md, the built icon or the screenshots changed since it was approved, or it is another store's approval; call again with no approvalId for a fresh one.",
  used: "The call that used it may already have written the listing; run preflight first, and request a fresh approval only if the listing is not there.",
};

export interface DerivedMark {
  field: string;
  from: string;
  line: string;
}

const DERIVED_LINE_TO_ADD: Record<string, string> = { subtitle: "`- Subtitle:` under `## Listing`" };

const SOURCE_LINE: Record<string, string> = { shortDescription: "Summary" };

/* @invariant A DERIVED VALUE IS NAMED AS THE PLATFORM MARKED IT, NEVER
 * INFERRED HERE. The platform's sync answer marks every change entry it did
 * not copy verbatim from the owner with derived true and the field it came
 * from (today the App Store subtitle from the Summary), and its approval
 * answer carries the same mark in the line's own words ("subtitle (derived
 * from Summary): ..."). Both shapes are read, and only those; this server
 * never decides on its own that a value the platform stored was derived, so
 * the sentence to the person says exactly what the platform did and which
 * STORE.md line replaces it with the owner's own words.
 */
export function derivedMarks(changes: unknown): DerivedMark[] {
  if (!Array.isArray(changes)) return [];

  const marks: DerivedMark[] = [];

  for (const change of changes) {
    if (isRow(change) && change.derived === true && text(change.field)) {
      marks.push({ field: text(change.field), from: SOURCE_LINE[text(change.derivedFrom)] ?? text(change.derivedFrom), line: text(change.line) });
    } else if (typeof change === "string") {
      const match = /^(\w+) \(derived from ([^)]+)\): /.exec(change);
      if (match) marks.push({ field: match[1]!, from: match[2]!, line: change });
    }
  }

  return marks;
}

export function derivedSentence(marks: DerivedMark[]): string {
  if (!marks.length) return "";

  const named = marks.map((mark) => `the ${mark.field} (copied from the ${mark.from} line)`);
  const lines = [...new Set(marks.map((mark) => DERIVED_LINE_TO_ADD[mark.field] ?? `\`- ${mark.field}:\``))];
  const joined = lines.length > 1 ? `${lines.slice(0, -1).join(", ")} and ${lines[lines.length - 1]}` : lines[0];

  return `The platform marked ${named.join(" and ")} as derived: ${STORE_MD_FILENAME} carries no line for it, so a workspace owner approves that text before it reaches the store; add ${joined} in ${STORE_MD_FILENAME} to write your own.`;
}

/* @invariant A LISTING THE PLATFORM HASHES DIFFERENTLY IS SENT ONCE MORE
 * WITH ONLY THE FIELDS IT KNOWS. Both sides hash the fields present in the
 * body, so a server that declares a field the platform's build does not
 * take can never match its fingerprint with the full listing. When the
 * fingerprints differ, the fields the platform cannot know are read from
 * digest.platform on its refusal, or from the set the previous release
 * declared when the refusal names nothing, and the sync is sent again once
 * without them, hashing exactly what was sent; the answer then names the
 * fields left out in deferred and both field sets in digest. A second
 * mismatch is answered with the same digest and which side is behind. The
 * same retry covers the approval leg, whose scope was minted for the subset.
 */
const LINE_REFUSALS = new Set([
  "APPROVAL_LINE_DENIED",
  "APPROVAL_CONSUMED",
  "APPROVAL_REVOKED",
  "APPROVAL_SCOPE_MISMATCH",
]);

async function askListing(api: ProjectApi, args: ListingArgs, store: ListingStore, patch: ListingDigestPatch, scope: ApprovalScope): Promise<Row> {
  const expected = derivedListingFields(store, patch.listing);
  const derivedAct =
    approvalVerdict(STORE_LISTING_ACTION, { derived: expected.length > 0 }) === "approval";
  const asking = JSON.parse(
    await requestApprovalAfterRefusal({
      command: COMMAND,
      action: STORE_LISTING_ACTION,
      scope,
      description: `Fill the ${store} store listing from ${STORE_MD_FILENAME} and the built icons.`,
      token: api.token,
      api: args.api,
      refusedStatus: `${ACT}-refused`,
      body: approvalBody(store, patch),
      reason: derivedAct
        ? `The listing carries a value the platform derives rather than copies from ${STORE_MD_FILENAME} (${expected.map((field) => `the App Store ${field.field} from the ${field.line} line`).join(", ")}), and the platform asks a workspace owner to approve that text before it is written; the approval page shows it marked derived.`
        : "A listing sync is a plain act under the owner's own token, and the platform asked a workspace owner to approve this exact change before it is written; the approval page shows it as the platform computed it.",
      stateRead: 'extension_submit_check (action: "preflight")',
    }),
  ) as Row;
  const value = isRow(asking.value) ? asking.value : {};
  const error = isRow(asking.error) ? asking.error : {};
  const derived = derivedMarks(value.changes);

  return text(value.approvalId)
    ? {
        store,
        status: "approval-required",
        approvalId: text(value.approvalId),
        approvalUrl: text(value.approvalUrl),
        ...(text(value.expiresAt)
          ? { expiresAt: text(value.expiresAt) }
          : {}),
        changes: Array.isArray(value.changes) ? value.changes : [],
        ...(derived.length ? { derived } : {}),
      }
    : {
        store,
        status: "refused",
        code: text(error.platformCode) || text(error.name),
        message: text(error.message),
      };
}

function listingTooLarge(store: ListingStore, patch: ListingPatch, bytes: number, refusedByPlatform: boolean): string {
  const view = listingBodyView(patch, bytes);

  return envelope({
    ok: false,
    command: COMMAND,
    status: LISTING_TOO_LARGE_STATUS,
    value: { action: ACT, store, listing: { body: view }, ...(refusedByPlatform ? { platformStatus: 413 } : {}) },
    error: { code: "E_BAD_REQUEST", name: "ListingTooLarge", message: listingTooLargeMessage(store, view, refusedByPlatform) },
    hint: listingTooLargeHint(store, patch, view),
  });
}

async function syncOne(
  api: ProjectApi,
  args: ListingArgs,
  store: ListingStore,
  patch: ListingPatch,
  retried?: DigestMismatch,
  versioned = false,
): Promise<Row | { out: string }> {
  const approvalId = text(args.approvalId);
  const guarded = stagedImageGuard(store, patch);

  if (guarded) return { out: guarded };

  const context = {
    workspace: api.ref.workspace,
    project: `${api.ref.workspace}/${api.ref.project}`,
  };
  const stageFailure = (failed: StageFailure) =>
    "out" in failed
      ? { out: failed.out }
      : { out: projectApiReadFailure(COMMAND, failed.refused, { api: args.api, name: "Listing", value: { action: ACT, store }, context }) };

  if (!approvalId && askingOnly()) {
    if (!derivedListingFields(store, patch.listing).length) return { out: checkRefused(ACT, plainListingAsk(store)) };

    const checked = await checkDigestPatch(api, store, patch);
    if (!("listing" in checked)) return stageFailure(checked);
    if (versioned) return { store, status: "approval-wanted", digestPatch: checked };

    return askListing(api, args, store, checked, { store, listingDigest: listingDigest(checked) });
  }

  const staging = await stageListingImages(api, store, patch);

  if ("out" in staging || "refused" in staging) return stageFailure(staging);

  const staged = staging.mode === "staged" ? staging.images : null;
  const stagedRow = staged ? { staged } : { imagesDoor: "single-body" };
  const sentPatch: ListingDigestPatch = staged ? stagedPatch(patch, staged) : patch;
  const body = { ...(staged ? stagedWriteBody(sentPatch) : writeBody(patch)), ...(approvalId ? { approvalId } : {}) };
  const bodyBytes = measureListingBody(body);

  if (bodyBytes > PLATFORM_REQUEST_BODY_LIMIT_BYTES) return { out: listingTooLarge(store, patch, bodyBytes, false) };

  const { sent, resend } = await sendListing(api, store, body);
  const pushUrl = consoleProjectUrl(
    api.ref,
    ConsoleProjectPage.submissionsStore(store),
    args.api,
  );

  if (!sent.ok && sent.status === 413) return { out: listingTooLarge(store, patch, bodyBytes, true) };

  const subsetRetry = async (mismatch: DigestMismatch): Promise<Row | { out: string }> => {
    const again = await syncOne(api, args, store, withoutFields(patch, mismatch.deferred), mismatch);

    return "out" in again || again.status === "refused"
      ? again
      : { ...again, digest: mismatch.digest, deferred: mismatch.deferred };
  };

  const pushRow = (raw: unknown): Row => {
    const push = pushAnswer(raw, resend, pushUrl);

    return push ? { appStoreConnect: push } : {};
  };

  if (sent.ok) {
    const derived = derivedMarks(sent.json.changes);
    const lines = readLines(sent.json.lines);

    return {
      store,
      status: "synced",
      ...stagedRow,
      changes: Array.isArray(sent.json.changes) ? sent.json.changes : [],
      ...(derived.length ? { derived } : {}),
      ...(lines.length ? { lines } : {}),
      ...pushRow(sent.json.appStoreConnect),
    };
  }

  if (sent.held || sent.status === 0 || tokenRefusal(sent.code, context)) {
    return {
      out: projectApiReadFailure(COMMAND, sent, {
        api: args.api,
        name: "Listing",
        value: { action: ACT, store },
        context,
      }),
    };
  }

  if (sent.code === "NO_CHANGE") {
    return {
      store,
      status: "unchanged",
      ...stagedRow,
      ...pushRow(isRow(sent.body) ? sent.body.appStoreConnect : null),
    };
  }

  if (!approvalId && sent.code === "APPROVAL_REQUIRED") {
    const scope = { store, listingDigest: listingDigest(sentPatch) };
    const asked =
      isRow(sent.body) && isRow((sent.body as Row).approvalRequest)
        ? ((sent.body as Row).approvalRequest as Row)
        : {};

    if (
      text(asked.fingerprint) !== actionFingerprint(STORE_LISTING_ACTION, scope)
    ) {
      const mismatch = retried ?? digestMismatchOf(sent.body, patch);
      if (!retried && mismatch.deferred.length) return subsetRetry(mismatch);

      return {
        store,
        status: "refused",
        code: "LISTING_DIGEST_MISMATCH",
        message: behindSentence(mismatch, Boolean(retried)),
        digest: mismatch.digest,
        trackUrl: pushUrl,
      };
    }

    if (versioned) return { store, status: "approval-wanted", digestPatch: sentPatch };

    return askListing(api, args, store, sentPatch, scope);
  }

  const lines = readLines(isRow(sent.body) ? sent.body.lines : null);

  if (versioned && approvalId && lines.length && LINE_REFUSALS.has(sent.code)) {
    return {
      store,
      status: sent.code === "APPROVAL_LINE_DENIED" ? "left-out" : "refused",
      code: sent.code,
      message: sent.message,
      lines,
    };
  }

  if (approvalId && !retried && sent.code === "APPROVAL_SCOPE_MISMATCH") {
    const mismatch = digestMismatchOf(sent.body, patch);
    if (mismatch.deferred.length) return subsetRetry(mismatch);
  }

  const answered = approvalRoundTrip({
    command: COMMAND,
    platformCode: sent.code,
    message: sent.message,
    approvalId,
    undone: "Nothing was written to the listing by this call.",
    api: args.api,
    value: { action: ACT, store, project: context.project },
    next: LISTING_NEXT,
    retryAfterSeconds: sent.retryAfterSeconds,
  });

  if (answered) return { out: answered };

  const platformWords = sent.code === "INVALID_LISTING" && isRow(sent.body) ? text(sent.body.message) : "";
  const over = sent.code === OVER_LIMIT_CODE ? platformOverLimitOf(store, sent.body, (isRow(sent.body) ? text(sent.body.message) : "") || sent.message) : null;

  return {
    store,
    status: sent.code === "OWNER_REQUIRED" ? "needs-owner" : "refused",
    code: sent.code,
    message: platformWords || sent.message,
    ...(sent.code === IMAGE_NOT_ON_LISTING ? { next: IMAGE_NOT_ON_LISTING_NEXT } : {}),
    ...(over ? { overLimit: overLimitRows([over]) } : {}),
  };
}

function refusedByStoreMd(store: ListingStore, local: LocalListing): Row {
  return {
    store,
    status: "refused",
    code: OVER_LIMIT_CODE,
    message: overLimitRefusalMessage(local.overLimit),
    overLimit: overLimitRows(local.overLimit),
    ...(linesNotFound(local).length ? { unread: linesNotFound(local) } : {}),
  };
}

function overLimitOfRow(row: Row): StoreMdOverLimit[] {
  return Array.isArray(row.overLimit) ? (row.overLimit as StoreMdOverLimit[]) : [];
}

/* @invariant A STORE THE OWNER'S FILE GOT WRONG IS A BAD REQUEST, AND A
 * SYNC THAT LANDED ON SOME STORES IS NOT A FAILURE. A refusal for a STORE.md
 * line over a store's limit (read here or by the platform) is answered as
 * E_BAD_REQUEST with the line, the heading, the length, the limit and the
 * one retry call for that store; E_PLATFORM is kept for a fault on the
 * platform's side. When other stores of the same call landed, the answer is
 * ok with status listing-partly-synced, lists what landed per store, and
 * the hint names the refused store's fix and the retry for it alone, so
 * the person never re-sends a listing that is already there (ledger 411).
 */
function refusalHint(row: Row, useBuild: string): string {
  const overs = overLimitOfRow(row);
  if (overs.length) return overLimitHint(overs, useBuild || undefined);
  if (text(row.next)) return text(row.next);

  return `${text(row.store)}: ${text(row.message) || text(row.code)}. Fix what it names, then call ${syncRetryCall(text(row.store), useBuild || undefined)}.`;
}

function landedPhrase(rows: Row[]): string {
  const said = rows.filter((row) => LANDED_STATUSES.has(text(row.status))).map((row) => `${text(row.store)} ${text(row.status) === "icon-stale" ? "unchanged" : text(row.status)}`);

  return said.length > 1 ? `${said.slice(0, -1).join(", ")} and ${said[said.length - 1]}` : said[0] ?? "";
}

/* @invariant SEVERAL LISTINGS THE PLATFORM ASKS AN OWNER FOR ARE ONE
 * APPROVAL, NOT ONE EACH. When more than one store of a sync answers
 * APPROVAL_REQUIRED for exactly the listing this server hashed, the asks are
 * gathered into one version grant: one "<store>:sync-listing" line per store
 * and that store's digest under listings, so the owner reads every change on
 * one page and each line writes only the words it was approved for. A store
 * whose digest the platform reads differently keeps its own path, and a
 * store that asked for nothing is written as before.
 */
async function mintListingVersion(
  api: ProjectApi,
  args: ListingArgs,
  stores: ListingStore[],
  sentPatches: Map<ListingStore, ListingDigestPatch>,
): Promise<Row> {
  const patches = stores.map((store) => [store, sentPatches.get(store)!] as const);
  const asking = JSON.parse(
    await requestApprovalAfterRefusal({
      command: COMMAND,
      action: VERSION_ACTION,
      scope: versionScopeFor(
        stores.map((store) => ({ store, act: ACT })),
        "",
        "",
        Object.fromEntries(patches.map(([store, patch]) => [store, listingDigest(patch)])),
      ),
      description: `Fill the ${stores.join(", ")} store listings from ${STORE_MD_FILENAME} and the built icons, under one approval with one line per store.`,
      token: api.token,
      api: args.api,
      refusedStatus: `${ACT}-refused`,
      body: { listings: Object.fromEntries(patches.map(([store, patch]) => [store, approvalBody(store, patch)])) },
      reason: "The platform asked a workspace owner to approve these listing changes before they are written; the approval page lists each store's change as the platform computed it, and the owner can leave a store out.",
      stateRead: 'extension_submit_check (action: "preflight")',
    }),
  ) as Row;
  const value = isRow(asking.value) ? asking.value : {};
  const error = isRow(asking.error) ? asking.error : {};
  const lines = readLines(value.lines);

  return text(value.approvalId)
    ? {
        status: "approval-required",
        approvalId: text(value.approvalId),
        approvalUrl: text(value.approvalUrl),
        ...(text(value.expiresAt) ? { expiresAt: text(value.expiresAt) } : {}),
        ...(lines.length ? { lines } : {}),
      }
    : {
        status: "refused",
        code: text(error.platformCode) || text(error.name),
        message: text(error.message),
      };
}

export async function syncListing(args: ListingArgs): Promise<string> {
  const asked = (
    Array.isArray(args.browsers) && args.browsers.length
      ? args.browsers
      : [text(args.store) || "chrome"]
  ).map((b) => text(b).toLowerCase());
  const unknown = asked.filter(
    (b) => !(LISTING_STORES as readonly string[]).includes(b),
  );

  if (unknown.length) {
    return badShipRequest(
      COMMAND,
      ACT,
      "ListingInputError",
      `${unknown.join(", ")} is not a store; use ${LISTING_STORES.join(", ")}. Nothing was sent.`,
    );
  }

  const versioned = asked.length > 1;
  const resumed = text(args.approvalId) ? mintedApproval(args.api, text(args.approvalId)) : null;

  if (text(args.approvalId) && versioned && resumed?.action !== VERSION_ACTION) {
    return badShipRequest(
      COMMAND,
      ACT,
      "ListingInputError",
      "That approval covers one store's listing, so pass one browser with its approvalId; an approval this server asked for several stores at once covers them all. Nothing was sent.",
    );
  }

  const projectPath = text(args.projectPath);

  if (!projectPath || !fs.existsSync(projectPath)) {
    return badShipRequest(
      COMMAND,
      ACT,
      "ListingInputError",
      `sync-listing needs projectPath, the extension project root that holds ${STORE_MD_FILENAME} and the built dist. Nothing was sent.`,
    );
  }

  const given = args.screenshots !== undefined ? readScreenshots(projectPath, args.screenshots, asked as ListingStore[]) : null;

  if (given && "problem" in given) {
    return badShipRequest(
      COMMAND,
      ACT,
      "ListingInputError",
      `${given.problem}. Nothing was sent.`,
    );
  }

  const shotsFor = new Map<ListingStore, StoreShots>();

  for (const store of asked as ListingStore[]) {
    if (given) {
      shotsFor.set(store, { screenshots: given.screenshots });
      continue;
    }

    const paths = listStoreScreenshots(projectPath, store);
    if (!paths.length) continue;

    const read = readScreenshots(projectPath, paths, [store]);

    if ("problem" in read) {
      return badShipRequest(
        COMMAND,
        ACT,
        "ListingInputError",
        `${read.problem}. Nothing was sent.`,
      );
    }

    shotsFor.set(store, { screenshots: read.screenshots, from: { folder: storeScreenshotsFolder(store), files: paths.map((file) => path.basename(file)) } });
  }

  for (const [store, shots] of shotsFor) {
    const refusal = screenshotRefusal(store, shots.screenshots);
    if (!refusal) continue;

      return envelope({
        ok: false,
        command: COMMAND,
        status: "bad-request",
        value: {
          action: ACT,
          screenshot: {
            store,
            ...(refusal.file ? { file: refusal.file, measured: refusal.measured } : {}),
            accepted: screenshotRule(store).shown,
          },
        },
        error: {
          code: "E_BAD_REQUEST",
          name: "ListingInputError",
          message: `${refusal.message}. Nothing was sent.`,
        },
        hint: `Capture them again with extension_screenshot store:"${store}", one call per view (it writes ${storeScreenshotsFolder(store)}/ at the store's size), and call sync-listing again with the same browsers and projectPath.`,
      });
  }

  const locals = new Map<ListingStore, LocalListing>();

  for (const store of asked as ListingStore[]) {
    const local = readLocalListing(projectPath, store, shotsFor.get(store)?.screenshots);

    if ("problem" in local) {
      return badShipRequest(
        COMMAND,
        ACT,
        "StoreMdMissing",
        `${local.problem} Nothing was sent.`,
      );
    }

    locals.set(store, local);
  }

  const opened = await openShipApi(COMMAND, args, {
    action: ACT,
    stores: asked,
  });
  if ("refused" in opened) return opened.refused;

  const api = opened.api;
  const builds = await platformBuildIcons(api, projectPath, text(args.useBuild));
  const chromeWebStoreMd = readChromeWebStoreMd(projectPath);

  if (text(args.useBuild) && !builds.build) {
    return badShipRequest(
      COMMAND,
      ACT,
      "ListingInputError",
      `${text(args.useBuild)} is not a completed platform build of this project${builds.unreadable ? ` (${builds.unreadable})` : ""}; extension_builds lists the shas. Nothing was sent.`,
    );
  }

  const stores: Row = {};
  const unreadBack: string[] = [];
  const readProblems: string[] = [];
  const said: string[] = [];
  const categoryRows: StoreCategoryRow[] = [];
  const iconAdvice: string[] = [];
  const screenshotsLine = [...locals.values()].map((local) => local.screenshotsLine).find(Boolean) ?? "";

  let plain = false;
  const stagedImages: Row[] = [];
  const sentPatches = new Map<ListingStore, ListingDigestPatch>();

  for (const [store, local] of locals) {
    if (local.overLimit.length) {
      stores[store] = refusedByStoreMd(store, local);
      continue;
    }

    if (store === "safari") await adoptAppRecordName(api, local);

    await adoptBuildIcon(builds, store, local);

    const padding = iconPaddingView(store, local.patch.icons);
    if (padding.iconPadding) iconAdvice.push(padding.iconPadding.say);

    const notFound = linesNotFound(local);
    const held = chromeWebStoreHeld(chromeWebStoreMd, store, notFound.map((row) => row.field));
    const unread = notFound.length ? { unread: notFound.map((row) => heldRow(row, held)) } : {};

    if (held.length) said.push(`For ${store}, ${chromeWebStoreHeldSentence(held, true)}`);

    if (!filledFields(local.patch).length) {
      stores[store] = { store, status: "nothing-to-sync", ...unread };
      continue;
    }

    if (local.borrowed) said.push(borrowedSentence(store, local.borrowed));

    const result = await syncOne(api, args, store, local.patch, undefined, versioned);
    if ("out" in result) return result.out as string;

    if (Array.isArray(result.staged) && result.staged.length) {
      stagedImages.push(...(result.staged as StagedImage[]).map((image) => ({ store, ...image })));
      said.push(stagedSentence(store, result.staged as StagedImage[]));
    }

    if (result.imagesDoor === "single-body" && (local.patch.screenshots?.length || local.patch.icons?.length)) deferWarning(IMAGES_DOOR_MISSING_WARNING);

    if (result.digestPatch) sentPatches.set(store, result.digestPatch as ListingDigestPatch);

    delete result.staged;
    delete result.imagesDoor;
    delete result.digestPatch;

    if (result.status === "approval-wanted") {
      stores[store] = result;
      continue;
    }

    if (local.iconStale && result.status === "unchanged") result.status = "icon-stale";
    if (local.iconStale) said.push(`For ${store}, ${local.iconMissing}.`);
    if (local.iconNote) said.push(local.iconNote);

    const done = DONE_STATUSES.has(text(result.status));
    const back = done ? await stillBlocking(api, store, args.waitSeconds) : null;
    const readBack = back?.readBack ?? null;
    const blocking = readBack?.blocking ?? null;

    if (done && readBack === null) {
      unreadBack.push(store);
      if (back?.problem) readProblems.push(back.problem);
    }

    const shots = shotsFor.get(store);
    const record = !shots && done ? { read: readBack !== null, screenshots: readBack?.screenshotsOnRecord ?? null } : null;
    if (shots?.from) said.push(`For ${store}, ${shots.screenshots.length} screenshot${shots.screenshots.length === 1 ? " was" : "s were"} read from ${shots.from.folder} (${shots.from.files.join(", ")}).`);

    const onRecord = record ? onRecordRow(record) : null;
    const paste = store === "chrome" && done ? chromeDashboardPaste(local, readBack?.dashboardUrl ?? null, record) : null;
    const sentImages = local.patch.screenshots?.length ?? 0;

    if (record && onRecord) said.push(onRecordSentence(store, record, readBack?.images ?? null));
    else if (readBack?.images && (sentImages || readBack.images.clears.length)) said.push(imagesSentence(store, sentImages, readBack.images));
    else if (store === "edge" && local.patch.icons && readBack?.images?.storeLogo) said.push(EDGE_STORE_LOGO_SENTENCE);

    if (paste) {
      if (result.status === "synced") result.status = "recorded";

      said.push(chromePasteSentence(paste));
    }

    delete result.privacyPage;

    const deferred = Array.isArray(result.deferred) ? (result.deferred as string[]) : [];
    const filled = filledFields(local.patch).filter((field) => !deferred.includes(field));

    if (deferred.length) {
      const kept = Object.keys(local.patch.listing).filter((field) => !deferred.includes(field)).length;
      said.push(deferredSentence(deferred, kept, result.status === "approval-required"));
    } else if (result.code === "LISTING_DIGEST_MISMATCH") said.push(text(result.message));

    if (Array.isArray(result.derived)) said.push(derivedSentence(result.derived as DerivedMark[]));
    else if (done && !text(args.approvalId) && !plain) {
      plain = true;
      said.push(PLAIN_LISTING_SENTENCE);
    }

    if (store === "firefox" && done) said.push(FIREFOX_METADATA_SENTENCE);
    if (local.categories) categoryRows.push({ store, read: local.categories });

    stores[store] = {
      ...result,
      filled,
      ...unread,
      ...(local.borrowed ? { borrowed: local.borrowed } : {}),
      ...(local.categories ? { categories: { sent: local.categories.categories, from: local.categories.from, ...(local.categories.mapped ? { mapped: local.categories.mapped } : {}) } } : {}),
      ...(local.patch.icons && local.icon ? { icon: local.icon } : {}),
      ...(local.iconMissing ? { iconMissing: local.iconMissing } : {}),
      ...(local.skipped.length ? { skipped: local.skipped } : {}),
      ...(onRecord ? { onRecord } : {}),
      ...(blocking ? { stillBlocking: blocking } : {}),
      ...(readBack?.images ? { images: readBack.images } : {}),
      ...(paste ? { pasteInDashboard: paste } : {}),
      ...(shots?.from ? { screenshotsFrom: shots.from } : {}),
    };
  }

  said.push(...categoriesSentences(categoryRows), ...iconAdvice);

  const wanted = (Object.values(stores) as Row[]).filter((row) => row.status === "approval-wanted");

  if (wanted.length) {
    const minted = await mintListingVersion(api, args, wanted.map((row) => text(row.store) as ListingStore), sentPatches);

    for (const row of wanted) stores[text(row.store)] = { ...row, ...minted };
  }

  const rows = Object.values(stores) as Row[];
  const lineRows = rows.flatMap((row) => (Array.isArray(row.lines) ? (row.lines as ApprovalLineRow[]) : []));
  if (lineRows.length) said.push(`Approval lines: ${linesSentence(lineRows)}.`);

  const push = rows
    .map((row) => (isRow(row.appStoreConnect) ? row.appStoreConnect : null))
    .find(Boolean);
  const pushState = push ? readPushState(push) : null;
  if (pushState) said.push(pushSentence(pushState, push?.resend === "refused" ? "refused" : "none"));

  const localIcons = builds.build || !builds.commit ? [] : rows.filter((row) => isRow(row.icon) && row.icon.from !== "build").map((row) => text(row.store));
  if (localIcons.length) said.push(`The ${localIcons.join(", ")} icon${localIcons.length === 1 ? "" : "s"} came from the local project, not a platform build: ${builds.missed}.`);

  const say = said.join(" ");
  const approvals = rows.filter((row) => row.status === "approval-required");
  const failed = rows.filter((row) => !SETTLED_STATUSES.has(text(row.status)));
  const landed = rows.filter((row) => LANDED_STATUSES.has(text(row.status)));
  const project = `${api.ref.workspace}/${api.ref.project}`;
  const value: Row = {
    action: ACT,
    project,
    stores,
    iconSource: builds.build ? { from: "build", build: builds.build, ...(builds.reason ? { reason: builds.reason } : {}) } : { from: "local", reason: builds.missed },
    storesPageUrl: consoleProjectUrl(
      api.ref,
      ConsoleProjectPage.stores,
      args.api,
    ),
    ...(screenshotsLine ? { screenshotsLine } : {}),
    ...(stagedImages.length ? { listing: { images: stagedImages, staged: stagedImages.length } } : {}),
    ...(lineRows.length ? { lines: lineRows } : {}),
    ...(say ? { sayToPerson: say } : {}),
  };
  const blockingLine = rows
    .filter(
      (row) =>
        Array.isArray(row.stillBlocking) &&
        (row.stillBlocking as unknown[]).length,
    )
    .map(
      (row) =>
        `${text(row.store)} still lacks ${(row.stillBlocking as string[]).join(", ")}`,
    )
    .join("; ");

  if (approvals.length) {
    const shared = new Set(approvals.map((row) => text(row.approvalId))).size === 1;
    const only = approvals.length === 1 || shared ? approvals[0]! : null;

    return envelope({
      ok: false,
      command: COMMAND,
      status: "approval-required",
      value: {
        ...value,
        ...(only
          ? {
              approvalId: only.approvalId,
              approvalUrl: only.approvalUrl,
              ...(only.expiresAt ? { expiresAt: only.expiresAt } : {}),
            }
          : {}),
      },
      error: {
        code: "E_APPROVAL_REQUIRED",
        name: "ApprovalRequired",
        message: `The platform asked a workspace owner to approve the listing change before it is written. Nothing was written for ${approvals.map((row) => text(row.store)).join(", ")}.`,
      },
      hint:
        shared && approvals.length > 1
          ? `Approve at ${text(only?.approvalUrl)}: one page lists the ${approvals.map((row) => text(row.store)).join(", ")} listings, one line per store, and the owner can uncheck a store. Then call extension_submit action:"sync-listing" again with the same browsers, projectPath and screenshots and approvalId ${text(only?.approvalId)}.`
          : `Approve at ${approvals.map((row) => `${text(row.approvalUrl)} (${text(row.store)})`).join(", ")}, then call extension_submit action:"sync-listing" again once per store with browsers:[<store>], the same projectPath and screenshots, and that store's approvalId.`,
    });
  }

  if (failed.length) {
    const useBuild = text(args.useBuild);
    const ownerFile = failed.every((row) => OWNER_FILE_CODES.has(text(row.code)));
    const message = failed.map((row) => `${text(row.store)}: ${text(row.message) || text(row.code)}`).join(" ");
    const fixes = failed.map((row) => refusalHint(row, useBuild)).join(" ");

    if (landed.length) {
      const done = landedPhrase(rows);

      return envelope({
        ok: true,
        command: COMMAND,
        status: "listing-partly-synced",
        value: {
          ...value,
          landed: landed.map((row) => text(row.store)),
          refused: failed.map((row) => ({ store: text(row.store), code: text(row.code), message: text(row.message), ...(overLimitOfRow(row).length ? { overLimit: row.overLimit } : {}) })),
        },
        warnings: [`${failed.map((row) => text(row.store)).join(", ")} refused: ${message}`],
        hint: `${done}; ${failed.map((row) => text(row.store)).join(", ")} refused and ${failed.length === 1 ? "was" : "were"} not written. ${fixes} ${landed.length === 1 ? "The store that landed needs" : "The stores that landed need"} no second call.${say ? ` ${say}` : ""}`,
      });
    }

    return envelope({
      ok: false,
      command: COMMAND,
      status: `${ACT}-refused`,
      value,
      error: {
        code: ownerFile ? "E_BAD_REQUEST" : "E_PLATFORM",
        name: ownerFile ? "ListingFieldRefused" : "ListingRefused",
        message,
      },
      hint: fixes || undefined,
    });
  }

  const synced = rows
    .filter((row) => row.status === "synced" || row.status === "recorded")
    .map((row) => text(row.store));
  const sentToStore = rows.some((row) => row.status === "synced" || ((row.status === "unchanged" || row.status === "icon-stale") && text(row.store) !== "chrome"));
  const onlyRecorded = rows.some((row) => text(row.store) === "chrome" && isRow(row.pasteInDashboard)) && !sentToStore;
  const recordedStatus = onlyRecorded ? "listing-recorded" : "listing-synced";
  const links = linksOf([
    ...trackLinks(
      COMMAND,
      { ...args, action: ACT } as Row,
      recordedStatus,
      value,
    ),
  ]);
  const recorded = unreadBack.length === 0;
  const outcome = recorded
    ? recordedOutcome(synced.length ? "synced" : "unchanged")
    : unrecordedOutcome(
        `the listing of ${unreadBack.join(", ")} could not be read back after the write${readProblems.length ? ` (${readProblems.join("; ")})` : ""}`,
      );
  const made = madeSentence(links);

  if (!recorded) {
    return envelope({
      ok: true,
      command: COMMAND,
      status: `${ACT}-dispatched`,
      value: { ...value, outcome, links },
      hint: `The platform accepted the listing change for ${synced.join(", ") || asked.join(", ")}, and its record could not be read back yet (${outcome.readProblem}); extension_submit_check action:"preflight" reads what each store carries and still needs.${say ? ` ${say}` : ""} ${made}`,
    });
  }

  return envelope({
    ok: true,
    command: COMMAND,
    status: recordedStatus,
    value: { ...value, outcome, links },
    hint: `${blockingLine ? `${blockingLine}. ` : ""}The listing on extension.dev now carries what ${STORE_MD_FILENAME} and the build cover, read back from the platform's record; extension_submit_check action:"preflight" reads what each store still needs.${say ? ` ${say}` : ""} ${made}`,
  });
}
