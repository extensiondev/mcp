// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { consoleProjectUrl } from "./console-urls";
import { GRANT_QUERY, REGISTRY_TOKEN_QUERY } from "./package-address";

import type { ProjectRef } from "./registry";

export const VISIBILITY_SOURCE = "extension.dev project settings";

export interface PublishLink {
  kind: "build" | "channel";
  url: string;
  id: string | null;
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

export function expiryOf(value: unknown): {
  iso: string | null;
  epoch: number | null;
} {
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
  const day = new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    month: "long",
    day: "numeric",
    year: "numeric",
  }).format(at);
  const time = `${String(at.getUTCHours()).padStart(2, "0")}:${String(at.getUTCMinutes()).padStart(2, "0")}`;

  return `${day} at ${time} UTC`;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function platformLink(value: unknown): PublishLink | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;

  const row = value as Record<string, unknown>;

  if ((row.kind !== "build" && row.kind !== "channel") || !text(row.url))
    {return null;}

  return {
    ...(row as unknown as PublishLink),
    id: text(row.id) || null,
    expiresAt: expiryOf(row.expiresAt).iso,
    scope: typeof row.scope === "string" ? row.scope : null,
  };
}

function channelOf(link: PublishLink, fallback: string | null): string {
  return /^latest in (.+)$/.exec(link.pointsAt)?.[1] ?? fallback ?? "release";
}

export function nameOf(
  data: Record<string, unknown>,
  ref: ProjectRef | null,
): string {
  return (
    text(data.extensionName) ||
    text(data.projectName) ||
    text(data.displayName) ||
    text(data.name) ||
    ref?.project ||
    "the extension"
  );
}

export function nameMismatchNote(
  data: Record<string, unknown>,
  settingsUrl: string | null,
): string | null {
  const extensionName = text(data.extensionName);
  const projectName = text(data.projectName);

  if (!extensionName || !projectName || extensionName === projectName)
    {return null;}

  return `The build's manifest names the extension "${extensionName}" while the project's display name on extension.dev is "${projectName}"; the tester message uses the manifest name. Change the display name in the console's project settings${settingsUrl ? ` (${settingsUrl})` : ""}; the MCP reads those settings but does not write them.`;
}

export function pageLine(
  link: PublishLink,
  name: string,
  fallbackChannel: string | null,
): string {
  const lead = `Here is ${name} to try: ${link.url}.`;

  if (link.kind === "channel")
    {return `${lead} It always opens the newest ${channelOf(link, fallbackChannel)} build.`;}

  return link.expiresAt
    ? `${lead} It works until ${spokenDate(link.expiresAt)}.`
    : lead;
}

const SHELL_SPECIAL = /[\s&;|<>()$`'"\\*?[\]{}!]/;

export function shellUrl(url: string): string {
  return SHELL_SPECIAL.test(url) ? `"${url}"` : url;
}

export interface RunCommand {
  browser: string;
  url: string;
}

export function runCommandsOf(commands: Array<[string, string]>): RunCommand[] {
  return commands
    .map(([browser, command]) => {
      const raw =
        /^npx -y extension@latest preview\s+(\S+)/.exec(command)?.[1] ?? "";

      return { browser, url: raw.replace(/^["']|["']$/g, "") };
    })
    .filter((row) => row.url !== "");
}

export function carriesShareToken(commands: RunCommand[]): boolean {
  return commands.some((row) => GRANT_QUERY.test(row.url));
}

export function carriesRegistryToken(commands: RunCommand[]): boolean {
  return commands.some((row) => REGISTRY_TOKEN_QUERY.test(row.url));
}

function titled(browser: string): string {
  return browser ? browser[0].toUpperCase() + browser.slice(1) : browser;
}

function joined(names: string[]): string {
  return names.length <= 1
    ? names.join("")
    : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

export function firstRun(
  commands: RunCommand[],
): { run: RunCommand; others: string[] } | null {
  const run =
    commands.find((row) => row.browser.toLowerCase() === "chrome") ??
    commands[0];

  if (!run) return null;

  return {
    run,
    others: commands
      .filter((row) => row !== run)
      .map((row) => titled(row.browser)),
  };
}

export function runText(run: RunCommand): string {
  return `\`npx -y extension@latest preview ${shellUrl(run.url)} --browser=${run.browser}\``;
}

export function heldRunLine(commands: RunCommand[]): string {
  const first = firstRun(commands);

  if (!first)
    {return "The page opens once extension.dev opens; this build has no run command to use until then.";}

  const swap = first.others.length
    ? ` (${joined(first.others)}: swap the browser name twice)`
    : "";

  return `The page opens once extension.dev opens; until then run ${runText(first.run)}${swap}.`;
}

export function longHeldLines(
  name: string,
  link: PublishLink,
  commands: RunCommand[],
): string | null {
  const first = firstRun(commands);

  if (!first) return null;

  const until = link.expiresAt
    ? ` It works until ${spokenDate(link.expiresAt)}.`
    : "";
  const ask = first.others.length
    ? `\nAsk me for ${first.others.join(" or ")}.`
    : "";

  return `Here is ${name} to try: run ${runText(first.run)}.${until}${ask}`;
}

export type LinkFields = Record<string, unknown> & {
  sendUrl: string;
  pageLine: string;
  name: string;
  send: PublishLink;
};

export function publishLinkFields(input: LinkInput): LinkFields {
  const { data, channel, ref } = input;
  const isPublic = text(data.visibility).toLowerCase() === "public";
  const sha = text(data.buildSha);
  const shareUrl = text(data.shareUrl);
  const channelUrl = text(data.channelUrl);
  const expiry = isPublic
    ? { iso: null, epoch: null }
    : expiryOf(data.expiresAt);
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
    id: null,
    expiresAt: expiry.iso,
    pointsAt: "this build",
    audience: isPublic ? "public" : "anyone with the link",
    scope: isPublic || !sha ? null : `build:${sha}`,
    ...(renewBy ? { renewBy } : {}),
  };
  const channelLink: PublishLink | null =
    isPublic && channelUrl
      ? {
          kind: "channel",
          url: channelUrl,
          id: null,
          expiresAt: null,
          pointsAt: `latest in ${channel ?? "release"}`,
          audience: "public",
          scope: null,
        }
      : null;
  const fromPlatform = platformLink(data.link);
  const link: PublishLink = fromPlatform
    ? {
        ...fromPlatform,
        ...(renewBy && fromPlatform.kind === "build" && !fromPlatform.renewBy
          ? { renewBy }
          : {}),
      }
    : (channelLink ?? buildLink);
  const name = nameOf(data, ref);
  const links = isPublic
    ? [
        link.kind === "build" ? link : buildLink,
        link.kind === "channel" ? link : channelLink,
      ].filter((row): row is PublishLink => Boolean(row && row.url))
    : [link];
  const send = links.find((row) => row.kind === "channel") ?? link;
  const platformVisibility =
    data.projectVisibility &&
    typeof data.projectVisibility === "object" &&
    !Array.isArray(data.projectVisibility)
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
    tellThem: pageLine(send, name, channel),
    pageLine: pageLine(send, name, channel),
    name,
    send,
    sendUrl: send.url,
    expiresAt: expiry.iso,
    ...(expiry.epoch != null ? { expiresAtEpoch: expiry.epoch } : {}),
    ...(isPublic
      ? {}
      : {
          ttlHoursRequested: requestedTtl,
          clamped:
            requestedTtl != null &&
            answeredTtl != null &&
            answeredTtl < requestedTtl,
        }),
    projectVisibility: {
      ...platformVisibility,
      value:
        text(platformVisibility.value) || text(data.visibility) || "unknown",
      source: VISIBILITY_SOURCE,
      notFrom: "the GitHub repository",
      ...(makeEvergreen ? { makeEvergreen } : {}),
    },
  };
}

export function publishNotes(input: {
  data: Record<string, unknown>;
  runs: RunCommand[];
  short: boolean;
  held: boolean;
  shareLinksUrl: string | null;
}): string[] {
  const { data, runs, short, held, shareLinksUrl } = input;
  const isPublic = String(data.visibility ?? "").toLowerCase() === "public" && !carriesShareToken(runs);
  const visibility = data.projectVisibility as
    { makeEvergreen?: { say?: string; settingsUrl?: string } } | undefined;
  const evergreen = visibility?.makeEvergreen;
  const notes = [
    held
      ? "extension.dev is not open to the public yet, so the page answers a hold page; it opens at the same address once extension.dev does, and the run command works now."
      : null,
    runs.length
      ? isPublic
        ? "The run commands need no token: the project is public."
        : short
          ? "Each run command's URL is a short extension.dev link that redirects to the download, and it stops working when the link expires."
          : "Each run command carries the same share token as the link and stops working when the link expires."
      : null,
    runs.length > 1
      ? "For another browser, replace chrome with its name in both the URL and --browser; value.previewCommands holds each one."
      : null,
    runs.length
      ? "A URL with ?, & or another shell character is wrapped in double quotes so zsh, bash, PowerShell and cmd pass it whole."
      : null,
    shareLinksUrl
      ? `Every share link of this project is listed, and can be revoked, on the console Share links page: ${shareLinksUrl}.`
      : null,
    evergreen?.say
      ? `${evergreen.say}${evergreen.settingsUrl ? ` ${evergreen.settingsUrl}` : ""}`
      : null,
  ];

  return notes.filter((row): row is string => Boolean(row));
}
