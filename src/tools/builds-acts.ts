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
import {
  APPROVAL_PENDING_STATUS,
  APPROVAL_REJECTED_STATUS,
  actionFingerprint,
  evaluateApproval,
  requestApprovalAfterRefusal,
  type ApprovalGateInput,
} from "../lib/approval-gate";
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

const COMMAND = "extension_builds";
const SETTINGS_ACTION = "extension_settings.build";
const BUILD_ENVS = ["staging", "production"] as const;
const BROWSERS = ["chrome", "edge", "firefox", "safari"] as const;
const FIELDS = ["enabled", "installCommand", "buildCommand", "outputDirectory"] as const;
const REQUIRED_BROWSERS = ["chrome", "edge", "firefox"] as const;

type Row = Record<string, unknown>;

export interface ActArgs {
  action?: string;
  buildId?: string;
  buildEnv?: string;
  buildSettings?: unknown;
  approvalId?: string;
  channel?: string;
  description?: string;
  color?: string;
  project?: string;
  api?: string;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : "";
}

function isRow(value: unknown): value is Row {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function badRequest(action: string, name: string, message: string, extra: Row = {}): string {
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

  if (code === "REBUILD_FORCE_NEEDS_A_PERSON") return "Replacing artifacts a live channel serves is a person's decision; force it from the console's Builds page if it is meant.";
  if (code === "TESTING_WORKSPACE_READ_ONLY") return "This is a testing workspace, which reads but does not build or change anything.";

  return undefined;
}

function actRefusal(read: ProjectApiRefusal, action: string, api: ProjectApi, args: ActArgs, value: Row = {}): string {
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

async function openFor(args: ActArgs, action: string, value: Row = {}): Promise<{ api: ProjectApi } | { refused: string }> {
  const opened = await openProjectApi({ command: COMMAND, project: args.project, api: args.api });

  if (!opened.ok) {
    return { refused: projectApiOpenFailure(COMMAND, opened, { api: args.api, name: "Builds", value: { action, ...value } }) };
  }

  return { api: opened.api };
}

/* @invariant A REBUILD IS A REAL CI RUN, ASKED FOR AS THE AGENT AND NEVER FORCED.
 * The dispatch spends the workspace's build allowance on real runners, so the
 * request names its origin as mcp for the meter, and never sends force: a
 * rebuild that would replace what a live channel serves is refused by the
 * platform, and that refusal says which environment to rebuild for instead.
 */
export async function rebuild(args: ActArgs): Promise<string> {
  const buildEnv = text(args.buildEnv).toLowerCase();

  if (buildEnv && !(BUILD_ENVS as readonly string[]).includes(buildEnv)) {
    return badRequest("rebuild", "BuildsInputError", `buildEnv must be ${BUILD_ENVS.join(" or ")}; got "${args.buildEnv}". Nothing was dispatched.`);
  }

  const commitSha = text(args.buildId);
  const opened = await openFor(args, "rebuild");
  if ("refused" in opened) return opened.refused;

  const api = opened.api;
  const body: Row = { origin: "mcp" };
  if (buildEnv) body.buildEnv = buildEnv;
  if (commitSha) body.commitSha = commitSha;

  const sent = await projectApiSend<Row>(api, "POST", "builds/dispatch", body);
  if (!sent.ok) return actRefusal(sent, "rebuild", api, args, commitSha ? { buildId: commitSha } : {});

  const commit = text(sent.json.commit) || commitSha;
  const browsers = text(sent.json.browsers).split(",").map((b) => b.trim()).filter(Boolean);
  const stripped = Array.isArray(sent.json.strippedBrowsers) ? sent.json.strippedBrowsers.map(text).filter(Boolean) : [];
  const project = `${api.ref.workspace}/${api.ref.project}`;
  const scope = args.project ? { project: args.project } : {};

  return envelope({
    ok: true,
    command: COMMAND,
    status: "dispatched",
    value: {
      action: "rebuild",
      project,
      commit,
      branch: text(sent.json.branch) || null,
      buildEnv: buildEnv || "staging",
      browsers,
      ...(stripped.length ? { strippedBrowsers: stripped } : {}),
      origin: text(sent.json.origin) || "mcp",
      follow: {
        list: { action: "list", ...scope },
        get: { action: "get", buildId: commit, ...scope },
        logs: { action: "logs", buildId: commit, ...scope },
      },
      buildsPageUrl: consoleProjectUrl(api.ref, ConsoleProjectPage.builds, args.api),
    },
    hint: `This started a real CI run for ${project} at ${commit || "the branch head"} (${buildEnv || "staging"}) on ${browsers.join(", ") || "the enabled browsers"}, and it counts against the workspace's build allowance. It takes minutes: follow it with extension_builds action:"list", then action:"get" or action:"logs" with buildId ${commit || "<the new build>"} once it shows up. Do not rebuild again to check on it.`,
    warnings: [stripped.length ? `The platform left out ${stripped.join(", ")}, which this plan does not build.` : null],
  });
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

const APPROVAL_CODES: Record<string, { status: string; name: string; next: string }> = {
  APPROVAL_PENDING: { status: APPROVAL_PENDING_STATUS, name: "ApprovalPending", next: "Approve it at its URL, then call again with the same approvalId." },
  APPROVAL_DENIED: { status: APPROVAL_REJECTED_STATUS, name: "ApprovalDenied", next: "It was denied, so nothing changed." },
  APPROVAL_EXPIRED: { status: APPROVAL_REJECTED_STATUS, name: "ApprovalExpired", next: "Request a fresh approval by calling again with no approvalId." },
  APPROVAL_NOT_FOUND: { status: APPROVAL_REJECTED_STATUS, name: "ApprovalUnverifiable", next: "Request a fresh approval by calling again with no approvalId." },
  APPROVAL_SCOPE_MISMATCH: { status: APPROVAL_REJECTED_STATUS, name: "ApprovalScopeMismatch", next: "That approval is for a different change; request a fresh one by calling again with no approvalId." },
  APPROVAL_CONSUMED: {
    status: APPROVAL_REJECTED_STATUS,
    name: "ApprovalConsumed",
    next: "The call that used it may already have changed the settings: read them with extension_workspace (action: \"settings\") first, and request a fresh approval only if the change is not there.",
  },
};

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
    reason: "A build command runs on the project's CI runners, so a workspace owner must approve this exact change first; the approval page shows the change as the platform computed it.",
    stateRead: 'extension_workspace (action: "settings") for build settings',
    refusalHint: (code) => (code === "NO_CHANGE" ? "The settings already read this way; nothing needs changing." : undefined),
  };

  if (approvalId) {
    const gate = await evaluateApproval({ ...gateInput, approvalId, enabled: true });
    if (gate.blocked) return gate.envelope;
  }

  const sent = await projectApiSend<Row>(api, "PUT", "settings/build", { buildSettings: merged, ...(approvalId ? { approvalId } : {}) });

  if (!sent.ok) {
    if (!approvalId && sent.code === "APPROVAL_REQUIRED") {
      const asked = isRow(sent.body) && isRow((sent.body as Row).approvalRequest) ? ((sent.body as Row).approvalRequest as Row) : {};
      const ours = actionFingerprint(SETTINGS_ACTION, scope);

      if (text(asked.fingerprint) && text(asked.fingerprint) !== ours) {
        return envelope({
          ok: false,
          command: COMMAND,
          status: "configure-refused",
          value: { action: "configure", settingsDigest: scope.settingsDigest },
          error: {
            code: "E_PLATFORM",
            name: "SettingsDigestMismatch",
            message: "The platform hashes this change differently from this server, so an approval of it could never be used. No approval was requested and nothing was changed.",
          },
        });
      }

      return requestApprovalAfterRefusal(gateInput);
    }

    const known = APPROVAL_CODES[sent.code];

    if (known) {
      return envelope({
        ok: false,
        command: COMMAND,
        status: known.status,
        value: { action: "configure", approvalId },
        error: {
          code: known.status === APPROVAL_PENDING_STATUS ? "E_APPROVAL_PENDING" : "E_APPROVAL_REJECTED",
          name: known.name,
          platformCode: sent.code,
          message: `${sent.message}. Nothing was changed by this call.`,
        },
        hint: known.next,
      });
    }

    return actRefusal(sent, "configure", api, args);
  }

  return envelope({
    ok: true,
    command: COMMAND,
    status: "configured",
    value: {
      action: "configure",
      project,
      buildSettings: merged,
      consoleUrl: consoleProjectUrl(api.ref, ConsoleProjectPage.projectSettings, args.api),
    },
    hint: `${project}'s build settings now read as buildSettings. The next build runs them: a push, or extension_builds action:"rebuild".`,
  });
}

export async function createChannel(args: ActArgs): Promise<string> {
  const name = text(args.channel);
  if (!name) return badRequest("create-channel", "ChannelInputError", "create-channel needs channel, the new channel's name. Nothing was created.");

  const opened = await openFor(args, "create-channel", { channel: name });
  if ("refused" in opened) return opened.refused;

  const api = opened.api;
  const body: Row = { name };
  if (text(args.description)) body.description = text(args.description);
  if (text(args.color)) body.color = text(args.color);

  const sent = await projectApiSend<Row>(api, "POST", "channels", body);
  const exists = !sent.ok && sent.status === 409;
  if (!sent.ok && !exists) return actRefusal(sent, "create-channel", api, args, { channel: name });

  const list = await projectApiGet<unknown[]>(api, "channels");
  const channels = list.ok && Array.isArray(list.json) ? list.json.filter(isRow) : [];
  const promote = `extension_release_promote (channel: "${name}", buildId: <a build>)`;

  return envelope({
    ok: true,
    command: COMMAND,
    status: exists ? "exists" : "created",
    value: {
      action: "create-channel",
      created: !exists,
      channel: sent.ok ? sent.json : channels.find((c) => text(c.name) === name || text(c.id) === name) ?? { name },
      channels,
    },
    hint: exists
      ? `${name} already exists, so nothing was created. Point it at a build with ${promote}.`
      : `${name} is a new release channel with no build yet. Point it at a build with ${promote}.`,
    warnings: [list.ok ? null : `The channel list could not be read (${list.message}).`],
  });
}
