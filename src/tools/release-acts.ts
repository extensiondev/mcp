// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import crypto from "node:crypto";

import { ConsoleProjectPage } from "@extension.dev/urls/paths";

import { envelope } from "../lib/envelope";
import { consoleProjectUrl } from "../lib/registry";
import { badShipRequest, isRow, openShipApi, runShipAct, text } from "../lib/ship-act";

import type { ApprovalScope } from "../lib/approval-gate";

const COMMAND = "extension_release_promote";
const LEVELS = ["patch", "minor", "major"] as const;
const NOTES_LIMIT = 10_000;

export interface ReleaseActArgs {
  action?: string;
  level?: string;
  version?: string;
  channel?: string;
  releaseNotes?: string;
  approvalId?: string;
  project?: string;
  api?: string;
}

/* @invariant THE CUT SCOPE IS REBUILT HERE THE WAY THE PLATFORM REBUILDS IT.
 * level defaults to patch, version and channel are sent trimmed (channel
 * lowercased), and the pull request text is a sha256 over the JSON of
 * { notes, dashboardUrl } with notes trimmed and cut at 10000 characters and
 * no dashboardUrl sent, absent when the notes are empty. An approval request
 * whose scope differs from this one is not shown to anybody.
 */
export function cutScope(args: ReleaseActArgs): { body: Record<string, string>; scope: ApprovalScope } {
  const level = (LEVELS as readonly string[]).includes(text(args.level)) ? text(args.level) : "patch";
  const version = text(args.version);
  const channel = text(args.channel).toLowerCase();
  const notes = String(args.releaseNotes ?? "").trim().slice(0, NOTES_LIMIT);
  const digest = notes ? crypto.createHash("sha256").update(JSON.stringify({ notes, dashboardUrl: "" })).digest("hex") : "";

  return {
    body: { level, ...(version ? { version } : {}), ...(channel ? { channel } : {}), ...(notes ? { notes } : {}) },
    scope: { level, ...(version ? { version } : {}), ...(channel ? { channel } : {}), ...(digest ? { prTextDigest: digest } : {}) },
  };
}

function sameScope(a: ApprovalScope, b: ApprovalScope): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);

  return [...keys].every((key) => String(a[key] ?? "") === String(b[key] ?? ""));
}

const statusRead = (args: ReleaseActArgs, include: string) =>
  `extension_release_status (include: ["${include}"]${args.project ? `, project: "${args.project}"` : ""})`;

export async function cut(args: ReleaseActArgs): Promise<string> {
  if (args.level !== undefined && !(LEVELS as readonly string[]).includes(text(args.level))) {
    return badShipRequest(COMMAND, "cut", "CutInputError", `level must be ${LEVELS.join(", ")}; got "${args.level}". Nothing was sent.`);
  }

  const { body, scope } = cutScope(args);
  const opened = await openShipApi(COMMAND, args, { action: "cut" });
  if ("refused" in opened) return opened.refused;

  const api = opened.api;
  const project = `${api.ref.workspace}/${api.ref.project}`;
  const bump = scope.version ? `to version ${scope.version}` : `by one ${scope.level} version`;
  const ran = await runShipAct(
    {
      command: COMMAND,
      act: "cut",
      action: "extension_release.cut",
      route: "releases/cut",
      body,
      approvalId: args.approvalId,
      description: `Open a release pull request for ${project} that bumps the extension's manifest ${bump}.`,
      reason: "It writes a branch, a commit and a pull request into the project's source repository, so a workspace owner approves this exact cut first; the approval page describes it as the platform read it.",
      stateRead: `${statusRead(args, "history")} for the open release pull request`,
      scopeFits: (asked) => sameScope(asked, scope),
      project: args.project,
      apiHint: args.api,
      value: { level: scope.level, ...(scope.channel ? { channel: scope.channel } : {}) },
    },
    api,
  );

  if (!ran.ok) return ran.out;

  const json = ran.json;
  const manual = text(json.mode) === "manual";

  return envelope({
    ok: true,
    command: COMMAND,
    status: manual ? "cut-manual" : "cut",
    value: { action: "cut", project, ...json, releasesPageUrl: consoleProjectUrl(api.ref, ConsoleProjectPage.releases, args.api) },
    hint: manual
      ? `The platform could not open the pull request itself${text(json.degradedReason) ? ` (${text(json.degradedReason)})` : ""}. ${text(json.instructions)}`
      : `${text(json.instructions) || `Pull request ${text(json.prUrl)} is open.`} Its merge builds the new version${json.autoRelease === true ? " and releases it to the channel it is armed for" : ""}; ${statusRead(args, "history")} follows it.`,
  });
}

export async function rollback(args: ReleaseActArgs): Promise<string> {
  const channel = text(args.channel).toLowerCase();

  if (!channel) {
    return badShipRequest(COMMAND, "rollback", "RollbackInputError", "rollback needs channel, the release channel to return to its previous build. Nothing was sent.");
  }

  const opened = await openShipApi(COMMAND, args, { action: "rollback", channel });
  if ("refused" in opened) return opened.refused;

  const api = opened.api;
  const project = `${api.ref.workspace}/${api.ref.project}`;
  const ran = await runShipAct(
    {
      command: COMMAND,
      act: "rollback",
      action: "extension_release.rollback",
      route: `releases/${encodeURIComponent(channel)}/rollback`,
      body: {},
      approvalId: args.approvalId,
      description: `Roll the ${channel} channel of ${project} back to the build it served before.`,
      reason: "Everyone on the channel gets the earlier build, so a workspace owner approves this exact rollback first; the approval names the build the platform resolved, and a history that moves before the approval is used refuses it.",
      stateRead: statusRead(args, "releases"),
      scopeFits: (asked) => text(asked.channel) === channel && Boolean(text(asked.buildId)),
      project: args.project,
      apiHint: args.api,
      value: { channel },
    },
    api,
  );

  if (!ran.ok) return ran.out;

  const json = ran.json;
  const failed = Array.isArray(json.failedBrowsers) ? json.failedBrowsers.map(text).filter(Boolean) : [];
  const done = Array.isArray(json.rolledBackBrowsers) ? json.rolledBackBrowsers.map(text).filter(Boolean) : [];
  const degraded = text(json.status) === "degraded";
  const build = text(json.build);

  return envelope({
    ok: true,
    command: COMMAND,
    status: failed.length || degraded ? "rolled-back-partially" : "rolled-back",
    value: { action: "rollback", project, ...(isRow(json) ? json : {}) },
    hint: `The release workflow was dispatched to return ${channel} to build ${build} for ${done.join(", ") || "no browser"}. It lands when that workflow finishes; ${statusRead(args, "releases")} reads what ${channel} serves.${failed.length || degraded ? " Do not repeat the whole rollback; read the warnings." : ""}`,
    warnings: [
      failed.length ? `The dispatch failed for ${failed.join(", ")}, so those browsers still serve the later build.` : null,
      degraded ? `The channel pointer file was not re-pinned to ${build}, so registry reads may still name the later build until the next release.` : null,
    ],
  });
}
