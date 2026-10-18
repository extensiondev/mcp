// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { consoleProjectUrl } from "./console-urls";

import type { ProjectRef } from "./registry";

export const VISIBILITY_SOURCE = "extension.dev project settings";

export interface PublishLink {
  kind: "build" | "channel";
  url: string;
  expiresAt: string | null;
  pointsAt: string;
  audience: string;
  scope: string | null;
  renewBy?: { tool: "extension_publish"; args: Record<string, unknown> };
}

export interface LinkInput {
  data: Record<string, unknown>;
  channel: string | null;
  ref: ProjectRef | null;
  ttlHours?: number;
  project?: string;
  api?: string;
}

export function expiryOf(value: unknown): { iso: string | null; epoch: number | null } {
  const ms =
    typeof value === "number" && Number.isFinite(value)
      ? value > 1e12
        ? value
        : value * 1000
      : typeof value === "string" && value.trim() !== ""
        ? Date.parse(value)
        : Number.NaN;

  if (!Number.isFinite(ms)) return { iso: null, epoch: null };

  return { iso: new Date(ms).toISOString(), epoch: Math.floor(ms / 1000) };
}

export function spokenDate(iso: string): string {
  const at = new Date(iso);
  const day = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "long", day: "numeric", year: "numeric" }).format(at);
  const time = `${String(at.getUTCHours()).padStart(2, "0")}:${String(at.getUTCMinutes()).padStart(2, "0")}`;

  return `${day} at ${time} UTC`;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function platformLink(value: unknown): PublishLink | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;

  const row = value as Record<string, unknown>;

  if ((row.kind !== "build" && row.kind !== "channel") || !text(row.url)) return null;

  return {
    ...(row as unknown as PublishLink),
    expiresAt: expiryOf(row.expiresAt).iso,
    scope: typeof row.scope === "string" ? row.scope : null,
  };
}

function channelOf(link: PublishLink, fallback: string | null): string {
  return /^latest in (.+)$/.exec(link.pointsAt)?.[1] ?? fallback ?? "release";
}

function tellThemFor(link: PublishLink, data: Record<string, unknown>, fallbackChannel: string | null): string {
  if (link.kind === "channel") {
    return `Here is the channel link. It always opens the newest ${channelOf(link, fallbackChannel)} build.`;
  }

  const version = text(data.version);
  const sha = text(data.buildSha);
  const subject = version ? ` for version ${version}` : sha ? ` for build ${sha.slice(0, 7)}` : "";
  const until = link.expiresAt ? ` until ${spokenDate(link.expiresAt)}` : "";

  return `Here is the build link${subject}. Anyone who has it can open it${until}, and it always shows this build.`;
}

export function publishLinkFields(input: LinkInput): Record<string, unknown> {
  const { data, channel, ref } = input;
  const isPublic = text(data.visibility).toLowerCase() === "public";
  const sha = text(data.buildSha);
  const shareUrl = text(data.shareUrl);
  const channelUrl = text(data.channelUrl);
  const expiry = isPublic ? { iso: null, epoch: null } : expiryOf(data.expiresAt);
  const answeredTtl = typeof data.ttlHours === "number" ? data.ttlHours : null;
  const requestedTtl = input.ttlHours ?? null;
  const renewBy = isPublic
    ? undefined
    : {
        tool: "extension_publish" as const,
        args: {
          ...(input.project ? { project: input.project } : {}),
          ...(sha ? { buildSha: sha } : {}),
          ttlHours: answeredTtl ?? requestedTtl ?? 168,
        },
      };
  const buildLink: PublishLink = {
    kind: "build",
    url: shareUrl,
    expiresAt: expiry.iso,
    pointsAt: "this build",
    audience: isPublic ? "public" : "anyone with the link",
    scope: isPublic || !sha ? null : `build:${sha}`,
    ...(renewBy ? { renewBy } : {}),
  };
  const channelLink: PublishLink | null =
    isPublic && channelUrl
      ? { kind: "channel", url: channelUrl, expiresAt: null, pointsAt: `latest in ${channel ?? "release"}`, audience: "public", scope: null }
      : null;
  const fromPlatform = platformLink(data.link);
  const link: PublishLink = fromPlatform
    ? { ...fromPlatform, ...(renewBy && fromPlatform.kind === "build" && !fromPlatform.renewBy ? { renewBy } : {}) }
    : (channelLink ?? buildLink);
  const links = isPublic
    ? [link.kind === "build" ? link : buildLink, link.kind === "channel" ? link : channelLink].filter(
        (row): row is PublishLink => Boolean(row && row.url),
      )
    : [link];
  const send = links.find((row) => row.kind === "channel") ?? link;
  const platformVisibility =
    data.projectVisibility && typeof data.projectVisibility === "object" && !Array.isArray(data.projectVisibility)
      ? (data.projectVisibility as Record<string, unknown>)
      : {};
  const makeEvergreen = isPublic
    ? null
    : {
        say: "For a channel link that never expires, a workspace owner or admin makes the project public in the console Settings, Visibility section, or, once it ships, makes one channel public with the channel Audience control on the console Releases page.",
        settingsUrl: consoleProjectUrl(ref, "settings/visibility", input.api),
        releasesUrl: consoleProjectUrl(ref, "releases", input.api),
      };

  return {
    link,
    links,
    tellThem: tellThemFor(send, data, channel),
    sendUrl: send.url,
    expiresAt: expiry.iso,
    ...(expiry.epoch != null ? { expiresAtEpoch: expiry.epoch } : {}),
    ...(isPublic
      ? {}
      : {
          ttlHoursRequested: requestedTtl,
          clamped: requestedTtl != null && answeredTtl != null && answeredTtl < requestedTtl,
        }),
    projectVisibility: {
      ...platformVisibility,
      value: text(platformVisibility.value) || text(data.visibility) || "unknown",
      source: VISIBILITY_SOURCE,
      notFrom: "the GitHub repository",
      ...(makeEvergreen ? { makeEvergreen } : {}),
    },
  };
}
