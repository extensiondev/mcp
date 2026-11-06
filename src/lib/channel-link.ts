// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { userlandChannelUrl } from "@extension.dev/urls/userland";

import { REAL_BROWSERS } from "./common-schema";
import { mcpOrigins } from "./origins";
import { fetchRegistryJson, parseChannels, registryFileUrl, type ChannelEntry, type ProjectRef } from "./registry";

export const CHANNEL_LINK_ADVICE =
  "On a public project, or a public channel, send testers the channel link: it always opens the channel's newest build and never expires. A build link opens one build, and on a private project it expires.";

export const CHANNEL_LINK_WITHHELD =
  "This project is private in its extension.dev project settings, so no channel link is offered: a channel link opens the channel's newest build for anyone who has it, and extension.dev shows a private project's builds only to its workspace members. Send testers the build link from extension_publish instead: it opens one build and expires on the date its answer gives. For one address that keeps opening the newest build, such as a link on the project's own website, call extension_publish with channel: 'preview' (or another release channel): it is a share link scoped to that one channel, it follows the channel's newest build, and it expires like a build link. For a channel link that never expires, a workspace owner or admin makes the project public in the console Settings, Visibility section, or, once it ships, makes one channel public with the channel Audience control on the console Releases page.";

const BROWSER_CHANNEL = new RegExp(`^(${REAL_BROWSERS.join("|")})-(.+)$`);

export function splitChannelKey(key: string): { browser?: string; channel: string } {
  const match = BROWSER_CHANNEL.exec(key);

  return match ? { browser: match[1], channel: match[2] } : { channel: key };
}

export const ENVIRONMENT_CHANNELS: readonly string[] = ["preview"];

export type ChannelSource = "environment" | "promotion";

export function channelSource(key: string): ChannelSource {
  return ENVIRONMENT_CHANNELS.includes(splitChannelKey(key).channel.toLowerCase()) ? "environment" : "promotion";
}

export function channelFillSentence(name: string): string {
  return channelSource(name) === "environment"
    ? `${name} fills by environment: the next successful build lands there with no promotion, so build once (push a commit, or extension_builds action:'rebuild'), then publish its channel link.`
    : `Promote a successful build to ${name} with extension_release_promote, then publish its channel link.`;
}

export function channelUrl(
  ref: ProjectRef | null,
  key: string,
  apiHint?: string,
  options: { perBrowser?: boolean } = {},
): string {
  if (!ref) return "";

  const { browser, channel } = splitChannelKey(key);

  try {
    return userlandChannelUrl(ref, channel, {
      base: mcpOrigins(apiHint).userland,
      ...(options.perBrowser && browser ? { browser } : {}),
    });
  } catch {
    return "";
  }
}

const VISIBILITY_UNREAD =
  "The project's visibility in its extension.dev project settings could not be read, so no channel link is offered: a channel link opens for anyone only on a public project or a public channel, since extension.dev shows a private project's builds only to its workspace members. Send testers the build link from extension_publish, which opens one build and, on a private project, expires.";

export function channelLinkFields(
  ref: ProjectRef | null,
  visibility: unknown,
  key: string | null,
  apiHint?: string,
): Record<string, string> {
  const read = String(visibility ?? "").toLowerCase();

  if (read !== "public") {
    return { channelUrlWithheld: read === "" || read === "unknown" ? VISIBILITY_UNREAD : CHANNEL_LINK_WITHHELD };
  }

  const url = key ? channelUrl(ref, key, apiHint) : "";

  return url ? { channelUrl: url } : {};
}

export async function readChannels(ref: ProjectRef, apiHint?: string): Promise<ChannelEntry[] | null> {
  const read = await fetchRegistryJson(registryFileUrl(ref, "channels.json", apiHint), fetch, { ref, api: apiHint });

  return read.ok ? parseChannels(read.json) : null;
}

export async function readVisibility(ref: ProjectRef, apiHint?: string): Promise<string | null> {
  const read = await fetchRegistryJson(registryFileUrl(ref, "meta.json", apiHint), fetch, { ref, api: apiHint });
  const visibility = read.ok ? (read.json as Record<string, unknown> | null)?.visibility : null;

  return typeof visibility === "string" ? visibility.toLowerCase() : null;
}

export const CHANNEL_NAME_INPUT = /^[a-z0-9][a-z0-9-]{0,40}$/;

export interface ChannelServes {
  channel: string;
  newest: string;
  builds: string[];
}

export function channelServesOf(value: unknown): ChannelServes | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;

  const row = value as Record<string, unknown>;
  const builds = Array.isArray(row.builds) ? row.builds.filter((sha): sha is string => typeof sha === "string" && sha !== "") : [];
  const channel = typeof row.channel === "string" ? row.channel : "";
  const newest = typeof row.newest === "string" && row.newest ? row.newest : (builds[0] ?? "");

  return channel && newest ? { channel, newest, builds } : null;
}

export function channelShareNote(serves: ChannelServes, until: string | null): string {
  const before = serves.builds.filter((sha) => sha !== serves.newest).length;
  const history = before === 0 ? "" : `, and the ${before} build${before === 1 ? "" : "s"} it served before`;
  const end = until
    ? ` It stops working on ${until}; renew before ${until} with extension_publish (channel: '${serves.channel}'), which mints a new address, so a site that links to it changes once per window rather than once per build.`
    : "";

  return `This link follows channel ${serves.channel}: it opens the newest build there (${serves.newest.slice(0, 7)} now), every build ${serves.channel} serves from now${history}, and nothing outside ${serves.channel}.${end} Revoking it on the console Share links page closes it for everyone.`;
}

export function channelServing(channels: ChannelEntry[], sha: string): string | null {
  const wanted = sha.toLowerCase();
  const serving = channels.filter((c) => {
    const pinned = (c.sha || c.buildId || "").toLowerCase();

    return pinned !== "" && (pinned.startsWith(wanted) || wanted.startsWith(pinned));
  });
  const names = serving.map((c) => splitChannelKey(c.channel).channel);

  return names.includes("stable") ? "stable" : (names[0] ?? null);
}
