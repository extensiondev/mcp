// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { isRow } from "./row";
import { STORE_MD_FILENAME } from "./store-md";

type Row = Record<string, unknown>;

export const STORE_MD_FOR_PERSON = `your store listing (${STORE_MD_FILENAME})`;

export const STORE_MD_DRAFT_SENTENCE = `I also wrote a store listing draft (${STORE_MD_FILENAME}). It is only used when you submit to a store and never ships in the extension.`;

const FIRST_MENTION = /(^|[\s(])(no|a|an|the|own|your|its|their|this|that)\s+STORE\.md(?!['’]s)|STORE\.md['’]s\s+(`[^`]+`)|STORE\.md/i;

const atSentenceStart = (say: string, at: number): boolean => at === 0 || /(^|[.!?]\s+|\n)$/.test(say.slice(0, at));

export function storeMdNamedForPerson(say: string): string {
  if (!say || /store listing( draft)? \(STORE\.md\)/.test(say)) return say;

  const found = FIRST_MENTION.exec(say);
  if (!found) return say;

  const at = found.index;
  const named = found[2]
    ? `${found[1]}${found[2]} store listing (${STORE_MD_FILENAME})`
    : found[3]
      ? `the ${found[3]} line of ${STORE_MD_FOR_PERSON}`
      : atSentenceStart(say, at)
        ? `Your store listing (${STORE_MD_FILENAME})`
        : STORE_MD_FOR_PERSON;

  return `${say.slice(0, at)}${named}${say.slice(at + found[0].length)}`;
}

export function withStoreMdNamedForPerson(out: string): string {
  let parsed: unknown;

  try {
    parsed = JSON.parse(out);
  } catch {
    return out;
  }

  if (!isRow(parsed) || !isRow(parsed.value)) return out;

  const value: Row = { ...parsed.value };
  let changed = false;

  if (typeof value.sayToPerson === "string") {
    const said = storeMdNamedForPerson(value.sayToPerson);
    changed = changed || said !== value.sayToPerson;
    value.sayToPerson = said;
  }

  if (isRow(value.nextStep) && typeof value.nextStep.say === "string") {
    const said = storeMdNamedForPerson(value.nextStep.say);
    changed = changed || said !== value.nextStep.say;
    value.nextStep = { ...value.nextStep, say: said };
  }

  return changed ? JSON.stringify({ ...parsed, value }) : out;
}

const BLOCKING_WORDS: Record<string, string> = {
  title: "a title",
  name: "a name",
  summary: "a summary",
  description: "a description",
  icon: "an icon",
  store_icon: "a store icon",
  app_icon: "an app icon",
  store_logo: "a store logo",
  screenshots: "screenshots",
  privacy_policy: "a privacy policy URL",
  privacy_policy_url: "a privacy policy URL",
  support_email: "a support email",
  support_contact: "a support contact",
  support_url: "a support URL",
  support_website: "a support website",
  homepage: "a homepage",
  homepage_url: "a homepage",
  website_url: "a website",
  marketing_url: "a marketing URL",
  category: "a category",
  categories: "a category",
  primary_category: "a primary category",
  single_purpose: "a single purpose statement",
  permission_justifications: "permission justifications",
  license: "a license",
  subtitle: "a subtitle",
  keywords: "keywords",
  search_terms: "search terms",
  release_notes: "release notes",
  whats_new: "what's new text",
  reviewer_notes: "reviewer notes",
  certification_notes: "certification notes",
  test_instructions: "test instructions",
  visibility: "a visibility choice",
  distribution_channel: "a distribution channel",
};

const STORE_PREFIX = /^(chrome|firefox|edge|safari)_/;

const ID_SUFFIX = /_(present|set|ok|missing)$/;

export function blockingWord(id: string): string {
  const warned = / \(warning\)$/.test(id);
  const bare = id.replace(/ \(warning\)$/, "");
  const after = bare.slice(bare.indexOf(".") + 1).replace(STORE_PREFIX, "").replace(ID_SUFFIX, "");
  const words = BLOCKING_WORDS[after] ?? after.replace(/_/g, " ");

  return warned ? `${words} (a warning, not a blocker)` : words;
}

export function blockingWords(ids: string[]): string {
  const words = ids.map(blockingWord);
  if (words.length <= 1) return words.join("");

  return `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}
