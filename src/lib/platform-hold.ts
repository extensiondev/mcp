// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { wwwImportPath } from "@extension.dev/urls/paths";

import { envelope } from "./envelope";
import { effectiveApiBase, mcpOrigins } from "./origins";

export const PLATFORM_HOLD_CODE = "PLATFORM_NOT_OPEN";

export const PLATFORM_HOLD_HEADER = "x-extensiondev-hold";

export const PLATFORM_HOLD_STATUS = "platform-held";

export const PLATFORM_HOLD_RELAYS_THE_PLATFORM_DATE = false;

const HOLD_CONDITION_FALLBACK = "extension.dev is not open to the public yet.";

const HOLD_STILL_WORKS =
  "This does not stop you building. Creating, developing and packaging an extension run on your own machine, need no account and nothing from the platform, and work right now: extension_create scaffolds a project, extension_dev runs it in a real browser with live reload, extension_build produces the store-ready package for every browser you target, and extension_manifest_validate with extension_doctor check it before you ship. What waits for the launch is the part that runs on extension.dev's machines: publishing a build's page to send testers, promoting a release, submitting to a store, hosting a preview share, requesting an approval, and creating a platform project or workspace. extension.dev does those from one project once it opens, and a share's zip link that was already handed out still downloads.";

export const PLATFORM_HOLD_STILL_WORKS = [
  "extension_create",
  "extension_dev",
  "extension_build",
  "extension_manifest_validate",
  "extension_doctor",
  "extension_templates",
];

export function templatesOrigin(apiHint?: string): string {
  return mcpOrigins(apiHint).templates.replace(/\/+$/, "");
}

function holdWayBack(apiHint?: string): string {
  return `Templates stay open while the rest is held: browse ${templatesOrigin(
    apiHint,
  )}, or run extension_templates here to list and start from the same set without leaving this session.`;
}

function asRecord(body: unknown): Record<string, unknown> | null {
  return body && typeof body === "object" && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : null;
}

export function readPlatformCode(body: unknown): string {
  const record = asRecord(body);
  const code = record?.code;

  return typeof code === "string" ? code.trim() : "";
}

function messageOf(body: unknown): string {
  const record = asRecord(body);
  const message = record?.message;

  return typeof message === "string" ? message.trim() : "";
}

export const ALLOWANCE_REFUSAL_CODE = "monthly_cap";

export const PRICED_REFUSAL_CODES = new Set(["BUILD_ENV_MISMATCH", "UNSTAMPED_BUILD_BLOCKED"]);

export interface AllowanceRefusal {
  message: string;
  limitReached: string;
  resetsAt: string;
  billingUrl: string;
}

const PRICE_OR_PITCH = /[$€£]\s?\d|\bupgrade\b|\/pricing\b/i;

function httpUrl(value: unknown): string {
  const url = typeof value === "string" ? value.trim() : "";

  return /^https?:\/\//i.test(url) && !PRICE_OR_PITCH.test(url) ? url : "";
}

function instantOf(value: unknown): string {
  const stamp = typeof value === "string" ? value.trim() : "";

  return stamp && Number.isFinite(Date.parse(stamp)) ? stamp : "";
}

function plainText(value: unknown): string {
  const said = typeof value === "string" ? value.trim() : "";

  return said && !PRICE_OR_PITCH.test(said) ? said : "";
}

/* @invariant A SPENT MONTHLY ALLOWANCE IS ANSWERED WITH THE LIMIT, ITS RESET
 * AND THE BILLING PAGE, AND NEVER A PRICE (owner ruling 2026-11-14, ledger
 * 525). The console keeps the platform's full sentence and its upgrade link;
 * a tool answer relays the neutral fields the platform sends beside them
 * (limitReached, resetsAt, billingUrl, neutralMessage) and composes the same
 * three facts itself when an older platform sends none. Anything that names
 * a price, an upgrade or the pricing page is dropped rather than relayed, so
 * no tool answer can carry a pitch whatever the platform says.
 */
export function allowanceRefusal(body: unknown, billingUrl = ""): AllowanceRefusal | null {
  const record = asRecord(body);

  if (!record || readPlatformCode(record) !== ALLOWANCE_REFUSAL_CODE) return null;

  const limitReached = plainText(record.limitReached) || "monthly build limit";
  const resetsAt = instantOf(record.resetsAt);
  const billing = httpUrl(record.billingUrl) || httpUrl(billingUrl);
  const said =
    plainText(record.neutralMessage) ||
    `This workspace reached its ${limitReached}, so this was refused and nothing ran. ${resetsAt ? `The limit resets at ${resetsAt}.` : "The limit resets at the start of next month (UTC)."}`;
  const message = billing && !said.includes(billing) ? `${said} Manage the plan at ${billing}.` : said;

  return { message, limitReached, resetsAt, billingUrl: billing };
}

export function allowanceValue(refusal: AllowanceRefusal | null): Record<string, string> {
  if (!refusal) return {};

  return {
    limitReached: refusal.limitReached,
    ...(refusal.resetsAt ? { resetsAt: refusal.resetsAt } : {}),
    ...(refusal.billingUrl ? { billingUrl: refusal.billingUrl } : {}),
  };
}

export function readPlatformMessage(body: unknown): string {
  return allowanceRefusal(body)?.message ?? messageOf(body);
}

export function pricedRefusal(code: string, body: unknown): { hint: string } | null {
  if (!PRICED_REFUSAL_CODES.has(code)) return null;

  const hint = messageOf(body);

  return hint ? { hint } : null;
}

export function sawPlatformHold(
  res?: { headers?: { get?: (name: string) => string | null } } | null,
  body?: unknown,
): boolean {
  if (readPlatformCode(body) === PLATFORM_HOLD_CODE) return true;

  const marker = res?.headers?.get?.(PLATFORM_HOLD_HEADER);

  return typeof marker === "string" && marker.trim() === "held";
}

function relayedDate(body: unknown): string {
  if (!PLATFORM_HOLD_RELAYS_THE_PLATFORM_DATE) return "";

  const record = asRecord(body);
  const opensAt = record?.opensAt;

  return typeof opensAt === "string" && opensAt.trim() ? opensAt.trim() : "";
}

export function platformHoldMessage(body?: unknown, apiHint?: string): string {
  const condition = readPlatformMessage(body) || HOLD_CONDITION_FALLBACK;
  const date = relayedDate(body);

  return [
    condition,
    date ? `The platform reports it opens on ${date}.` : "",
    HOLD_STILL_WORKS,
    holdWayBack(apiHint),
  ]
    .filter(Boolean)
    .join(" ");
}

export function platformHoldEnvelope(options: {
  command: string;
  name: string;
  body?: unknown;
  api?: string;
  value?: Record<string, unknown>;
}): string {
  return envelope({
    ok: false,
    command: options.command,
    status: PLATFORM_HOLD_STATUS,
    value: {
      ...(options.value ?? {}),
      stillWorks: PLATFORM_HOLD_STILL_WORKS,
      openSurface: templatesOrigin(options.api),
    },
    error: {
      code: "E_PLATFORM",
      platformCode: PLATFORM_HOLD_CODE,
      name: options.name,
      message: platformHoldMessage(options.body, options.api),
    },
    hint: holdWayBack(options.api),
  });
}

const HOLD_MARKER_TEXT = "is not open to the public yet";

export type LaneSubject = "project" | "projects" | "workspace";

export interface CreatePrefill {
  project: string;
  repo?: string;
}

export interface LaneClosedFacts {
  server: string;
  publicHold: boolean;
  allowlistNamed: false;
  consoleUrl?: string;
  createUrl?: string;
  prefilled?: string[];
  askedOnTheForm?: string[];
}

export const CREATE_FORM_SETTINGS_LATER =
  "the install command, build command and output directory are set after creation with extension_builds (action: configure)";

function createForm(www: string, prefill: CreatePrefill): Required<Pick<LaneClosedFacts, "createUrl" | "prefilled" | "askedOnTheForm">> {
  const [workspace = "", name = ""] = prefill.project.split("/");
  const repo = String(prefill.repo ?? "").trim();
  const query = {
    ...(repo ? { repository: repo } : {}),
    name,
    workspace,
  };

  return {
    createUrl: `${www.replace(/\/+$/, "")}${wwwImportPath(query)}`,
    prefilled: Object.keys(query),
    askedOnTheForm: [...(repo ? [] : ["repository"]), "browsers"],
  };
}

export function laneClosedFacts(options: { api?: string; message?: string; prefill?: CreatePrefill }): LaneClosedFacts {
  const origins = mcpOrigins(options.api);
  const publicHold = String(options.message ?? "").includes(HOLD_MARKER_TEXT);

  return {
    server: effectiveApiBase(options.api) || origins.www,
    publicHold,
    allowlistNamed: false,
    ...(publicHold ? {} : { consoleUrl: origins.console }),
    ...(publicHold || !options.prefill ? {} : createForm(origins.www, options.prefill)),
  };
}

function prefilledFormSentence(facts: LaneClosedFacts, prefill: CreatePrefill): string {
  const [workspace = "", name = ""] = prefill.project.split("/");
  const repo = String(prefill.repo ?? "").trim();
  const carried = repo
    ? `repository ${repo}, name ${name} and workspace ${workspace}`
    : `name ${name} and workspace ${workspace}`;
  const asks = repo
    ? "The form asks which browsers to build"
    : "The form still asks for the GitHub repository the source is pushed to, because the console's create form takes a repository only (extension_project_create with projectPath uploads a folder instead once the lane opens), and which browsers to build";

  return `Create the project in the console: open ${facts.createUrl}, the create form with ${carried} prefilled. ${asks}; ${CREATE_FORM_SETTINGS_LATER}. Then run extension_auth (action: login) against it.`;
}

export function laneClosedHint(options: { api?: string; message?: string; subject: LaneSubject; prefill?: CreatePrefill }): string {
  const facts = laneClosedFacts(options);
  const noun = options.subject === "workspace" ? "workspace" : "project";

  if (facts.publicHold) {
    return `This is the platform's public hold on ${facts.server}: headless ${noun} creation there is open only to workspaces on the platform's allowlist, and it refused this one. Its answer names no allowlisted workspace and no opening date, so nothing on this machine opens it, and the console answers its gate page during the hold, so creating it there is no route either. Building, running and packaging still work with no account: extension_create, extension_dev and extension_build.`;
  }

  const target =
    options.subject === "workspace"
      ? `Create the workspace in the console at ${facts.consoleUrl} (workspace switcher, New workspace), then run extension_project_create against it.`
      : options.subject === "project" && options.prefill
        ? prefilledFormSentence(facts, options.prefill)
        : `Create the ${options.subject === "projects" ? "projects" : "project"} in the console at ${facts.consoleUrl} (workspace page, New project), then run extension_auth (action: login) against ${options.subject === "projects" ? "them" : "it"}.`;

  return `The platform at ${facts.server} closed headless ${noun} creation for this call; its own message above says why. ${target}`;
}
