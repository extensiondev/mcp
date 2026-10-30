// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { stripQuotes } from "./store-md-bullets";

import type { PermissionJustification } from "./store-md-declarations";

const ALL_URLS = new Set(["<all_urls>", "*://*/*", "http://*/*", "https://*/*"]);

const ALL_URLS_WORDS = [
  "<all_urls>",
  "all urls",
  "all sites",
  "all websites",
  "every site",
  "every website",
  "any site",
  "any website",
  "all pages",
  "every page",
  "*://*/*",
];

const UNCOVERED_IN_SENTENCE = /\b(?:reaches|requests) (.+?), which no bullet/;

export const isHostPattern = (name: string): boolean => ALL_URLS.has(name) || name.includes("://");

const globToRegExp = (glob: string): RegExp =>
  new RegExp(`^${glob.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`, "i");

/* @invariant A BULLET NAMES A HOST BY ITS KEY OR ITS REASON. The platform's
 * host check reads a justification's key and reason together and takes the
 * pattern as named when either holds it; this reader answers the same for
 * the local STORE.md before the sync, so the two never disagree about one
 * file. A key is a name when it equals the pattern after its backticks or
 * quotes are stripped, or is a glob that covers it (the all-hosts pattern and
 * `<all_urls>` cover every host, `https://*.example.com` with its path covers
 * `https://www.example.com` with the same); a reason names an all-hosts pattern with the
 * platform's own words for it ("all sites", "every page").
 */
export function patternCovers(key: string, pattern: string): boolean {
  const own = stripQuotes(key).toLowerCase();
  const wanted = pattern.toLowerCase();

  if (own === wanted) return true;
  if (ALL_URLS.has(own) || own === "<all_urls>") return isHostPattern(wanted);
  if (!own.includes("*")) return false;

  return globToRegExp(own).test(wanted);
}

export function bulletNamesHost(pattern: string, entries: PermissionJustification[]): boolean {
  const wanted = pattern.toLowerCase();

  return entries.some(({ permission, justification }) => {
    if (patternCovers(permission, pattern)) return true;

    const reason = justification.toLowerCase();
    if (reason.includes(wanted)) return true;

    const words = reason.split(/\s+/).map(stripQuotes).map((word) => word.replace(/[.,;:]+$/, ""));
    if (words.some((word) => word.includes("://") && patternCovers(word, pattern))) return true;

    return ALL_URLS.has(wanted) && ALL_URLS_WORDS.some((word) => reason.includes(word));
  });
}

export function bulletNamesPermission(name: string, entries: PermissionJustification[]): boolean {
  if (isHostPattern(name)) return bulletNamesHost(name, entries);

  const wanted = name.toLowerCase();

  return entries.some(({ permission, justification }) => `${permission} ${justification}`.toLowerCase().includes(wanted));
}

export function namesNotInBullets(names: string[], entries: PermissionJustification[]): string[] {
  return names.filter((name) => !bulletNamesPermission(name, entries));
}

export function uncoveredNamesIn(sentence: string): string[] {
  const match = UNCOVERED_IN_SENTENCE.exec(sentence);
  if (!match) return [];

  return match[1]!
    .split(/,\s*|\s+and\s+/)
    .map((name) => name.trim())
    .filter(Boolean);
}

export const listOf = (names: string[]): string =>
  names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}` : (names[0] ?? "");
