// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { ConsoleProjectPage } from "@extension.dev/urls/paths";

import { consoleProjectUrl } from "../lib/registry";
import { envelope } from "../lib/envelope";
import { APPROVAL_REQUIRED_STATUS } from "../lib/approval-outcome";
import { approvalVerdict } from "../lib/approval-policy";
import { projectApiGet, projectApiSend, type ProjectApi } from "../lib/project-api";
import { trackUrl } from "../lib/track-url";
import { COMMAND, actRefusal, badRequest, isRow, openFor, text, type ActArgs, type Row } from "./builds-acts";

const CHANNEL_ACTION = "extension_builds.create-channel";

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
