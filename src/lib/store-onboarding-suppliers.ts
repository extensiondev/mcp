// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { isRow, text } from "./row";
import { NEVER_PREFILLED, supplyOf } from "./store-bring-list";
import { WORKSPACE_RECONNECT_STATE } from "./store-connection";

type Row = Record<string, unknown>;

export type Supplier = "build" | "agent-drafts" | "person-decides";

export const SUPPLIERS: readonly Supplier[] = ["build", "agent-drafts", "person-decides"];

export const CREDENTIAL_ROWS: Record<string, string> = {
  chrome: "chrome.store_connection",
  edge: "edge.partner_center_credentials",
  firefox: "firefox.api_credentials",
  safari: "safari.api_key",
};

const BUILD = [
  "chrome.title",
  "chrome.summary",
  "chrome.store_icon",
  "edge.package_contents",
  "edge.name",
  "edge.short_description",
  "firefox.icon",
  "firefox.add_on_id",
  "firefox.source_archive",
  "safari.bundle_identifiers",
  "safari.distribution_certificates",
  "safari.provisioning_profiles",
  "safari.app_icon",
  "chrome.browser_builds",
  "edge.browser_builds",
  "firefox.browser_builds",
  "safari.browser_builds",
  "safari.bundle_id_registered",
];

const AGENT_DRAFTS = [
  "chrome.description",
  "chrome.language",
  "chrome.single_purpose",
  "chrome.permission_justifications",
  "edge.single_purpose",
  "edge.permission_justifications",
  "chrome.test_instructions",
  "chrome.promo_tile_small",
  "chrome.promo_tile_marquee",
  "edge.description",
  "edge.search_terms",
  "edge.certification_notes",
  "edge.promo_tile_small",
  "edge.promo_tile_large",
  "firefox.reviewer_notes",
  "firefox.name",
  "firefox.summary",
  "firefox.description",
  "firefox.release_notes",
  "safari.name",
  "safari.description",
  "safari.reviewer_notes",
  "safari.subtitle",
  "safari.keywords",
  "safari.whats_new",
];

const PERSON_DECIDES = [
  ...Object.values(CREDENTIAL_ROWS),
  "chrome.item",
  "chrome.category",
  "chrome.visibility",
  "chrome.privacy_policy_url",
  "chrome.homepage_url",
  "chrome.promo_video",
  "edge.product",
  "edge.first_submission",
  "edge.category",
  "edge.support_contact",
  "edge.privacy_policy_url",
  "edge.website_url",
  "edge.promo_video",
  "firefox.distribution_channel",
  "firefox.categories",
  "firefox.license",
  "firefox.support_email",
  "firefox.support_website",
  "firefox.privacy_policy",
  "safari.app_record",
  "safari.primary_category",
  "safari.support_url",
  "safari.privacy_policy_url",
  "safari.review_contact_name",
  "safari.review_contact_email",
  "safari.review_contact_phone",
  "safari.pricing_availability",
  "safari.marketing_url",
  "safari.copyright",
];

const BY_ID: Record<string, Supplier> = Object.fromEntries([
  ...BUILD.map((id) => [id, "build"] as const),
  ...AGENT_DRAFTS.map((id) => [id, "agent-drafts"] as const),
  ...PERSON_DECIDES.map((id) => [id, "person-decides"] as const),
]);

export function supplierOf(row: Row): Supplier {
  const id = text(row.id);
  if (NEVER_PREFILLED.has(id)) return "person-decides";
  if (supplyOf({ id }) === "from your build") return "build";

  const known = BY_ID[id];
  if (known) return known;

  if (text(row.satisfiedBy).startsWith("file:")) return "build";

  return "person-decides";
}

export interface SupplierGroup {
  required: string[];
  optional: string[];
}

export type ReadinessGroups = Record<Supplier, SupplierGroup>;

export interface ReadinessRows {
  groups: ReadinessGroups;
  onFile: number;
  notOnFile: number;
  requiredNotOnFile: number;
  statusById: Record<string, string>;
}

export function requirementRowsOf(view: unknown): Row[] {
  if (!isRow(view) || !isRow(view.requirements) || !Array.isArray(view.requirements.items)) return [];

  return view.requirements.items.filter(isRow);
}

export function connectionPasses(view: unknown): boolean {
  const connection = isRow(view) && isRow(view.connection) ? view.connection : null;

  return Boolean(connection && text(connection.kind) && connection.healthy === true && text(connection.state) !== WORKSPACE_RECONNECT_STATE);
}

const CREDENTIAL_CHECK = "store.credentials_present";

export function credentialsRefused(view: unknown): boolean {
  if (!isRow(view)) return false;

  const connection = isRow(view.connection) ? view.connection : null;
  if (connection && connection.healthy === false) return true;

  const failing = Array.isArray(view.failing) ? view.failing.filter(isRow) : [];

  return failing.some((check) => text(check.id) === CREDENTIAL_CHECK);
}

function credentialStatus(view: unknown, row: Row, passing: boolean): string {
  if (passing) return "have";

  const connection = isRow(view) && isRow(view.connection) ? view.connection : null;

  if (connection && connection.healthy === false) return "missing";

  const status = text(row.status) || "unknown";

  return status === "have" && credentialsRefused(view) ? "missing" : status;
}

export function readinessRowsOf(stores: Row, asked: readonly string[]): ReadinessRows {
  const groups = Object.fromEntries(SUPPLIERS.map((supplier) => [supplier, { required: [], optional: [] }])) as unknown as ReadinessGroups;
  const statusById: Record<string, string> = {};
  let onFile = 0;
  let requiredNotOnFile = 0;

  for (const store of asked) {
    const passing = connectionPasses(stores[store]);

    for (const row of requirementRowsOf(stores[store])) {
      const id = text(row.id);
      const status = id === CREDENTIAL_ROWS[store] ? credentialStatus(stores[store], row, passing) : text(row.status) || "unknown";
      statusById[id] = status;

      if (status === "have") {
        onFile += 1;
        continue;
      }

      const group = groups[supplierOf(row)];

      if (row.required === true) {
        group.required.push(id);
        requiredNotOnFile += 1;
      } else group.optional.push(id);
    }
  }

  const notOnFile = SUPPLIERS.reduce((sum, supplier) => sum + groups[supplier].required.length + groups[supplier].optional.length, 0);

  return { groups, onFile, notOnFile, requiredNotOnFile, statusById };
}

export function connectedStoresOf(rows: ReadinessRows, asked: readonly string[]): { connected: string[]; notConnected: string[]; unread: string[] } {
  const connected: string[] = [];
  const notConnected: string[] = [];
  const unread: string[] = [];

  for (const store of asked) {
    const status = rows.statusById[CREDENTIAL_ROWS[store] ?? ""];

    if (status === "have") connected.push(store);
    else if (status) notConnected.push(store);
    else unread.push(store);
  }

  return { connected, notConnected, unread };
}
