// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { STORE_MD_FILENAME } from "./store-md";
import { isListingStoreName, STORE_SCREENSHOT_SPECS, sizeLabel } from "./store-screenshot-sizes";

import type { RequirementRow, RequirementsView } from "./store-requirements";

export type Supply = "from your build" | "you supply";

export interface BringRow {
  id: string;
  label: string;
  required: boolean;
  status: RequirementRow["status"];
  supply: Supply;
  format: string;
  clearedBy: string;
  docs?: string;
  decideOnce?: true;
  neverPrefilled?: true;
}

export interface BringList {
  store: string;
  readyForReview: boolean;
  rows: BringRow[];
  say: string;
}

const STORE_NAMES: Record<string, string> = {
  chrome: "the Chrome Web Store",
  edge: "Edge Add-ons",
  firefox: "Firefox AMO",
  safari: "the App Store",
};

const DERIVED_SUFFIXES = ["screenshots", "store_icon", "icon", "app_icon", "store_logo", "source_archive", "package_contents"];

const DECIDE_ONCE = new Set(["firefox.add_on_id", "safari.bundle_identifiers", "safari.name", "safari.app_record", "chrome.item", "edge.product"]);

const NEVER_PREFILLED = new Set([
  "chrome.data_usage",
  "chrome.remote_code",
  "firefox.data_collection_permissions",
  "edge.privacy_policy_requirements",
  "safari.app_privacy",
  "safari.age_rating",
  "safari.content_rights",
]);

const suffixOf = (id: string): string => id.slice(id.indexOf(".") + 1);

export function screenshotDoor(store: string): string {
  const spec = isListingStoreName(store) ? STORE_SCREENSHOT_SPECS[store] : null;
  const size = spec ? spec.sizes.map(sizeLabel).join(" or ") : "1280x800";

  return `extension_screenshot with forStore: "${store}" captures an open surface at ${size} px as a 24-bit PNG inside the project; pass its path to extension_submit action: "sync-listing" screenshots: [<path>], which writes it to the ${STORE_NAMES[store] ?? store} listing record`;
}

function clearedBy(row: RequirementRow, store: string): string {
  const suffix = suffixOf(row.id);
  const satisfied = row.satisfiedBy;

  if (suffix === "screenshots") return screenshotDoor(store);

  if (DERIVED_SUFFIXES.includes(suffix)) {
    if (suffix === "store_logo") return "resize the largest icon the manifest names to 300x300 px on this machine and upload it on the Partner Center Store listings page";
    if (suffix === "store_icon") return "the 128 px icon the manifest names, taken from the build; sync-listing records it and the dashboard's Store listing tab takes the upload";
    if (suffix === "app_icon") return "the macOS build stamps the wrapper's 1024x1024 icon from the largest icon the manifest names";
    if (suffix === "source_archive") return "the Firefox store setting Source archive; the platform cuts it from the repository at the built commit";
    if (suffix === "package_contents") return "the build; the preflight scans the Edge package for compressed files";

    return "the 128 px icon the manifest names, read from the build by sync-listing";
  }

  if (NEVER_PREFILLED.has(row.id)) return `${row.how} Answer it yourself; this server never proposes a privacy or data answer.`;
  if (/^store-md:/i.test(satisfied)) return `the ${satisfied.replace(/^store-md:\s*/i, "")} line in ${STORE_MD_FILENAME}; sync-listing sends it`;
  if (/^store-config:/i.test(satisfied)) return `extension_submit action: "configure-store" store: "${store}" storeSettings: { ${satisfied.replace(/^store-config:\s*/i, "")} }`;
  if (/^file:/i.test(satisfied)) return `${satisfied.replace(/^file:\s*/i, "")} in the build`;
  if (satisfied === "listing") return "the extension.dev listing record, written by sync-listing";
  if (satisfied === "console-only") return "the console store settings";
  if (satisfied === "store-dashboard") return `${row.dashboardTab ? `the ${row.dashboardTab} tab of ` : ""}the store's own dashboard${row.dashboardUrl ? ` at ${row.dashboardUrl}` : ""}`;

  return row.how || "the console store settings";
}

function supplyOf(row: RequirementRow): Supply {
  return DERIVED_SUFFIXES.includes(suffixOf(row.id)) ? "from your build" : "you supply";
}

/* @invariant THE BRING LIST IS THE PLATFORM'S ROWS READ ALOUD, WITH TWO
 * WORDS ADDED. Every row keeps the platform's label, format, status and
 * documentation link; this projection adds only whether the input comes
 * from the build (an icon size, an emulator capture, the source archive, a
 * package scan, each made on the owner's machine) or the owner supplies it,
 * marks the rows a store never lets you change (the add-on id, the bundle
 * ids, the App Store name, the item, the product, the app record), names the
 * exact door that clears each row, and says that a privacy or data answer is
 * the owner's alone. Nothing here invents a row, derives a value, or counts
 * differently from the platform; readyForReview is true only when the
 * platform's own list has no required row missing.
 */
export function bringListOf(store: string, view: RequirementsView | null, canSubmitForReview = true): BringList | null {
  if (!view) return null;

  const rows: BringRow[] = view.items.map((row) => ({
    id: row.id,
    label: row.label,
    required: row.required,
    status: row.status,
    supply: supplyOf(row),
    format: row.format,
    clearedBy: clearedBy(row, store),
    ...(row.docs ? { docs: row.docs } : {}),
    ...(DECIDE_ONCE.has(row.id) ? { decideOnce: true as const } : {}),
    ...(NEVER_PREFILLED.has(row.id) ? { neverPrefilled: true as const } : {}),
  }));
  const readyForReview = view.missingRequired === 0 && canSubmitForReview;

  return { store, readyForReview, rows, say: bringListSentence(store, rows, readyForReview) };
}

function rowPhrase(row: BringRow): string {
  const marks = [row.decideOnce ? "decide once" : "", row.neverPrefilled ? "never prefilled" : ""].filter(Boolean);

  return `${row.label} (${row.format}${marks.length ? `; ${marks.join(", ")}` : ""})`;
}

export function bringListSentence(store: string, rows: BringRow[], readyForReview: boolean): string {
  const name = STORE_NAMES[store] ?? store;
  const open = rows.filter((row) => row.required && row.status !== "have");
  const build = open.filter((row) => row.supply === "from your build");
  const owner = open.filter((row) => row.supply === "you supply");
  const optional = rows.filter((row) => !row.required && row.status !== "have");
  const parts: string[] = [];

  if (readyForReview) parts.push(`${name[0]!.toUpperCase()}${name.slice(1)} has every required input on file.`);
  else parts.push(`Before ${name} reviews it, bring ${open.length} required input${open.length === 1 ? "" : "s"}.`);

  if (build.length) parts.push(`From your build: ${build.map(rowPhrase).join("; ")}.`);
  if (owner.length) parts.push(`You supply: ${owner.map(rowPhrase).join("; ")}.`);
  if (optional.length) parts.push(`Optional: ${optional.map((row) => row.label.toLowerCase()).join(", ")}.`);

  return parts.join(" ");
}

export function bringListSentences(stores: Record<string, unknown>): string {
  return Object.values(stores)
    .map((view) => {
      const list = view && typeof view === "object" && !Array.isArray(view) ? (view as { bringList?: BringList }).bringList : undefined;

      return list?.say ?? "";
    })
    .filter(Boolean)
    .join(" ");
}
