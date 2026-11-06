// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import {
  LISTING_LIST_LIMITS,
  LISTING_TEXT_LIMITS,
  SEARCH_TERMS_JOINED_LIMITS,
  type ListingStore,
  type PermissionJustification,
} from "./store-md-declarations";
import { STORE_LABELS, storeSearchTermsProblem, storeTextOverLimit } from "./store-text-limits";

const E164 = /^\+[1-9]\d{6,14}$/;

const E164_REASON = "is not an E.164 phone number (a plus, the country code and the digits, for example +5511999999999)";

const kept = (char: string): boolean => {
  const code = char.charCodeAt(0);

  return code === 9 || code === 10 || code === 13 || (code >= 32 && code !== 127);
};

const clean = (value: string): string => Array.from(value).filter(kept).join("").trim();

export interface OverLimitMeasure {
  length: number;
  limit: number;
  unit: "characters" | "bytes";
}

type Bounded = { value: unknown } | { reason: string; over?: OverLimitMeasure };

export function bounded(field: string, value: unknown, skipped: string[], store: ListingStore): Bounded {
  if (typeof value === "string") {
    const text = clean(value);
    const limit = (LISTING_TEXT_LIMITS as Record<string, number>)[field];

    if (limit && text.length > limit) {
      return { reason: `is ${text.length} characters, over the ${limit} the listing takes`, over: { length: text.length, limit, unit: "characters" } };
    }

    const over = storeTextOverLimit(store, field, text);

    if (over) {
      return {
        reason: `is ${over.length} ${over.unit}, over the ${over.max} ${over.unit} ${STORE_LABELS[store]} takes`,
        over: { length: over.length, limit: over.max, unit: over.unit },
      };
    }

    const emailField = field === "supportEmail" || field === "reviewContactEmail";
    const shapeless =
      (/Url$/.test(field) && !/^https?:\/\/\S+$/i.test(text)) ||
      (emailField && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text));

    if (text && shapeless) {
      return { reason: `is not ${emailField ? "an email address" : "an http or https URL"}` };
    }

    if (field === "reviewContactPhone" && text) {
      const digits = text.replace(/[\s().-]/g, "");

      return E164.test(digits) ? { value: digits } : { reason: E164_REASON };
    }

    return { value: text || undefined };
  }

  if (field === "permissionJustifications") {
    const limits = LISTING_LIST_LIMITS.permissionJustifications;
    const entries = (value as PermissionJustification[])
      .map((entry) => ({ permission: clean(entry.permission), justification: clean(entry.justification) }))
      .filter((entry) => entry.permission && entry.permission.length <= limits.permission && entry.justification.length <= limits.justification);

    if (entries.length < (value as unknown[]).length) skipped.push(`a permission justification over ${limits.justification} characters was left out`);

    return { value: entries.length ? entries.slice(0, limits.items) : undefined };
  }

  const limits = field === "categories" ? LISTING_LIST_LIMITS.categories : LISTING_LIST_LIMITS.searchTerms;
  const items = (value as string[]).map(clean).filter((item) => item && item.length <= limits.each);
  const joinedLimit = field === "searchTerms" ? SEARCH_TERMS_JOINED_LIMITS[store] : undefined;
  const joined = items.join(",").length;

  if (joinedLimit && joined > joinedLimit) {
    return { reason: `is ${joined} characters joined by commas, over the ${joinedLimit} the App Store keywords take`, over: { length: joined, limit: joinedLimit, unit: "characters" } };
  }

  const termsProblem = field === "searchTerms" ? storeSearchTermsProblem(store, items) : null;

  if (termsProblem) {
    return { reason: termsProblem.replace(/^listing\.searchTerms /, "").replace(/, so nothing was written$/, "") };
  }

  return { value: items.length ? items.slice(0, limits.items) : undefined };
}
