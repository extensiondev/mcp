// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import crypto from "node:crypto";

import { envelope } from "../lib/envelope";
import { type ApprovalGateInput } from "../lib/approval-gate";
import { projectApiGet } from "../lib/project-api";
import { approvedSettingsWrite, UNCONFIRMED_RETRY_SECONDS, unconfirmedWriteSentence, type ReadBack, type UnconfirmedWrite } from "../lib/settings-write";
import { trackUrl } from "../lib/track-url";
import { COMMAND, actRefusal, badRequest, isRow, openFor, text, type ActArgs, type Row } from "./builds-acts";

const SETTINGS_ACTION = "extension_settings.build";
const BROWSERS = ["chrome", "edge", "firefox", "safari"] as const;
const FIELDS = ["enabled", "installCommand", "buildCommand", "outputDirectory"] as const;
const REQUIRED_BROWSERS = ["chrome", "edge", "firefox"] as const;

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

const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);

/* @invariant THE ANSWER IS WHAT THE PLATFORM STORED, NOT WHAT WAS SENT. The
 * platform fills an enabled browser's empty install, build and output
 * settings from the project's own pattern (ledger 155), so the settings this
 * server merged are not the settings saved. When the platform answers its
 * stored buildSettings, its change lines (a filled one ends "(defaulted)"),
 * the fields it filled and a per-browser note (what a Safari platform build
 * needs beyond these fields), they are passed through as they came; an older
 * platform that answers only ok leaves the merged settings and no changes.
 */
function recordedConfigure(json: Row): { buildSettings: Row | null; changes: string[] | null; defaulted: string[]; notes: Record<string, string> } {
  const notes: Record<string, string> = {};

  if (isRow(json.notes)) {
    for (const [browser, note] of Object.entries(json.notes)) if (typeof note === "string" && note.trim()) notes[browser] = note.trim();
  }

  return {
    buildSettings: isRow(json.buildSettings) ? json.buildSettings : null,
    changes: Array.isArray(json.changes) ? strings(json.changes) : null,
    defaulted: strings(json.defaulted),
    notes,
  };
}

function settingsHold(stored: Row, merged: Record<string, BrowserConfig>): boolean {
  return Object.entries(merged).every(([browser, config]) => {
    const kept = isRow(stored[browser]) ? (stored[browser] as Row) : {};

    return FIELDS.every((field) => config[field] === "" || kept[field] === config[field]);
  });
}

function unconfirmedConfigure(args: {
  unconfirmed: UnconfirmedWrite;
  sent: { status: number; code: string; message: string };
  project: string;
  merged: Record<string, BrowserConfig>;
  settingsPage: string;
}): string {
  const { unconfirmed, sent, project, merged, settingsPage } = args;

  if (unconfirmed.saved === "yes") {
    return envelope({
      ok: true,
      command: COMMAND,
      status: "build-configured",
      value: { action: "configure", project, buildSettings: unconfirmed.state ?? merged, trackUrl: settingsPage },
      hint: `${project}'s build settings now read as buildSettings: the platform answered ${sent.status} to the write, but the settings read back with the change in place, so nothing needs sending again. The next build runs them: extension_builds action:"rebuild" (no push needed; an uploaded project has no repository to push to), or a push to the build branch of a project built from a repository.`,
      warnings: [`${sent.message}; the change was saved anyway.`],
    });
  }

  const retry = unconfirmed.attempt < 2;

  return envelope({
    ok: false,
    command: COMMAND,
    status: "unavailable",
    value: {
      action: "configure",
      project,
      saved: unconfirmed.saved,
      attempt: unconfirmed.attempt,
      ...(retry ? { retryAfterSeconds: UNCONFIRMED_RETRY_SECONDS } : {}),
      trackUrl: settingsPage,
    },
    error: {
      code: "E_PLATFORM",
      name: "BuildsRefused",
      ...(sent.code ? { platformCode: sent.code } : {}),
      message: sent.message,
    },
    hint: unconfirmedWriteSentence({ what: "build settings", unconfirmed, page: settingsPage, pageWord: "console build settings page" }),
  });
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
  const settingsPage = trackUrl("build-settings", { workspace: api.ref.workspace, project: api.ref.project }, args.api);
  const approvalId = text(args.approvalId);

  const readBack = async (): Promise<ReadBack> => {
    const again = await projectApiGet<Row>(api, "settings/build");
    if (!again.ok || !isRow(again.json.buildSettings)) return { saved: "unknown" };

    return { saved: settingsHold(again.json.buildSettings, merged) ? "yes" : "no", state: again.json.buildSettings };
  };

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
    readBack,
  });

  if (!written.ok && written.unconfirmed) {
    return unconfirmedConfigure({ unconfirmed: written.unconfirmed, sent: written.sent, project, merged, settingsPage });
  }

  if (!written.ok) return written.out ?? actRefusal(written.sent, "configure", api, args);

  const gateLine = written.verdict === "plain" && !approvalId ? " This was a plain setting under your own token; no approval page was involved." : "";
  const recorded = recordedConfigure(written.json);
  const defaultedLine = recorded.defaulted.length
    ? ` The platform filled ${recorded.defaulted.join(", ")} from the project's own pattern, and changes marks each one (defaulted); pass a value to replace one.`
    : "";
  const noteLines = Object.values(recorded.notes).map((note) => ` ${note}`).join("");

  return envelope({
    ok: true,
    command: COMMAND,
    status: "build-configured",
    value: {
      action: "configure",
      project,
      buildSettings: recorded.buildSettings ?? merged,
      ...(recorded.changes ? { changes: recorded.changes } : {}),
      ...(recorded.defaulted.length ? { defaulted: recorded.defaulted } : {}),
      ...(Object.keys(recorded.notes).length ? { notes: recorded.notes } : {}),
      trackUrl: settingsPage,
    },
    hint: `${project}'s build settings now read as buildSettings.${gateLine}${defaultedLine}${noteLines} The next build runs them: extension_builds action:"rebuild" (no push needed; an uploaded project has no repository to push to), or a push to the build branch of a project built from a repository.`,
  });
}
