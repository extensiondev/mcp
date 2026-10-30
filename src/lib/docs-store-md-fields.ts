// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { storeMdFieldRows, type StoreMdFieldRow } from "./store-md-fields";
import { LISTING_SECTION, LISTING_STORES, PRIVACY_SECTION, STORE_SECTIONS, type ListingStore } from "./store-md-listing";

const STORE_TITLES: Record<ListingStore, string> = {
  chrome: "Chrome Web Store",
  firefox: "Firefox Add-ons",
  edge: "Edge Add-ons",
  safari: "App Store (Safari)",
};

const GENERATED_FROM = "src/lib/store-md-declarations.ts";

const RULES = [
  `A \`##\` heading is matched by prefix, case aside: \`${LISTING_SECTION}\`, \`${PRIVACY_SECTION}\`, and a store section by the store its heading names (chrome or chrome-web-store, firefox or amo, edge, safari or app store), so \`## Firefox Add-ons\`, \`## firefox-amo\` and \`## AMO\` are one section; the first section for a store wins. A \`###\` heading inside a store section is matched by prefix the same way.`,
  "A line is a `- Key: value` bullet; the key is case-insensitive, and the value may continue on the indented lines below it. A value that starts with TODO counts as absent. HTML comments are skipped.",
  `The section column is the line's home. A line is also read from the sections in the also-read-from column, and the home wins when both carry one; a store section's own \`- Key:\` lines, at the top of the section or under any of its \`###\` sub-headings (the \`### Permissions justification\` bullets aside), are read with the same keys as \`${LISTING_SECTION}\` and win for that store alone.`,
  "A single-value line is read up to a trailing parenthetical that names a store. `- Category: Productivity (Chrome: Productivity, Safari: Utilities)` reads `Productivity` for every store and the named store's own value where the note gives one, with a colon; the same `(Store: value)` note works on the name, subtitle, summary, license, support email, homepage and review contact lines. `- Category:` is read from `## Listing` only, and a line of several categories reads a plain `(Chrome Web Store)` note as the stores that category is for. A parenthetical that names no store is a remark: kept out of the license, support email and homepage, left in the prose lines.",
  "A line that is present but over its limit or not in the shape the reader takes is left out of the sync and named, with its reason, in `skipped`; the preflight's `storeMd` block names the same line with the shape it wants.",
  "Screenshots and the icon are never read from STORE.md. The icon comes from the build the store receives, and screenshots reach the per-store listing record only through the `screenshots` input of `sync-listing` (PNG paths inside the project, written by `extension_screenshot` with `forStore`); a `- Screenshots:` line is named in `skipped` and read for no file, and once the store's screenshots row reads have, that `skipped` entry says the line is retired because the images come from the listing record.",
];

export interface StoreMdFieldsJson {
  generatedFrom: string;
  version: string;
  sections: { listing: string; privacy: string; stores: Record<ListingStore, string> };
  rules: string[];
  stores: Record<ListingStore, StoreMdFieldRow[]>;
}

const cell = (text: string): string => text.replace(/\|/g, "\\|");

export function renderStoreMdFieldsDoc(): string {
  const lines: string[] = [];
  lines.push("# STORE.md fields");
  lines.push("");
  lines.push(
    `Generated from the parser's own declarations in \`${GENERATED_FROM}\`, the lists \`src/lib/store-md-listing.ts\` matches against (\`STORE_FIELDS\`, \`BULLET_KEYS\`, \`SUBSECTION_KEYS\`, the section names and the limits); do not edit by hand. Regenerate with \`pnpm docs:tools\`. A test fails when this file and the parser disagree. These are the lines \`extension_submit\` \`preflight\` and \`sync-listing\` read from a project's STORE.md, per store; the line column is the label the platform's requirements name in \`satisfiedBy: "store-md: <line>"\`.`,
  );

  lines.push("");
  lines.push("## How a line is resolved");
  lines.push("");

  for (const rule of RULES) lines.push(`- ${rule}`);

  lines.push("");

  for (const store of LISTING_STORES) {
    const rows = storeMdFieldRows(store);
    lines.push(`## ${store} (${STORE_TITLES[store]}, \`${STORE_SECTIONS[store]}\`)`);
    lines.push("");
    lines.push(`${rows.length} fields.`);
    lines.push("");
    lines.push("| line | section | also read from | field | limit |");
    lines.push("| --- | --- | --- | --- | --- |");

    for (const row of rows) {
      const also = row.alsoRead.map((section) => `\`${section}\``).join(", ");
      lines.push(`| \`${row.line}\` | \`${row.section}\` | ${also} | \`${row.field}\` | ${cell(row.limit)} |`);
    }

    lines.push("");
  }

  return lines.join("\n").replace(/\n+$/, "");
}

export function renderStoreMdFieldsJson(version: string): StoreMdFieldsJson {
  const stores = Object.fromEntries(LISTING_STORES.map((store) => [store, storeMdFieldRows(store)])) as Record<ListingStore, StoreMdFieldRow[]>;

  return {
    generatedFrom: GENERATED_FROM,
    version,
    sections: { listing: LISTING_SECTION, privacy: PRIVACY_SECTION, stores: STORE_SECTIONS },
    rules: RULES,
    stores,
  };
}
