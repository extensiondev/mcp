// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { isRow, text } from "./ship-act";
import { nextStep, type NextStep } from "./store-connection";

export const EDGE_FIRST_SUBMISSION_ROW = "edge.first_submission";
export const EDGE_FIRST_SUBMISSION_STATE = "first-submission-in-partner-center";
export const EDGE_CREATE_NOT_ALLOWED = "CreateNotAllowed";

export const EDGE_FIRST_SUBMISSION_ADVICE =
  "Partner Center requires the first submission of a new product through its dashboard: open the product, submit the draft there once; later versions publish from here.";

export interface EdgeFirstSubmission {
  state: typeof EDGE_FIRST_SUBMISSION_STATE | "have";
  productId: string;
  partnerCenterUrl: string | null;
  blocksSubmit: boolean;
  steps: string[];
}

export function partnerCenterProductUrl(productId: string): string {
  return `https://partner.microsoft.com/dashboard/microsoftedge/${encodeURIComponent(text(productId))}/packages/dashboard`;
}

export function isEdgeCreateNotAllowed(message: unknown): boolean {
  return text(message).toLowerCase().includes(EDGE_CREATE_NOT_ALLOWED.toLowerCase());
}

export function edgeFirstSubmissionAdvice(url?: string | null): string {
  const link = text(url);

  return link ? `${EDGE_FIRST_SUBMISSION_ADVICE} Open the product at ${link}.` : EDGE_FIRST_SUBMISSION_ADVICE;
}

/* @invariant THE PREFLIGHT'S FIRST-SUBMISSION STATE IS READ FROM ONE TYPED
 * FIELD. The platform's Edge preflight answers `edgeFirstSubmission` beside
 * the checks: the state (`first-submission-in-partner-center` or have), the
 * product's Partner Center page, whether the act asked for would publish
 * (and so is blocked before any approval) and the one-time steps. A report
 * without the field, or for another store, carries no state. */
export function edgeFirstSubmissionOf(report: unknown): EdgeFirstSubmission | null {
  if (!isRow(report) || !isRow(report.edgeFirstSubmission)) return null;

  const row = report.edgeFirstSubmission;
  const state = text(row.state);
  if (state !== EDGE_FIRST_SUBMISSION_STATE && state !== "have") return null;

  return {
    state,
    productId: text(row.productId),
    partnerCenterUrl: text(row.partnerCenterUrl) || null,
    blocksSubmit: row.blocksSubmit === true,
    steps: Array.isArray(row.steps) ? row.steps.map(text).filter(Boolean) : [],
  };
}

export function firstSubmissionSentences(first: Pick<EdgeFirstSubmission, "partnerCenterUrl" | "steps">): string {
  const steps = first.steps.length ? ` ${first.steps.map((step, i) => `${i + 1}. ${step}`).join(" ")}` : "";

  return `${edgeFirstSubmissionAdvice(first.partnerCenterUrl)}${steps} Nothing was sent and no approval was asked for.`;
}

export function firstSubmissionStep(first: Pick<EdgeFirstSubmission, "partnerCenterUrl" | "steps">, fallbackUrl?: string): NextStep {
  return nextStep("dashboard", firstSubmissionSentences(first), first.partnerCenterUrl || fallbackUrl);
}

/* @invariant A LISTING REFUSAL THAT CARRIES THE FIRST-SUBMISSION ROW IS THE
 * FIRST-SUBMISSION STATE. The publish route's 409 names it in `state` and
 * `partnerCenterUrl`; an older body carries only the row, whose dashboardUrl
 * is the same page. Either way the next step is the dashboard, never
 * sync-listing: no STORE.md line clears it. */
export function firstSubmissionFromRefusal(body: unknown, rows: Array<{ id: string; dashboardUrl?: string }>): Pick<EdgeFirstSubmission, "partnerCenterUrl" | "steps"> | null {
  const row = rows.find((item) => item.id === EDGE_FIRST_SUBMISSION_ROW);
  const named = isRow(body) && text(body.state) === EDGE_FIRST_SUBMISSION_STATE;
  if (!row && !named) return null;

  const steps = isRow(body) && Array.isArray(body.steps) ? body.steps.map(text).filter(Boolean) : [];
  const url = (isRow(body) ? text(body.partnerCenterUrl) : "") || text(row?.dashboardUrl);

  return { partnerCenterUrl: url || null, steps };
}

export function publishRefusedMessage(reason: string, partnerCenterUrl?: string | null): string {
  return isEdgeCreateNotAllowed(reason) ? `${edgeFirstSubmissionAdvice(partnerCenterUrl)} Edge Add-ons answered: ${reason}` : reason;
}
