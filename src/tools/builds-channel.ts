// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { resolveCredential } from "../lib/credential-source";
import { envelope } from "../lib/envelope";
import { type ApprovalGateInput } from "../lib/approval-gate";
import { approvalVerdict } from "../lib/approval-policy";
import { approvedSettingsWrite } from "../lib/settings-write";
import { trackUrl } from "../lib/track-url";
import { COMMAND, actRefusal, badRequest, isRow, openFor, text, type ActArgs, type Row } from "./builds-acts";

export const CONFIGURE_CHANNEL = "configure-channel";
export const DELETE_CHANNEL = "delete-channel";
export const CONFIGURE_CHANNEL_ACTION = "extension_builds.configure-channel";
const DELETE_CHANNEL_ACTION = "extension_builds.delete-channel";

const PUBLIC_REASON = "A public channel opens its downloads to anyone with the link, which the ruling of 2026-10-23 keeps on the approve page: a workspace owner approves this exact change first, and the page shows it as the platform computed it.";
const PLATFORM_ASKED_REASON = "The platform asked a workspace owner to approve this exact change before it is saved; the approval page shows the change as the platform computed it.";

function hintFor(code: string): string | undefined {
  if (code === "NO_CHANGE") return "The channel already reads this way; nothing needs changing.";
  if (code === "PROJECT_IS_PUBLIC") return "Every channel of a public project is public, so a channel audience is not chosen while the project is public; extension_workspace action:\"set-visibility\" makes the project private first.";

  return undefined;
}

/* @invariant A CHANNEL'S FIELDS ARE PLAIN AND ITS PUBLIC AUDIENCE IS A
 * PERSON'S, BY THE POLICY TABLE. The description, the color and a private
 * audience are reversible and go out as one PATCH under the owner's own
 * token; only a public audience reads "approval" in approval-policy.ts, and
 * then the platform refuses the PATCH with the request to mint, which is
 * honored with the scope the platform named: the channel and the audience,
 * nothing else, so the owner reads exactly what opens. A delete is a console
 * act and never leaves this server.
 */
export async function configureChannel(args: ActArgs): Promise<string> {
  const name = text(args.channel).toLowerCase();
  if (!name) return badRequest(CONFIGURE_CHANNEL, "ChannelInputError", "configure-channel needs channel, the channel's name. Nothing was changed.");

  const audience = text(args.audience).toLowerCase();

  if (audience && audience !== "public" && audience !== "private") {
    return badRequest(CONFIGURE_CHANNEL, "ChannelInputError", `audience must be public or private, not ${text(args.audience)}. Nothing was changed.`, { channel: name });
  }

  const body: Row = {};
  if (audience) body.audience = audience;
  if (typeof args.description === "string") body.description = args.description.trim();
  if (text(args.color)) body.color = text(args.color);

  if (!Object.keys(body).length) {
    return badRequest(CONFIGURE_CHANNEL, "ChannelInputError", "configure-channel needs at least one of audience, description or color. Nothing was changed.", { channel: name });
  }

  const opened = await openFor(args, CONFIGURE_CHANNEL, { channel: name });
  if ("refused" in opened) return opened.refused;

  const api = opened.api;
  const project = `${api.ref.workspace}/${api.ref.project}`;
  const scope = { channel: name, ...(audience ? { audience } : {}) };
  const opens = approvalVerdict(CONFIGURE_CHANNEL_ACTION, { audience }) === "approval";
  const releasesPage = trackUrl("releases", { workspace: api.ref.workspace, project: api.ref.project, channel: name }, args.api);
  const stateRead = 'extension_release_status (include: ["releases"]) for the channel';
  const gate: ApprovalGateInput = {
    command: COMMAND,
    action: CONFIGURE_CHANNEL_ACTION,
    scope,
    description: opens ? `Open the ${name} channel of ${project} to anyone with the link.` : `Change the ${name} channel of ${project}.`,
    token: api.token,
    api: args.api,
    refusedStatus: "configure-channel-refused",
    reason: opens ? PUBLIC_REASON : PLATFORM_ASKED_REASON,
    stateRead,
    write: { audience },
    refusalHint: hintFor,
  };

  const written = await approvedSettingsWrite({
    api,
    method: "PATCH",
    route: `channels/${encodeURIComponent(name)}`,
    body,
    approvalId: text(args.approvalId),
    gate,
    mismatch: () =>
      envelope({
        ok: false,
        command: COMMAND,
        status: "configure-channel-refused",
        value: { action: CONFIGURE_CHANNEL, channel: name, scope },
        error: {
          code: "E_PLATFORM",
          name: "ChannelScopeMismatch",
          message: "The platform names this change differently from this server, so an approval of it could never be used. No approval was requested and nothing was changed.",
        },
      }),
    undone: "Nothing was changed by this call.",
    value: { action: CONFIGURE_CHANNEL, channel: name },
    next: { used: `The call that used it may already have changed the channel: read it with ${stateRead} first, and request a fresh approval only if the change is not there.` },
  });

  if (!written.ok) return written.out ?? actRefusal(written.sent, CONFIGURE_CHANNEL, api, args, { channel: name });

  const changes = Array.isArray(written.json.changes) ? written.json.changes.filter((line): line is string => typeof line === "string") : [];
  const given = text(written.json.audience).toLowerCase();
  const channel: Row = isRow(written.json) ? { ...written.json } : { name };
  delete channel.changes;
  const gateLine = written.verdict === "plain" && !text(args.approvalId) ? " This was a plain change under your own token; no approval page was involved." : "";
  const audienceLine = given === "public" ? ` ${name} is public: its channel link opens for anyone.` : given === "private" ? ` ${name} is private: workspace members and build links only.` : "";

  return envelope({
    ok: true,
    command: COMMAND,
    status: "channel-configured",
    value: { action: CONFIGURE_CHANNEL, project, channel, changes, trackUrl: releasesPage },
    hint: `${project}'s ${name} channel now reads as channel${changes.length ? ` (${changes.join("; ")})` : ""}.${audienceLine}${gateLine} The Releases page is ${releasesPage}.`,
  });
}

/* @invariant A CHANNEL DELETE NEVER LEAVES THIS SERVER. The policy table
 * reads it as a console act (ruling 2026-10-23: deletes stay console only),
 * so the answer is the console page where a workspace owner removes the
 * channel, and nothing is sent; the table row is what this function asserts.
 */
export function deleteChannelConsoleOnly(args: ActArgs): string {
  const name = text(args.channel).toLowerCase();
  const verdict = approvalVerdict(DELETE_CHANNEL_ACTION);
  const ref = resolveCredential({ project: args.project, api: args.api }).ref;
  const channelsPage = trackUrl("channels", { workspace: ref?.workspace, project: ref?.project }, args.api);
  const say = `Deleting a channel is a person's act in the extension.dev console: a workspace owner removes ${name || "the channel"} from the Channels section of the project settings, ${channelsPage}. Nothing was sent.`;

  return envelope({
    ok: false,
    command: COMMAND,
    status: "console-only",
    value: { action: DELETE_CHANNEL, ...(name ? { channel: name } : {}), verdict, trackUrl: channelsPage, sayToPerson: say },
    error: {
      code: "E_CONSOLE_ONLY",
      name: "ChannelDeleteConsoleOnly",
      message: `${say} The channel's builds and their links stay as they are until a person decides there.`,
    },
    hint: say,
  });
}
