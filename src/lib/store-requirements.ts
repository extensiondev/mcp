// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { isRow, text } from "./ship-act";

export interface RequirementRow {
  id: string;
  label: string;
  required: boolean;
  format: string;
  status: "have" | "missing" | "unknown";
  satisfiedBy: string;
  how: string;
  docs?: string;
  actual?: string;
}

export interface RequirementsView {
  store: string;
  items: RequirementRow[];
  missingRequired: number;
  missingOptional: number;
}

const STORE_NAMES: Record<string, string> = {
  chrome: "The Chrome Web Store",
  edge: "Edge Add-ons",
  firefox: "Firefox AMO",
  safari: "The App Store",
};

const NAMED_AT_MOST = 8;

function statusOf(value: unknown): RequirementRow["status"] {
  const status = text(value);

  return status === "have" || status === "missing" ? status : "unknown";
}

/* @invariant THE LIST IS THE PLATFORM'S, PASSED THROUGH WHOLE. Every row the
 * platform answers is kept with its own words: the store's label, the exact
 * format, what satisfies it and whether the project has it. Nothing here
 * adds an input, drops one, or offers to make one; the platform generates
 * none of these artifacts and neither does this server. A missing count is
 * read from the platform when it answers one and counted from the rows only
 * when it does not, so the sentence and the list never disagree.
 */
export function requirementsView(value: unknown): RequirementsView | null {
  if (!isRow(value) || !Array.isArray(value.items)) return null;

  const items = value.items.filter(isRow).map((row): RequirementRow => ({
    id: text(row.id),
    label: text(row.label),
    required: row.required === true,
    format: text(row.format),
    status: statusOf(row.status),
    satisfiedBy: text(row.satisfiedBy),
    how: text(row.how),
    ...(text(row.docs) ? { docs: text(row.docs) } : {}),
    ...(text(row.actual) ? { actual: text(row.actual) } : {}),
  }));
  const counted = (required: boolean) =>
    items.filter((item) => item.required === required && item.status === "missing").length;

  return {
    store: text(value.store),
    items,
    missingRequired: typeof value.missingRequired === "number" ? value.missingRequired : counted(true),
    missingOptional: typeof value.missingOptional === "number" ? value.missingOptional : counted(false),
  };
}

export function missingRequiredSentence(store: string, view: RequirementsView | null): string {
  if (!view) return "";

  const missing = view.items.filter((item) => item.required && item.status === "missing");
  if (!missing.length) return "";

  const named = missing.slice(0, NAMED_AT_MOST).map((item) => `${item.label} (${item.format})`);
  const more = missing.length - named.length;
  const count = missing.length === 1 ? "1 required input" : `${missing.length} required inputs`;

  return `${STORE_NAMES[store] ?? store} asks for ${count} the project does not have yet: ${named.join("; ")}${more > 0 ? `; and ${more} more` : ""}.`;
}

export function missingRequirementsSentences(stores: Record<string, unknown>): string {
  return Object.entries(stores)
    .map(([store, view]) =>
      isRow(view) && isRow(view.requirements)
        ? missingRequiredSentence(store, requirementsView(view.requirements))
        : "",
    )
    .filter(Boolean)
    .join(" ");
}

export function configuredRequirementsNote(answer: unknown, store: string): string {
  if (!isRow(answer)) return "";

  const direct = requirementsView(answer.requirements);
  const byStore = isRow(answer.requirements) ? requirementsView((answer.requirements as Record<string, unknown>)[store]) : null;
  const view = direct && direct.store === store ? direct : byStore;
  if (!view) return "";

  if (view.missingRequired === 0) return " Every required input the store asks for is on file.";

  const count = view.missingRequired === 1 ? "1 required input" : `${view.missingRequired} required inputs`;

  return ` The store asks for ${count} the project does not have yet; the preflight names each with its format.`;
}
