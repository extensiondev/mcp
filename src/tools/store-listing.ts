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

import { envelope } from "../lib/envelope";
import { consoleProjectUrl } from "../lib/registry";
import { projectApiReadFailure, projectApiSend, tokenRefusal, type ProjectApi } from "../lib/project-api";
import { actionFingerprint, requestApprovalAfterRefusal } from "../lib/approval-gate";
import { badShipRequest, isRow, openShipApi, text } from "../lib/ship-act";
import { STORE_MD_FILENAME } from "../lib/store-md";
import { LISTING_STORES, listingForStore, parseStoreMdListing, type ListingStore } from "../lib/store-md-listing";
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
  patch: ListingPatch;
  iconMissing?: string;
  skipped: string[];
}

export function readLocalListing(projectPath: string, store: ListingStore, screenshots?: ListingImage[]): LocalListing | { problem: string } {
  const file = path.join(projectPath, STORE_MD_FILENAME);
  let content: string;

  try {
    content = fs.readFileSync(file, "utf8");
  } catch {
    return { problem: `No ${STORE_MD_FILENAME} at ${file}. Create it with the listing copy first (the extension-dev skill's store-md reference has the shape).` };
  }

  const { listing, skipped } = listingForStore(parseStoreMdListing(content), store);
  const icon = iconFromDist(projectPath, store);
  const patch: ListingPatch = { listing };

  if ("icon" in icon) patch.icons = [icon.icon];
  if (screenshots?.length) patch.screenshots = screenshots;

  return { file, patch, skipped, ...("missing" in icon ? { iconMissing: icon.missing } : {}) };
}

const CHECK_COVERAGE: Array<{ test: RegExp; fields: string[]; label: string }> = [
  { test: /^listing\.title_present$/, fields: ["title"], label: "title" },
  { test: /description_present$|summary_present$/, fields: ["shortDescription", "fullDescription"], label: "description" },
  { test: /license_present$/, fields: ["license"], label: "license" },
  { test: /categories_present$/, fields: ["categories"], label: "category" },
  { test: /support_email_present$/, fields: ["supportEmail"], label: "support email" },
  { test: /search_terms_present$/, fields: ["searchTerms"], label: "search terms" },
  { test: /privacy_policy_present$/, fields: ["privacyPolicyUrl"], label: "privacy policy URL" },
];

export function storeMdAdvisory(local: LocalListing, checks: Row[]): Row {
  const covers: string[] = [];
  const notCovered: string[] = [];
  const listing = local.patch.listing as Row;

  for (const check of checks) {
    const id = text(check.id);

    if (/icon_present$/.test(id)) {
      const icon = local.patch.icons?.[0];

      if (icon) covers.push(`icon 128 px found in ${icon.source}, not yet in the listing`);
      else notCovered.push(`icon: ${local.iconMissing ?? "no 128 px icon in the built dist"}`);

      continue;
    }

    if (/screenshots_present$/.test(id)) {
      notCovered.push("screenshots: STORE.md does not carry them; pass screenshots (PNG paths inside projectPath, for example from extension_screenshot) to sync-listing");
      continue;
    }

    const rule = CHECK_COVERAGE.find((entry) => entry.test.test(id));
    if (!rule) continue;

    if (rule.fields.some((field) => listing[field] !== undefined)) covers.push(`${rule.label} found in ${STORE_MD_FILENAME}, not yet in the console listing`);
    else notCovered.push(`${rule.label}: not in ${STORE_MD_FILENAME}`);
  }

  return { file: local.file, covers, notCovered, ...(local.skipped.length ? { skipped: local.skipped } : {}) };
}

function filledFields(patch: ListingPatch): string[] {
  return [...Object.keys(patch.listing), ...(patch.icons ? ["icons"] : []), ...(patch.screenshots ? ["screenshots"] : [])];
}

async function stillBlocking(api: ProjectApi, store: string): Promise<string[] | null> {
  const read = await projectApiSend<Row>(api, "POST", `stores/${store}/submissions/preflight`, {});
  if (!read.ok) return null;

  const checks = (Array.isArray(read.json.checks) ? read.json.checks : []).filter(isRow);

  return checks
    .filter((check) => text(check.id).startsWith("listing.") && (text(check.status) === "fail" || text(check.status) === "warn"))
    .map((check) => `${text(check.id)}${text(check.status) === "warn" ? " (warning)" : ""}`);
}

const APPROVAL_NEXT: Record<string, string> = {
  APPROVAL_PENDING: "Approve it at its URL, then call again with the same arguments and approvalId.",
  APPROVAL_DENIED: "It was denied, so the listing was not changed.",
  APPROVAL_EXPIRED: "Request a fresh approval by calling again with no approvalId.",
  APPROVAL_NOT_FOUND: "Request a fresh approval by calling again with no approvalId.",
  APPROVAL_SCOPE_MISMATCH: "STORE.md, the built icon or the screenshots changed since it was approved, or it is another store's approval; call again with no approvalId for a fresh one.",
  APPROVAL_CONSUMED: "The call that used it may already have written the listing; run preflight first, and request a fresh approval only if the listing is not there.",
};

async function syncOne(api: ProjectApi, args: ListingArgs, store: ListingStore, patch: ListingPatch): Promise<Row | { out: string }> {
  const approvalId = text(args.approvalId);
  const sent = await projectApiSend<Row>(api, "PUT", `stores/${store}/listing`, { ...writeBody(patch), ...(approvalId ? { approvalId } : {}) });

  if (sent.ok) return { store, status: "synced", changes: Array.isArray(sent.json.changes) ? sent.json.changes : [] };

  const context = { workspace: api.ref.workspace, project: `${api.ref.workspace}/${api.ref.project}` };

  if (sent.held || sent.status === 0 || tokenRefusal(sent.code, context)) {
    return { out: projectApiReadFailure(COMMAND, sent, { api: args.api, name: "Listing", value: { action: ACT, store }, context }) };
  }

  if (sent.code === "NO_CHANGE") return { store, status: "unchanged" };

  if (!approvalId && sent.code === "APPROVAL_REQUIRED") {
    const scope = { store, listingDigest: listingDigest(patch) };
    const asked = isRow(sent.body) && isRow((sent.body as Row).approvalRequest) ? ((sent.body as Row).approvalRequest as Row) : {};

    if (text(asked.fingerprint) !== actionFingerprint(STORE_LISTING_ACTION, scope)) {
      return { store, status: "refused", code: "LISTING_DIGEST_MISMATCH", message: "The platform hashes this listing differently from this server, so an approval of it could never be used. No approval was requested." };
    }

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
        reason: "A store listing is what reviewers and users read, so a workspace owner approves this exact change first; the approval page shows it as the platform computed it.",
        stateRead: 'extension_submit (action: "preflight")',
      }),
    ) as Row;
    const value = isRow(asking.value) ? asking.value : {};
    const error = isRow(asking.error) ? asking.error : {};

    return text(value.approvalId)
      ? { store, status: "approval-required", approvalId: text(value.approvalId), approvalUrl: text(value.approvalUrl), changes: Array.isArray(value.changes) ? value.changes : [] }
      : { store, status: "refused", code: text(error.platformCode) || text(error.name), message: text(error.message) };
  }

  if (APPROVAL_NEXT[sent.code]) return { store, status: "approval-rejected", code: sent.code, message: sent.message, next: APPROVAL_NEXT[sent.code] };

  return { store, status: sent.code === "OWNER_REQUIRED" ? "needs-owner" : "refused", code: sent.code, message: sent.message };
}

export async function syncListing(args: ListingArgs): Promise<string> {
  const asked = (Array.isArray(args.browsers) && args.browsers.length ? args.browsers : [text(args.store) || "chrome"]).map((b) => text(b).toLowerCase());
  const unknown = asked.filter((b) => !(LISTING_STORES as readonly string[]).includes(b));

  if (unknown.length) return badShipRequest(COMMAND, ACT, "ListingInputError", `${unknown.join(", ")} is not a store; use ${LISTING_STORES.join(", ")}. Nothing was sent.`);
  if (text(args.approvalId) && asked.length > 1) return badShipRequest(COMMAND, ACT, "ListingInputError", "Each store's listing has its own approval, so pass one browser with its approvalId. Nothing was sent.");

  const projectPath = text(args.projectPath);
  if (!projectPath || !fs.existsSync(projectPath)) return badShipRequest(COMMAND, ACT, "ListingInputError", `sync-listing needs projectPath, the extension project root that holds ${STORE_MD_FILENAME} and the built dist. Nothing was sent.`);

  let screenshots: ListingImage[] | undefined;

  if (args.screenshots !== undefined) {
    const read = readScreenshots(projectPath, args.screenshots);
    if ("problem" in read) return badShipRequest(COMMAND, ACT, "ListingInputError", `${read.problem}. Nothing was sent.`);

    screenshots = read.screenshots;
  }

  const locals = new Map<ListingStore, LocalListing>();

  for (const store of asked as ListingStore[]) {
    const local = readLocalListing(projectPath, store, screenshots);
    if ("problem" in local) return badShipRequest(COMMAND, ACT, "StoreMdMissing", `${local.problem} Nothing was sent.`);

    locals.set(store, local);
  }

  const opened = await openShipApi(COMMAND, args, { action: ACT, stores: asked });
  if ("refused" in opened) return opened.refused;

  const api = opened.api;
  const stores: Row = {};

  for (const [store, local] of locals) {
    if (!filledFields(local.patch).length) {
      stores[store] = { store, status: "nothing-to-sync" };
      continue;
    }

    const result = await syncOne(api, args, store, local.patch);
    if ("out" in result) return result.out as string;

    const done = result.status === "synced" || result.status === "unchanged";
    const blocking = done ? await stillBlocking(api, store) : null;

    stores[store] = {
      ...result,
      filled: filledFields(local.patch),
      ...(local.iconMissing ? { iconMissing: local.iconMissing } : {}),
      ...(local.skipped.length ? { skipped: local.skipped } : {}),
      ...(blocking ? { stillBlocking: blocking } : {}),
    };
  }

  const rows = Object.values(stores) as Row[];
  const approvals = rows.filter((row) => row.status === "approval-required");
  const failed = rows.filter((row) => !["synced", "unchanged", "nothing-to-sync", "approval-required"].includes(text(row.status)));
  const project = `${api.ref.workspace}/${api.ref.project}`;
  const value: Row = { action: ACT, project, stores, storesPageUrl: consoleProjectUrl(api.ref, ConsoleProjectPage.stores, args.api) };
  const blockingLine = rows
    .filter((row) => Array.isArray(row.stillBlocking) && (row.stillBlocking as unknown[]).length)
    .map((row) => `${text(row.store)} still lacks ${(row.stillBlocking as string[]).join(", ")}`)
    .join("; ");

  if (approvals.length) {
    const only = approvals.length === 1 ? approvals[0]! : null;

    return envelope({
      ok: false,
      command: COMMAND,
      status: "approval-required",
      value: { ...value, ...(only ? { approvalId: only.approvalId, approvalUrl: only.approvalUrl } : {}) },
      error: { code: "E_APPROVAL_REQUIRED", name: "ApprovalRequired", message: `A workspace owner approves each store listing change before it is written. Nothing was written for ${approvals.map((row) => text(row.store)).join(", ")}.` },
      hint: `Approve at ${approvals.map((row) => `${text(row.approvalUrl)} (${text(row.store)})`).join(", ")}, then call extension_submit action:"sync-listing" again once per store with browsers:[<store>], the same projectPath and screenshots, and that store's approvalId.`,
    });
  }

  if (failed.length) {
    return envelope({
      ok: false,
      command: COMMAND,
      status: `${ACT}-refused`,
      value,
      error: { code: "E_PLATFORM", name: "ListingRefused", message: failed.map((row) => `${text(row.store)}: ${text(row.message) || text(row.code)}`).join(" ") },
      hint: failed.map((row) => text(row.next)).filter(Boolean).join(" ") || undefined,
    });
  }

  return envelope({
    ok: true,
    command: COMMAND,
    status: "listing-synced",
    value,
    hint: `${blockingLine ? `${blockingLine}. ` : ""}The listing on extension.dev now carries what ${STORE_MD_FILENAME} and the build cover; extension_submit action:"preflight" reads what each store still needs, and a submission sends it.`,
  });
}
