// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import crypto from "node:crypto";

import { ConsoleProjectPage } from "@extension.dev/urls/paths";

import { consoleProjectUrl } from "../lib/registry";
import { envelope } from "../lib/envelope";
import { type ApprovalGateInput } from "../lib/approval-gate";
import { APPROVAL_REQUIRED_STATUS } from "../lib/approval-outcome";
import { approvalVerdict } from "../lib/approval-policy";
import {
  OWNER_REQUIRED_CODE,
  openProjectApi,
  projectApiGet,
  projectApiOpenFailure,
  projectApiReadFailure,
  projectApiSend,
  tokenRefusal,
  type ProjectApi,
  type ProjectApiRefusal,
} from "../lib/project-api";
import { approvedSettingsWrite } from "../lib/settings-write";
import { trackUrl } from "../lib/track-url";

export const COMMAND = "extension_builds";
const SETTINGS_ACTION = "extension_settings.build";
const CHANNEL_ACTION = "extension_builds.create-channel";
export const BUILD_ENVS = ["staging", "production"] as const;
const BROWSERS = ["chrome", "edge", "firefox", "safari"] as const;
const FIELDS = ["enabled", "installCommand", "buildCommand", "outputDirectory"] as const;
const REQUIRED_BROWSERS = ["chrome", "edge", "firefox"] as const;

export type Row = Record<string, unknown>;

export interface ActArgs {
  action?: string;
  buildId?: string;
  buildEnv?: string;
  buildSettings?: unknown;
  approvalId?: string;
  channel?: string;
  description?: string;
  color?: string;
  audience?: string;
  waitSeconds?: unknown;
  project?: string;
  api?: string;
}

export function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : "";
}

export function isRow(value: unknown): value is Row {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function badRequest(action: string, name: string, message: string, extra: Row = {}): string {
  return envelope({
    ok: false,
    command: COMMAND,
    status: "bad-request",
    value: { action, ...extra },
    error: { code: "E_BAD_REQUEST", name, message },
  });
}

const RATE_LIMITED = new Set(["burst_cap", "monthly_cap", "RATE_LIMITED"]);
const UNAVAILABLE = new Set(["counter_unavailable", "entitlement_unavailable", "kill_switch", "unattributed"]);

function refusalHint(code: string, retryAfterSeconds?: number): string | undefined {
  const wait = retryAfterSeconds ? ` The platform asks for ${retryAfterSeconds} seconds before the next try.` : "";

  if (code === "burst_cap") return `The workspace started too many builds in the last hour.${wait} Nothing was dispatched.`;
  if (code === "monthly_cap") return `The workspace's build allowance for this month is spent, so nothing was dispatched.${wait} The plan page in the console raises it.`;
  if (code === "RATE_LIMITED") return `This login made too many of these requests.${wait}`;
  if (code === "BUILD_DISPATCH_DISABLED") return "Build dispatch is paused for every project right now, so nothing was dispatched. Try again later.";
  if (UNAVAILABLE.has(code)) return `The platform could not confirm this build is within the workspace's allowance, so it refused instead of guessing.${wait || " Try again shortly."}`;

  if (code === "REBUILD_REPLACES_LIVE_ARTIFACT") {
    return 'This commit is live on a channel built for another environment, and this rebuild would replace what that channel serves. Pass the environment the channel needs as buildEnv (production for stable, staging for the other channels).';
  }

  if (code === "REBUILD_FORCE_NEEDS_A_PERSON") return "Replacing artifacts a live channel serves is a person's decision: ask a person on the project to replace them from the console, where releasing this commit offers Replace and rebuild.";
  if (code === "TESTING_WORKSPACE_READ_ONLY") return "This is a testing workspace, which reads but does not build or change anything.";

  return undefined;
}

export function actRefusal(read: ProjectApiRefusal, action: string, api: ProjectApi, args: ActArgs, value: Row = {}): string {
  const context = { workspace: api.ref.workspace, project: `${api.ref.workspace}/${api.ref.project}` };

  if (read.held || tokenRefusal(read.code, context) || read.code === OWNER_REQUIRED_CODE || read.status === 0) {
    return projectApiReadFailure(COMMAND, read, { api: args.api, name: "Builds", value: { action, ...value }, context });
  }

  const hint = refusalHint(read.code, read.retryAfterSeconds);
  const status =
    read.status === 400
      ? "bad-request"
      : RATE_LIMITED.has(read.code) || read.status === 429
        ? read.code === "BUILD_DISPATCH_DISABLED"
          ? "paused"
          : "rate-limited"
        : read.status === 503 || UNAVAILABLE.has(read.code)
          ? "unavailable"
          : read.status === 404
            ? "not-found"
            : "refused";

  return envelope({
    ok: false,
    command: COMMAND,
    status,
    value: {
      action,
      ...value,
      ...(read.retryAfterSeconds ? { retryAfterSeconds: read.retryAfterSeconds } : {}),
    },
    error: {
      code: status === "bad-request" ? "E_BAD_REQUEST" : read.status === 403 ? "E_AUTH_DENIED" : "E_PLATFORM",
      name: `Builds${status === "bad-request" ? "InputError" : "Refused"}`,
      ...(read.code ? { platformCode: read.code } : {}),
      message: read.message,
    },
    ...(hint ? { hint } : {}),
  });
}

export async function openFor(args: ActArgs, action: string, value: Row = {}): Promise<{ api: ProjectApi } | { refused: string }> {
  const opened = await openProjectApi({ command: COMMAND, project: args.project, api: args.api });

  if (!opened.ok) {
    return { refused: projectApiOpenFailure(COMMAND, opened, { api: args.api, name: "Builds", value: { action, ...value } }) };
  }

  return { api: opened.api };
}

type BrowserConfig = Record<(typeof FIELDS)[number], unknown>;

function readChange(raw: unknown): { change: Record<string, Row> } | { problem: string } {
  if (!isRow(raw) || Object.keys(raw).length === 0) {
    return { problem: 'buildSettings must name at least one browser, such as { "firefox": { "buildCommand": "pnpm build" } }.' };
  }

  const change: Record<string, Row> = {};

  for (const [browser, value] of Object.entries(raw)) {
    if (!(BROWSERS as readonly string[]).includes(browser)) {
      return { problem: `"${browser}" is not a browser these settings hold; use ${BROWSERS.join(", ")}.` };
    }

    if (!isRow(value) || Object.keys(value).length === 0) {
      return { problem: `buildSettings.${browser} must be an object naming at least one of ${FIELDS.join(", ")}.` };
    }

    const unknown = Object.keys(value).filter((key) => !(FIELDS as readonly string[]).includes(key));

    if (unknown.length) {
      return { problem: `buildSettings.${browser} has ${unknown.map((k) => `"${k}"`).join(", ")}, which is not a build setting; use ${FIELDS.join(", ")}.` };
    }

    change[browser] = value;
  }

  return { change };
}

function mergeSettings(current: Row, change: Record<string, Row>): Record<string, BrowserConfig> {
  const merged: Record<string, BrowserConfig> = {};
  const browsers = [...REQUIRED_BROWSERS, ...(change.safari ? (["safari"] as const) : [])];

  for (const browser of browsers) {
    const stored = isRow(current[browser]) ? (current[browser] as Row) : {};
    const next = change[browser] ?? {};
    const config = {} as BrowserConfig;

    for (const field of FIELDS) {
      const fallback = field === "enabled" ? Boolean(stored.enabled) : String(stored[field] ?? "");
      config[field] = field in next ? next[field] : fallback;
    }

    merged[browser] = config;
  }

  return merged;
}

/* @invariant THE CLIENT HASHES THE BYTES THE SERVER HASHES. The approval is a
 * sha256 over the full write, browsers in the order chrome, edge, firefox,
 * then safari when sent, each with its keys in the order enabled,
 * installCommand, buildCommand, outputDirectory, rendered with JSON.stringify.
 * A digest that differs from the platform's asks a human to approve a change
 * that can never run, so it is refused here instead.
 */
export function settingsDigest(settings: Record<string, BrowserConfig>): string {
  const canonical: Row = {};

  for (const browser of BROWSERS) {
    const config = settings[browser];
    if (!config) continue;

    canonical[browser] = {
      enabled: config.enabled,
      installCommand: config.installCommand,
      buildCommand: config.buildCommand,
      outputDirectory: config.outputDirectory,
    };
  }

  return crypto.createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

const SETTINGS_CONSUMED_NEXT = 'The call that used it may already have changed the settings: read them with extension_workspace (action: "settings") first, and request a fresh approval only if the change is not there.';

export async function configure(args: ActArgs): Promise<string> {
  const read = readChange(args.buildSettings);
  if ("problem" in read) return badRequest("configure", "BuildSettingsInputError", `${read.problem} Nothing was changed.`);

  const opened = await openFor(args, "configure");
  if ("refused" in opened) return opened.refused;

  const api = opened.api;
  const current = await projectApiGet<Row>(api, "settings/build");
  if (!current.ok) return actRefusal(current, "configure", api, args);

  const merged = mergeSettings(isRow(current.json.buildSettings) ? current.json.buildSettings : {}, read.change);
  const scope = { settingsDigest: settingsDigest(merged) };
  const project = `${api.ref.workspace}/${api.ref.project}`;
  const approvalId = text(args.approvalId);
  const gateInput: ApprovalGateInput = {
    command: COMMAND,
    action: SETTINGS_ACTION,
    scope,
    description: `Change the build settings of ${project}.`,
    token: api.token,
    api: args.api,
    refusedStatus: "configure-refused",
    body: { buildSettings: merged },
    reason: "A build settings change is a plain act under the owner's own token, and the platform asked a workspace owner to approve this exact one before it is saved; the approval page shows the change as the platform computed it.",
    stateRead: 'extension_workspace (action: "settings") for build settings',
    refusalHint: (code) => (code === "NO_CHANGE" ? "The settings already read this way; nothing needs changing." : undefined),
  };

  const written = await approvedSettingsWrite({
    api,
    route: "settings/build",
    body: { buildSettings: merged },
    approvalId,
    gate: gateInput,
    mismatch: () =>
      envelope({
        ok: false,
        command: COMMAND,
        status: "configure-refused",
        value: { action: "configure", settingsDigest: scope.settingsDigest },
        error: {
          code: "E_PLATFORM",
          name: "SettingsDigestMismatch",
          message: "The platform hashes this change differently from this server, so an approval of it could never be used. No approval was requested and nothing was changed.",
        },
      }),
    undone: "Nothing was changed by this call.",
    value: { action: "configure" },
    next: { used: SETTINGS_CONSUMED_NEXT },
  });

  if (!written.ok) return written.out ?? actRefusal(written.sent, "configure", api, args);

  const gateLine = written.verdict === "plain" && !approvalId ? " This was a plain setting under your own token; no approval page was involved." : "";

  return envelope({
    ok: true,
    command: COMMAND,
    status: "build-configured",
    value: {
      action: "configure",
      project,
      buildSettings: merged,
      trackUrl: trackUrl("build-settings", { workspace: api.ref.workspace, project: api.ref.project }, args.api),
    },
    hint: `${project}'s build settings now read as buildSettings.${gateLine} The next build runs them: a push, or extension_builds action:"rebuild".`,
  });
}

export async function createChannel(args: ActArgs): Promise<string> {
  const name = text(args.channel);
  if (!name) return badRequest("create-channel", "ChannelInputError", "create-channel needs channel, the new channel's name. Nothing was created.");

  const audience = text(args.audience).toLowerCase();

  if (audience && audience !== "public" && audience !== "private") {
    return badRequest("create-channel", "ChannelInputError", `audience must be public or private, not ${text(args.audience)}. Nothing was created.`, { channel: name });
  }

  const opened = await openFor(args, "create-channel", { channel: name });
  if ("refused" in opened) return opened.refused;

  const api = opened.api;

  if (approvalVerdict(CHANNEL_ACTION, { audience }) !== "plain") return publicAudienceKept(api, args, name);

  const body: Row = { name };
  if (text(args.description)) body.description = text(args.description);
  if (text(args.color)) body.color = text(args.color);
  if (audience) body.audience = audience;

  const sent = await projectApiSend<Row>(api, "POST", "channels", body);
  const exists = !sent.ok && sent.status === 409;
  if (!sent.ok && !exists) return actRefusal(sent, "create-channel", api, args, { channel: name });

  const list = await projectApiGet<unknown[]>(api, "channels");
  const channels = list.ok && Array.isArray(list.json) ? list.json.filter(isRow) : [];
  const promote = `extension_release_promote (channel: "${name}", buildId: <a build>)`;
  const given = sent.ok && isRow(sent.json) ? text(sent.json.audience).toLowerCase() : "";
  const audienceNote =
    audience && !exists && given && given !== audience
      ? `The platform created ${name} as ${given}, not ${audience}: it sets a new channel's audience from the project's visibility and does not take audience at creation yet. A workspace owner or admin changes it with the channel Audience control on the console Releases page, which this server cannot call.`
      : null;

  return envelope({
    ok: true,
    command: COMMAND,
    status: exists ? "exists" : "channel-created",
    value: {
      action: "create-channel",
      created: !exists,
      channel: sent.ok ? sent.json : channels.find((c) => text(c.name) === name || text(c.id) === name) ?? { name },
      channels,
      trackUrl: trackUrl("channels", { workspace: api.ref.workspace, project: api.ref.project }, args.api),
    },
    hint: exists
      ? `${name} already exists, so nothing was created. Point it at a build with ${promote}.`
      : `${name} is a new release channel with no build yet. Point it at a build with ${promote}.`,
    warnings: [list.ok ? null : `The channel list could not be read (${list.message}).`, audienceNote],
  });
}

/* @invariant A PUBLIC CHANNEL AUDIENCE IS A PERSON'S DECISION, ANSWERED BEFORE
 * ANYTHING IS SENT. Creating a channel is a plain act, but a public audience
 * opens its downloads to anyone with the link, which the ruling of
 * 2026-10-23 keeps on the approve page; the platform mints that approval
 * only for a channel that exists (configure-channel), so the answer offers
 * the private create followed by configure-channel, and names the console
 * Releases page where a workspace owner or admin sets it by hand.
 */
function publicAudienceKept(api: ProjectApi, args: ActArgs, name: string): string {
  const releasesPage = consoleProjectUrl(api.ref, ConsoleProjectPage.releases, args.api);
  const say = `A public channel is a person's decision: I can create ${name} private now, then open it with configure-channel (audience public), which asks a workspace owner to approve on the approve page; or a workspace owner or admin opens it from the Releases page, ${releasesPage}.`;

  return envelope({
    ok: false,
    command: COMMAND,
    status: APPROVAL_REQUIRED_STATUS,
    value: { action: "create-channel", channel: name, audience: "public", trackUrl: releasesPage, sayToPerson: say },
    error: {
      code: "E_APPROVAL_REQUIRED",
      name: "ChannelAudienceNeedsAPerson",
      message: `Creating ${name} as a public channel opens its downloads to anyone with the link, which a person decides; nothing was sent. Create it with audience private, or without audience, then extension_builds action:"configure-channel" (channel: "${name}", audience: "public") asks a workspace owner's approval of that exact change, or a workspace owner or admin opens it at ${releasesPage}.`,
    },
    hint: say,
  });
}
