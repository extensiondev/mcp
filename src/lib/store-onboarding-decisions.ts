// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import fs from "node:fs";
import path from "node:path";

import { isRow, text } from "./ship-act";
import { STORE_MD_FILENAME } from "./store-md";
import { parseStoreMdListing, type ListingField, type StoreMdListing } from "./store-md-listing";

type Row = Record<string, unknown>;

export type DecisionId = "support-email" | "homepage" | "privacy-policy" | "category" | "distribution" | "license";

export interface DecisionWrite {
  line: string;
  section: string;
  stores: string[];
}

export interface Decision {
  id: DecisionId;
  ask: string;
  default: string | null;
  defaultFrom: string;
  writes: DecisionWrite[];
  settles: string[];
  onFile: boolean;
}

interface DecisionSpec {
  id: DecisionId;
  ask: string;
  fields: ListingField[];
  writes: DecisionWrite[];
  settles: string[];
}

const LISTING = "## Listing";

const AMO_LICENSES = ["MIT", "Apache-2.0", "MPL-2.0", "GPL-2.0-only", "GPL-3.0-only", "LGPL-2.1-only", "LGPL-3.0-only", "AGPL-3.0-only", "ISC", "BSD-2-Clause", "Unlicense"];

const DEFAULT_CATEGORIES: Record<string, string> = {
  chrome: "Tools",
  edge: "Productivity",
  firefox: "Other",
  safari: "Utilities",
};

const STORE_WORDS: Record<string, string> = { chrome: "Chrome", edge: "Edge", firefox: "Firefox", safari: "Safari" };

const SPECS: DecisionSpec[] = [
  {
    id: "support-email",
    ask: "The support email every listing shows.",
    fields: ["supportEmail"],
    writes: [{ line: "- Support email:", section: LISTING, stores: ["edge", "firefox"] }],
    settles: ["edge.support_contact", "firefox.support_email"],
  },
  {
    id: "homepage",
    ask: "The homepage the listings link to, which the App Store also takes as its support URL.",
    fields: ["homepageUrl", "supportUrl"],
    writes: [
      { line: "- Homepage:", section: LISTING, stores: ["chrome", "edge", "firefox", "safari"] },
      { line: "- Support URL:", section: LISTING, stores: ["safari"] },
    ],
    settles: ["chrome.homepage_url", "edge.website_url", "firefox.support_website", "safari.marketing_url", "safari.support_url"],
  },
  {
    id: "privacy-policy",
    ask: "The privacy policy URL; with no policy yet, the agent drafts one from what the code does and you pick where it is hosted.",
    fields: ["privacyPolicyUrl"],
    writes: [{ line: "- Privacy policy URL:", section: "## Privacy and data use", stores: ["chrome", "edge", "firefox", "safari"] }],
    settles: ["chrome.privacy_policy_url", "edge.privacy_policy_url", "firefox.privacy_policy", "safari.privacy_policy_url"],
  },
  {
    id: "category",
    ask: "The category on each store.",
    fields: ["categories"],
    writes: [{ line: "- Category:", section: LISTING, stores: ["chrome", "edge", "firefox", "safari"] }],
    settles: ["chrome.category", "edge.category", "firefox.categories", "safari.primary_category"],
  },
  {
    id: "distribution",
    ask: "Who can find it and where, and the price: the defaults are the least public each store allows, free, in every region.",
    fields: ["visibility"],
    writes: [{ line: "- Visibility:", section: "## Chrome Web Store", stores: ["chrome"] }],
    settles: ["chrome.visibility", "firefox.distribution_channel", "safari.pricing_availability"],
  },
  {
    id: "license",
    ask: "The license AMO shows on a listed Firefox add-on.",
    fields: ["license"],
    writes: [{ line: "- License:", section: "## Firefox Add-ons", stores: ["firefox"] }],
    settles: ["firefox.license"],
  },
];

/* @invariant An extension has no license field (Cezar, 2026-11-04). AMO asks
 * for one on a listed Firefox version alone (Cezar, 2026-11-05, option A), and
 * the platform answers the firefox.license row only on that channel, so the
 * decision exists only when the row does, and its default is the owner's own
 * package.json license or nothing; no license is ever picked for the owner.
 */
const LISTED_ONLY = new Set(["firefox.license"]);

export const DECISION_IDS: readonly DecisionId[] = SPECS.map((spec) => spec.id);

interface ProjectFacts {
  storeMd: StoreMdListing | null;
  pkg: Row;
  privacyFile: string | null;
  licenseFile: boolean;
}

function readText(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

function projectFactsOf(projectPath: string): ProjectFacts {
  if (!projectPath) return { storeMd: null, pkg: {}, privacyFile: null, licenseFile: false };

  const storeMd = readText(path.join(projectPath, STORE_MD_FILENAME));
  let pkg: Row = {};

  try {
    const parsed: unknown = JSON.parse(readText(path.join(projectPath, "package.json")) ?? "{}");
    if (isRow(parsed)) pkg = parsed;
  } catch {
    pkg = {};
  }

  const privacyFile = ["PRIVACY.md", "privacy.md", "PRIVACY"].find((name) => fs.existsSync(path.join(projectPath, name))) ?? null;
  const licenseFile = ["LICENSE", "LICENSE.md", "LICENSE.txt"].some((name) => fs.existsSync(path.join(projectPath, name)));

  return { storeMd: storeMd === null ? null : parseStoreMdListing(storeMd), pkg, privacyFile, licenseFile };
}

function storeMdHas(listing: StoreMdListing | null, field: ListingField): boolean {
  if (!listing) return false;

  const blocks = [listing.shared, ...Object.values(listing.stores), ...Object.values(listing.overrides)];

  return blocks.some((block) => block && block[field] !== undefined) || (field === "categories" && Object.keys(listing.categoriesByStore).length > 0);
}

function repositoryUrlOf(pkg: Row): string {
  const repo = isRow(pkg.repository) ? text(pkg.repository.url) : text(pkg.repository);
  const cleaned = repo.replace(/^git\+/, "").replace(/\.git$/, "").replace(/^git@github\.com:/, "https://github.com/");

  if (/^https:\/\//.test(cleaned)) return cleaned;

  return /^[\w.-]+\/[\w.-]+$/.test(cleaned) ? `https://github.com/${cleaned}` : "";
}

function emailOf(value: unknown): string {
  const raw = isRow(value) ? text(value.email) : text(value);
  const match = /[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+/.exec(raw);

  return match ? match[0] : "";
}

function amoLicenseOf(raw: string): string {
  const named = AMO_LICENSES.find((choice) => choice.toLowerCase() === raw.toLowerCase() || choice.replace(/-only$/, "").toLowerCase() === raw.toLowerCase());

  return named ?? "";
}

function defaultOf(id: DecisionId, facts: ProjectFacts, asked: readonly string[]): { value: string | null; from: string } {
  const pkg = facts.pkg;

  if (id === "support-email") {
    const email = emailOf(pkg.bugs) || emailOf(pkg.author);

    return email ? { value: email, from: "package.json" } : { value: null, from: "none on file: the agent asks for one" };
  }

  if (id === "homepage") {
    const home = text(pkg.homepage) || repositoryUrlOf(pkg);

    return home ? { value: home, from: text(pkg.homepage) ? "package.json homepage" : "package.json repository" } : { value: null, from: "none on file: the agent asks for one" };
  }

  if (id === "privacy-policy") {
    const repo = repositoryUrlOf(pkg);

    if (facts.privacyFile && repo) return { value: `${repo}/blob/HEAD/${facts.privacyFile}`, from: `${facts.privacyFile} in the repository` };

    return { value: null, from: "no policy on file: the agent drafts PRIVACY.md from the code and you pick where it is hosted" };
  }

  if (id === "category") {
    const value = asked.filter((store) => DEFAULT_CATEGORIES[store]).map((store) => `${DEFAULT_CATEGORIES[store]} (${STORE_WORDS[store]})`).join(", ");

    return { value, from: "each store's general category; the agent proposes a closer one from what the extension does" };
  }

  if (id === "distribution") {
    const parts = [
      asked.includes("chrome") ? "Chrome unlisted" : "",
      asked.includes("edge") ? "Edge hidden in every market (set in Partner Center Availability)" : "",
      asked.includes("firefox") ? "Firefox unlisted" : "",
      asked.includes("safari") ? "App Store free in every territory" : "",
    ].filter(Boolean);

    return { value: parts.join("; "), from: "least public default (Chrome `- Visibility: unlisted`, Firefox releaseChannel unset)" };
  }

  const license = amoLicenseOf(text(pkg.license));

  if (license) return { value: license, from: "package.json license" };

  return { value: null, from: facts.licenseFile ? "a LICENSE file AMO has no preset for: the agent asks which license to name" : "none on file: the agent asks for one" };
}

export function decisionsOf(args: { asked: readonly string[]; statusById: Record<string, string>; projectPath: string }): Decision[] {
  const facts = projectFactsOf(args.projectPath);
  const storeOf = (id: string): string => id.split(".")[0] ?? "";

  return SPECS.flatMap((spec): Decision[] => {
    const settles = spec.settles.filter((id) => args.asked.includes(storeOf(id)) && (!LISTED_ONLY.has(id) || id in args.statusById));
    if (!settles.length) return [];

    const rowsHave = settles.every((id) => args.statusById[id] === "have");
    const lineHas = spec.fields.some((field) => storeMdHas(facts.storeMd, field));
    const chosen = defaultOf(spec.id, facts, args.asked);

    return [
      {
        id: spec.id,
        ask: spec.ask,
        default: chosen.value,
        defaultFrom: chosen.from,
        writes: spec.writes
          .map((write) => ({ ...write, stores: write.stores.filter((store) => args.asked.includes(store)) }))
          .filter((write) => write.stores.length),
        settles,
        onFile: rowsHave || lineHas,
      },
    ];
  });
}
