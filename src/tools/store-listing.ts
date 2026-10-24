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
  linksOf,
  madeSentence,
  recordedOutcome,
  trackLinks,
  unrecordedOutcome,
} from "../lib/act-outcome";
import { envelope } from "../lib/envelope";
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
} from "../lib/approval-gate";
import { approvalRoundTrip } from "../lib/approval-outcome";
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
import { STORE_MD_FILENAME } from "../lib/store-md";
import { linesNotFound, storeMdLineOf, storeMdSectionOf } from "../lib/store-md-fields";
import {
  LISTING_SECTION,
  LISTING_STORES,
  LISTING_TEXT_LIMITS,
  PRIVACY_SECTION,
  derivedListingFields,
  listingForStore,
  parseStoreMdListing,
  type ListingField,
  type ListingStore,
  type StoreMdPrivacy,
  type StoreMdScreenshots,
  type UnreadLine,
} from "../lib/store-md-listing";
import {
  STORE_LISTING_ACTION,
  approvalBody,
  iconFromDist,
  listingDigest,
  readScreenshots,
  writeBody,
  type ListingImage,
  type ListingPatch,
} from "../lib/store-listing-media";

const COMMAND = "extension_submit";
const ACT = "sync-listing";

type Row = Record<string, unknown>;

export interface ListingArgs {
  browsers?: string[];
  store?: string;
  projectPath?: string;
  screenshots?: unknown;
  approvalId?: string;
  project?: string;
  api?: string;
}

export interface LocalListing {
  file: string;
  store: ListingStore;
  patch: ListingPatch;
  iconMissing?: string;
  skipped: string[];
  unread: Partial<Record<ListingField, UnreadLine>>;
  lines: Partial<Record<ListingField, string>>;
  screenshotsLine?: string;
  screenshotsUnread?: UnreadLine;
  privacy: StoreMdPrivacy;
}

export const SCREENSHOTS_SHAPE =
  "`- Screenshots:` with one PNG path per line below it (`1. store/screenshot-1.png`)";

const privacyCoveredFact = (url: string): string =>
  `privacy policy URL found in ${STORE_MD_FILENAME} (${url}), not yet in the console listing`;

export const privacyMissingLine = (): string =>
  `privacy policy URL: ${STORE_MD_FILENAME} has no \`${storeMdLineOf("privacyPolicyUrl")}\` under \`${PRIVACY_SECTION}\``;

export const PLAIN_LISTING_SENTENCE =
  "This listing sync was a plain act under the owner's own token (ruling 143), since every value is the owner's own STORE.md line; only a value the platform derives takes a workspace owner's approval.";

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
    return {
      problem: `No ${STORE_MD_FILENAME} at ${file}. Create it with the listing copy first (the extension-dev skill's store-md reference has the shape).`,
    };
  }

  const parsed = parseStoreMdListing(content);
  const { listing, skipped, unread } = listingForStore(parsed, store);
  const icon = iconFromDist(projectPath, store);
  const patch: ListingPatch = { listing };
  const fromStoreMd = screenshots?.length ? null : screenshotsFromStoreMd(projectPath, parsed.screenshots);

  if ("icon" in icon) patch.icons = [icon.icon];
  if (screenshots?.length) patch.screenshots = screenshots;
  else if (fromStoreMd && "screenshots" in fromStoreMd) patch.screenshots = fromStoreMd.screenshots;

  return {
    file,
    store,
    patch,
    skipped,
    unread,
    lines: parsed.lines,
    privacy: parsed.privacy,
    ...(parsed.screenshots ? { screenshotsLine: `- ${parsed.screenshots.line}:` } : {}),
    ...(fromStoreMd && "unread" in fromStoreMd ? { screenshotsUnread: fromStoreMd.unread } : {}),
    ...("missing" in icon ? { iconMissing: icon.missing } : {}),
  };
}

/* @invariant THE SCREENSHOTS LINE FEEDS THE SYNC THE WAY THE ARGUMENT DOES.
 * Files named under "- Screenshots:" in STORE.md are read from the project
 * root exactly as a screenshots argument would be, so the walk's listing no
 * longer depends on the caller repeating the paths. An explicit argument
 * still wins. A line whose files cannot be read, or that names no PNG file,
 * is reported as the line it is with the shape the reader takes, so the
 * preflight's storeMd block and the requirements list name the same miss.
 */
function screenshotsFromStoreMd(
  projectPath: string,
  parsed: StoreMdScreenshots | undefined,
): { screenshots: ListingImage[] } | { unread: UnreadLine } | null {
  if (!parsed) return null;

  const line = `- ${parsed.line}:`;

  if (!parsed.files.length) {
    return { unread: { line, reason: "names no .png file" } };
  }

  const read = readScreenshots(projectPath, parsed.files);

  return "problem" in read ? { unread: { line, reason: read.problem } } : read;
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
      "`- Category: <name>` for every store, or `- Category: <name> (Chrome), <name> (Firefox)` per store",
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

function onListingLines(listing: Row, settled: Row[]): string[] {
  const lines: string[] = [];

  for (const check of settled) {
    const id = text(check.id);

    if (/privacy_policy_present$/.test(id)) {
      if (listing.privacyPolicyUrl !== undefined) {
        lines.push(
          `privacy policy URL: ${STORE_MD_FILENAME} carries ${text(listing.privacyPolicyUrl)}, already on the listing`,
        );
      }

      continue;
    }

    const rule = CHECK_COVERAGE.find((entry) => entry.test.test(id));
    if (!rule) continue;

    if (rule.fields.some((field) => listing[field] !== undefined)) {
      lines.push(
        `${rule.label}: ${STORE_MD_FILENAME} carries it, already on the listing`,
      );
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

    if (shots?.length) {
      return {
        covered: `screenshots: ${shots.length} ${local.screenshotsLine ? `listed on the \`${local.screenshotsLine}\` line of ${STORE_MD_FILENAME}` : "passed to sync-listing"}, not yet in the listing`,
      };
    }

    if (local.screenshotsUnread) {
      return {
        unread: `screenshots: the \`${local.screenshotsUnread.line}\` line in ${STORE_MD_FILENAME} ${local.screenshotsUnread.reason}; the reader takes ${SCREENSHOTS_SHAPE}`,
      };
    }

    return {
      missing: `screenshots: ${STORE_MD_FILENAME} has no \`${storeMdLineOf("screenshots")}\` under \`${LISTING_SECTION}\`; list the files there, one PNG path per line, or pass screenshots (PNG paths inside projectPath, for example from extension_screenshot) to sync-listing`,
    };
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
): Row {
  const covers: string[] = [];
  const notCovered: string[] = [];
  const listing = local.patch.listing as Row;
  const onListing = onListingLines(listing, settled);

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
    ...(local.skipped.length ? { skipped: local.skipped } : {}),
  };
}

function filledFields(patch: ListingPatch): string[] {
  return [
    ...Object.keys(patch.listing),
    ...(patch.icons ? ["icons"] : []),
    ...(patch.screenshots ? ["screenshots"] : []),
  ];
}

async function stillBlocking(
  api: ProjectApi,
  store: string,
): Promise<string[] | null> {
  const read = await projectApiSend<Row>(
    api,
    "POST",
    `stores/${store}/submissions/preflight`,
    {},
  );
  if (!read.ok) return null;

  const checks = (
    Array.isArray(read.json.checks) ? read.json.checks : []
  ).filter(isRow);

  return checks
    .filter(
      (check) =>
        text(check.id).startsWith("listing.") &&
        (text(check.status) === "fail" || text(check.status) === "warn"),
    )
    .map(
      (check) =>
        `${text(check.id)}${text(check.status) === "warn" ? " (warning)" : ""}`,
    );
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

const chromeListingLine = (synced: string[]): string =>
  synced.includes("chrome")
    ? " Chrome's own listing fields, the privacy policy URL included, cannot be written through Google's API: paste them once in the item's dashboard, and extension.dev keeps this copy as the record."
    : "";

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
async function syncOne(
  api: ProjectApi,
  args: ListingArgs,
  store: ListingStore,
  patch: ListingPatch,
  retried?: DigestMismatch,
): Promise<Row | { out: string }> {
  const approvalId = text(args.approvalId);
  const { sent, resend } = await sendListing(api, store, {
    ...writeBody(patch),
    ...(approvalId ? { approvalId } : {}),
  });
  const pushUrl = consoleProjectUrl(
    api.ref,
    ConsoleProjectPage.submissionsStore(store),
    args.api,
  );

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

    return {
      store,
      status: "synced",
      changes: Array.isArray(sent.json.changes) ? sent.json.changes : [],
      ...(derived.length ? { derived } : {}),
      ...pushRow(sent.json.appStoreConnect),
    };
  }

  const context = {
    workspace: api.ref.workspace,
    project: `${api.ref.workspace}/${api.ref.project}`,
  };

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
      ...pushRow(isRow(sent.body) ? sent.body.appStoreConnect : null),
    };
  }

  if (!approvalId && sent.code === "APPROVAL_REQUIRED") {
    const scope = { store, listingDigest: listingDigest(patch) };
    const asked =
      isRow(sent.body) && isRow((sent.body as Row).approvalRequest)
        ? ((sent.body as Row).approvalRequest as Row)
        : {};

    if (
      text(asked.fingerprint) !== actionFingerprint(STORE_LISTING_ACTION, scope)
    ) {
      const mismatch = retried ?? digestMismatchOf(store, sent.body, patch);
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
        stateRead: 'extension_submit (action: "preflight")',
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

  if (approvalId && !retried && sent.code === "APPROVAL_SCOPE_MISMATCH") {
    const mismatch = digestMismatchOf(store, sent.body, patch);
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

  return {
    store,
    status: sent.code === "OWNER_REQUIRED" ? "needs-owner" : "refused",
    code: sent.code,
    message: sent.message,
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

  if (text(args.approvalId) && asked.length > 1) {
    return badShipRequest(
      COMMAND,
      ACT,
      "ListingInputError",
      "Each store's listing has its own approval, so pass one browser with its approvalId. Nothing was sent.",
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

  let screenshots: ListingImage[] | undefined;

  if (args.screenshots !== undefined) {
    const read = readScreenshots(projectPath, args.screenshots);

    if ("problem" in read) {
      return badShipRequest(
        COMMAND,
        ACT,
        "ListingInputError",
        `${read.problem}. Nothing was sent.`,
      );
    }

    screenshots = read.screenshots;
  }

  const locals = new Map<ListingStore, LocalListing>();

  for (const store of asked as ListingStore[]) {
    const local = readLocalListing(projectPath, store, screenshots);

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
  const stores: Row = {};
  const unreadBack: string[] = [];
  const said: string[] = [];

  let plain = false;

  for (const [store, local] of locals) {
    if (store === "safari") await adoptAppRecordName(api, local);

    const notFound = linesNotFound(local);
    const unread = notFound.length ? { unread: notFound } : {};

    if (!filledFields(local.patch).length) {
      stores[store] = { store, status: "nothing-to-sync", ...unread };
      continue;
    }

    const result = await syncOne(api, args, store, local.patch);
    if ("out" in result) return result.out as string;

    const done = result.status === "synced" || result.status === "unchanged";
    const blocking = done ? await stillBlocking(api, store) : null;
    if (done && blocking === null) unreadBack.push(store);

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

    stores[store] = {
      ...result,
      filled,
      ...unread,
      ...(local.iconMissing ? { iconMissing: local.iconMissing } : {}),
      ...(local.skipped.length ? { skipped: local.skipped } : {}),
      ...(blocking ? { stillBlocking: blocking } : {}),
    };
  }

  const rows = Object.values(stores) as Row[];
  const push = rows
    .map((row) => (isRow(row.appStoreConnect) ? row.appStoreConnect : null))
    .find(Boolean);
  const pushState = push ? readPushState(push) : null;
  if (pushState) said.push(pushSentence(pushState, push?.resend === "refused" ? "refused" : "none"));

  const say = said.join(" ");
  const approvals = rows.filter((row) => row.status === "approval-required");
  const failed = rows.filter(
    (row) =>
      !["synced", "unchanged", "nothing-to-sync", "approval-required"].includes(
        text(row.status),
      ),
  );
  const project = `${api.ref.workspace}/${api.ref.project}`;
  const value: Row = {
    action: ACT,
    project,
    stores,
    storesPageUrl: consoleProjectUrl(
      api.ref,
      ConsoleProjectPage.stores,
      args.api,
    ),
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
    const only = approvals.length === 1 ? approvals[0]! : null;

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
      hint: `Approve at ${approvals.map((row) => `${text(row.approvalUrl)} (${text(row.store)})`).join(", ")}, then call extension_submit action:"sync-listing" again once per store with browsers:[<store>], the same projectPath and screenshots, and that store's approvalId.`,
    });
  }

  if (failed.length) {
    return envelope({
      ok: false,
      command: COMMAND,
      status: `${ACT}-refused`,
      value,
      error: {
        code: "E_PLATFORM",
        name: "ListingRefused",
        message: failed
          .map(
            (row) =>
              `${text(row.store)}: ${text(row.message) || text(row.code)}`,
          )
          .join(" "),
      },
      hint:
        failed
          .map((row) => text(row.next))
          .filter(Boolean)
          .join(" ") || undefined,
    });
  }

  const synced = rows
    .filter((row) => row.status === "synced")
    .map((row) => text(row.store));
  const links = linksOf([
    ...trackLinks(
      COMMAND,
      { ...args, action: ACT } as Row,
      "listing-synced",
      value,
    ),
  ]);
  const recorded = unreadBack.length === 0;
  const outcome = recorded
    ? recordedOutcome(synced.length ? "synced" : "unchanged")
    : unrecordedOutcome(
        `the listing of ${unreadBack.join(", ")} could not be read back after the write`,
      );
  const made = madeSentence(links);

  if (!recorded) {
    return envelope({
      ok: true,
      command: COMMAND,
      status: `${ACT}-dispatched`,
      value: { ...value, outcome, links },
      hint: `The platform accepted the listing change for ${synced.join(", ") || asked.join(", ")}, and its record could not be read back yet (${outcome.readProblem}); extension_submit action:"preflight" reads what each store carries and still needs.${say ? ` ${say}` : ""} ${made}`,
    });
  }

  return envelope({
    ok: true,
    command: COMMAND,
    status: "listing-synced",
    value: { ...value, outcome, links },
    hint: `${blockingLine ? `${blockingLine}. ` : ""}The listing on extension.dev now carries what ${STORE_MD_FILENAME} and the build cover, read back from the platform's record; extension_submit action:"preflight" reads what each store still needs.${chromeListingLine(synced)}${say ? ` ${say}` : ""} ${made}`,
  });
}
