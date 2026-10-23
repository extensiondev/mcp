// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { ConsoleProjectPage } from "@extension.dev/urls/paths";

import { approvalGateEnabled, evaluateApproval, requestApprovalAfterRefusal } from "../lib/approval-gate";
import { LAST_USE_NOTE, listBuildLinks, parseBuildLinkRef, revokeBuildLink } from "../lib/build-links";
import { envelope, isEnvelope, type Envelope } from "../lib/envelope";
import {
  openProjectApi,
  projectApiOpenFailure,
  projectApiReadFailure,
  type ProjectApi,
} from "../lib/project-api";
import { consoleProjectUrl } from "../lib/registry";
import { isRow, text } from "../lib/ship-act";

const COMMAND = "extension_shares";
const REVOKE_ACTION = "extension_shares.revoke";

type Row = Record<string, unknown>;

export interface BuildLinkArgs {
  tokenId?: string;
  url?: string;
  approvalId?: string;
  status?: string;
  project?: string;
  api?: string;
}

export function namesBuildLink(args: { kind?: string; tokenId?: string; url?: string }): boolean {
  if (text(args.kind) === "build-link") return true;
  if (text(args.tokenId)) return true;

  const url = text(args.url);

  return Boolean(url) && url.includes("share=") && parseBuildLinkRef(url) !== null;
}

async function openLinks(args: BuildLinkArgs, action: string): Promise<{ api: ProjectApi } | { out: string }> {
  const opened = await openProjectApi({ command: COMMAND, project: text(args.project) || undefined, api: args.api });

  if (!opened.ok) {
    return { out: projectApiOpenFailure(COMMAND, opened, { api: args.api, name: "BuildLinks", value: { action, kind: "build-link" } }) };
  }

  return { api: opened.api };
}

function projectOf(api: ProjectApi): string {
  return `${api.ref.workspace}/${api.ref.project}`;
}

export async function listBuildLinkShares(args: BuildLinkArgs): Promise<string> {
  const opened = await openLinks(args, "list");
  if ("out" in opened) return opened.out;

  const api = opened.api;
  const read = await listBuildLinks(api);
  const where = { action: "list", kind: "build-link", project: projectOf(api) };

  if (!read.ok) {
    return projectApiReadFailure(COMMAND, read, {
      api: args.api,
      name: "BuildLinks",
      value: where,
      context: { workspace: api.ref.workspace, project: projectOf(api) },
    });
  }

  const liveOnly = text(args.status) === "live";
  const links = liveOnly ? read.json.filter((row) => row.live) : read.json;
  const live = links.filter((row) => row.live).length;
  const consoleUrl = consoleProjectUrl(api.ref, ConsoleProjectPage.projectSettingsSection("share-links"), args.api);

  return envelope({
    ok: true,
    command: COMMAND,
    status: "listed",
    value: {
      ...where,
      server: { listed: true, count: links.length, live, liveOnly },
      buildLinks: links,
      consoleUrl,
    },
    hint: `${live} of ${links.length} build link${links.length === 1 ? "" : "s"} still open${
      liveOnly ? " (live only)" : ""
    }. A build link opens one build's page with its downloads and run command for anyone holding it; extension_publish mints one, and action: "revoke" with kind: "build-link" and its tokenId (or the link itself) kills it after a workspace member approves. The console lists the same links at ${consoleUrl}.`,
    warnings: [LAST_USE_NOTE],
  });
}

export async function revokeBuildLinkShare(args: BuildLinkArgs): Promise<string> {
  const supplied = text(args.tokenId) || text(args.url);
  const tokenId = parseBuildLinkRef(supplied);

  if (!tokenId) {
    return envelope({
      ok: false,
      command: COMMAND,
      status: "bad-request",
      value: { action: "revoke", kind: "build-link", ...(supplied ? { ref: supplied } : {}) },
      error: {
        code: "E_BAD_REQUEST",
        name: "SharesInputError",
        message: supplied
          ? `No build link id could be read out of ${JSON.stringify(supplied.length > 200 ? `${supplied.slice(0, 200)}...` : supplied)}; a build link id is the tokenId action: "list" (kind: "build-link") answers, or the link itself with its share= part. Nothing was sent to the platform.`
          : 'Nothing to revoke. Pass tokenId (from action: "list" with kind: "build-link") or url (the build link itself).',
      },
    });
  }

  const opened = await openLinks(args, "revoke");
  if ("out" in opened) return opened.out;

  const api = opened.api;
  const where = { action: "revoke", kind: "build-link", tokenId, project: projectOf(api) };
  const gateInput = {
    command: COMMAND,
    action: REVOKE_ACTION,
    scope: { tokenId },
    description: `Permanently revoke build link ${tokenId}, killing it for everyone holding it with no way to restore it.`,
    approvalId: text(args.approvalId) || undefined,
    token: api.token,
    api: args.api,
    refusedStatus: "revoke-failed",
    irreversible: true,
  };
  const gate = await evaluateApproval({ ...gateInput, enabled: approvalGateEnabled(true) });
  if (gate.blocked) return gate.envelope;

  const result = await revokeBuildLink(api, tokenId, gateInput.approvalId);

  if (!result.ok) {
    if (!gateInput.approvalId && result.status === 403 && result.code === "APPROVAL_REQUIRED") {
      return requestApprovalAfterRefusal(gateInput);
    }

    return projectApiReadFailure(COMMAND, result, {
      api: args.api,
      name: "BuildLinks",
      value: where,
      context: { workspace: api.ref.workspace, project: projectOf(api) },
    });
  }

  return envelope({
    ok: true,
    command: COMMAND,
    status: "revoked",
    value: { ...where, revoked: result.json.revoked, alreadyRevoked: result.json.alreadyRevoked },
    warnings: [
      result.json.alreadyRevoked
        ? "The platform had already revoked this build link; nothing changed."
        : "The platform reports the build link revoked: it no longer opens for anyone holding it, and the registry refuses it once the revocation index is published. Minting the same build again with extension_publish makes a different link.",
    ],
  });
}

export function withBuildLinks(previews: string, buildLinks: string): string {
  let base: unknown;
  let extra: unknown;

  try {
    base = JSON.parse(previews);
    extra = JSON.parse(buildLinks);
  } catch {
    return previews;
  }

  if (!isEnvelope(base) || !isEnvelope(extra)) return previews;

  const frame = base as Envelope & { hint?: string };
  const added = extra as Envelope & { hint?: string };
  const value = isRow(frame.value) ? frame.value : {};
  const addedValue = isRow(added.value) ? added.value : {};
  const links = added.ok && Array.isArray(addedValue.buildLinks) ? addedValue.buildLinks : null;
  const message = text((added.error as Row | undefined)?.message) || text(added.hint) || added.status;

  return envelope({
    ok: frame.ok,
    command: frame.command,
    status: frame.status,
    value: {
      ...value,
      kind: "both",
      ...(links ? { buildLinks: links, buildLinksConsoleUrl: addedValue.consoleUrl } : { buildLinks: null }),
    },
    error: frame.error ?? undefined,
    hint: links
      ? `${text(frame.hint)} ${text(added.hint)}`.trim()
      : text(frame.hint),
    warnings: [
      ...(Array.isArray(frame.warnings) ? frame.warnings : []),
      links ? LAST_USE_NOTE : `The build links could not be listed (${message}), so buildLinks is null: unknown, not none.`,
    ],
  });
}
