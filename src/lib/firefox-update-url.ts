// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators


import { splitChannelKey } from "./channel-link";
import { channelXpiAddress, updateManifestAddress } from "./package-address";
import { readBuiltManifest } from "./project-manifest";
import { isRow, text } from "./ship-act";
import { storeMdNoNetworkPromise } from "./store-md-network";

import type { ChannelEntry, ProjectRef } from "./registry";

type Row = Record<string, unknown>;

export const UPDATE_URL_CHECK = "firefox.update_url";
export const DEFAULT_FIREFOX_CHANNEL = "stable";

const HOSTED_MANIFEST = /\/channels\/[^/\s"']+\/updates\.json/;
const UPDATES_READ_AT = /look for updates\b[^.]*?\bat (https?:\/\/[^\s"']+?)[.,;:]?(?=\s|$)/i;
const PREFIXES = ["", "firefox:", "gecko:"];
const RELEASE_CHANNEL_KEYS = ["releaseChannel", "targetChannel"];

export interface UpdateManifestServed {
  url: string;
  served: boolean;
  checkedAt?: string;
  reason?: string;
  channel?: string;
  pinned?: { channel: string; buildId: string; pinnedAt: string };
}

export interface UpdateManifestView extends UpdateManifestServed {
  say: string;
}

export interface FirefoxUpdateManifest {
  channel: string;
  updateManifestUrl: string;
  channelXpiUrl: string;
  manifestUpdateUrl: string | null;
  suggested: boolean;
  noNetworkPromise?: string;
  served?: boolean;
  checkedAt?: string;
  reason?: string;
  pinned?: { channel: string; buildId: string; pinnedAt: string };
  say: string;
}

const SERVED_WORDS = /served now|not served yet/i;

export const NOT_SERVED_REASONS: Record<string, string> = {
  "channel-not-public": "no signed build is on that channel yet",
  "no-signed-build": "no signed build is on that channel yet",
  "no-gecko-id": "the signed builds on that channel carry no browser_specific_settings.gecko.id",
  unreachable: "the address could not be read",
};

export function notServedReason(reason: unknown): string {
  const code = text(reason);

  return NOT_SERVED_REASONS[code] ?? (code ? `the address answered ${code}` : "the address did not answer 200");
}

export function updateManifestServedSentence(view: UpdateManifestServed): string {
  const pinned = view.pinned
    ? ` The platform pinned build ${text(view.pinned.buildId)} to the ${text(view.pinned.channel)} channel for Firefox; the manifest lists it within a minute.`
    : "";

  if (view.served) {
    return `Firefox finds updates at ${view.url}, served now${view.checkedAt ? ` (checked ${view.checkedAt})` : ""}.${pinned}`;
  }

  return `The update manifest at ${view.url} is not served yet: ${notServedReason(view.reason)}; the platform serves it once AMO signs the version, whatever the channel's audience, with no step for you.${pinned}`;
}

export function updateManifestServedOf(raw: unknown): UpdateManifestServed | undefined {
  if (!isRow(raw)) return undefined;

  const url = text(raw.url);
  if (!url || typeof raw.served !== "boolean") return undefined;

  const pin = isRow(raw.pinned) ? raw.pinned : null;

  return {
    url,
    served: raw.served,
    ...(text(raw.checkedAt) ? { checkedAt: text(raw.checkedAt) } : {}),
    ...(text(raw.reason) ? { reason: text(raw.reason) } : {}),
    ...(text(raw.channel) ? { channel: text(raw.channel) } : {}),
    ...(pin && text(pin.channel) && text(pin.buildId)
      ? { pinned: { channel: text(pin.channel), buildId: text(pin.buildId), pinnedAt: text(pin.pinnedAt) } }
      : {}),
  };
}

export function updateManifestOf(raw: unknown): UpdateManifestView | undefined {
  const view = updateManifestServedOf(raw);

  return view ? { ...view, say: updateManifestServedSentence(view) } : undefined;
}

export function firefoxUpdateManifestOutcome(record: Row | undefined, rows: unknown): UpdateManifestView | null {
  const sent = Array.isArray(rows) ? rows.filter(isRow).find((row) => text(row.store) === "firefox") : null;

  return updateManifestOf(record?.updateManifest) ?? updateManifestOf(sent?.updateManifest) ?? null;
}

function servedFieldsOf(json: Row): Pick<FirefoxUpdateManifest, "served" | "checkedAt" | "reason" | "pinned"> {
  const block = isRow(json.firefoxPreflight) ? json.firefoxPreflight : {};
  const read = isRow(block.updateManifest) ? block.updateManifest : null;
  if (!read || typeof read.served !== "boolean") return {};

  const pin = isRow(read.pinned) ? read.pinned : null;

  return {
    served: read.served,
    ...(text(read.checkedAt) ? { checkedAt: text(read.checkedAt) } : {}),
    ...(read.served || !text(read.reason) ? {} : { reason: text(read.reason) }),
    ...(pin && text(pin.channel) && text(pin.buildId)
      ? { pinned: { channel: text(pin.channel), buildId: text(pin.buildId), pinnedAt: text(pin.pinnedAt) } }
      : {}),
  };
}

export const UPDATE_URL_NETWORK_NOTE =
  "Firefox will then check that address for updates from every install, a network request to extension.dev on Firefox's own schedule.";

export const UPDATE_URL_FROZEN_NOTE = "Without it, installs of the signed file stay on their version until you hand out the next one.";

export function updateManifestSentence(address: string): string {
  return `Option for self-distributed builds: put browser_specific_settings.gecko.update_url: ${address} in the manifest for the firefox target, and the platform rewrites updates.json after every signing. ${UPDATE_URL_NETWORK_NOTE} ${UPDATE_URL_FROZEN_NOTE}`;
}

export function updateUrlNotSuggestedSentence(promise: string, address: string): string {
  return `No update_url is suggested: STORE.md says "${promise}", and browser_specific_settings.gecko.update_url would make every install check ${address} for updates, a network request to extension.dev. Installs of the signed file stay on their version until you hand out the next one.`;
}

export function updateUrlMismatchSentence(found: string, address: string): string {
  return `The manifest names update_url ${found}, not the platform's ${address}, so Firefox will look for updates there. ${updateManifestSentence(address)}`;
}

export function namesHostedManifest(message: unknown): boolean {
  return HOSTED_MANIFEST.test(text(message));
}

export function firefoxReleaseChannelOf(json: Row): string {
  const block = isRow(json.firefoxPreflight) ? json.firefoxPreflight : {};

  for (const key of RELEASE_CHANNEL_KEYS) {
    const named = text(block[key]) || text(json[key]);
    if (named) return named;
  }

  return DEFAULT_FIREFOX_CHANNEL;
}

export function manifestUpdateUrlOf(projectPath: string): string | null {
  if (!text(projectPath)) return null;

  const manifest = readBuiltManifest(projectPath, "firefox")?.manifest;
  const settings = prefixed(manifest, "browser_specific_settings") ?? prefixed(manifest, "applications");
  const url = prefixed(prefixed(settings, "gecko"), "update_url");

  return typeof url === "string" && url.trim() ? url.trim() : null;
}

function prefixed(row: unknown, key: string): unknown {
  if (!isRow(row)) return undefined;

  return PREFIXES.map((prefix) => row[`${prefix}${key}`]).find((value) => value !== undefined);
}

export function updateUrlOfCheck(check: Row | null): string | null {
  const actual = text(check?.actual);
  if (/^https?:\/\//i.test(actual)) return actual;

  const said = UPDATES_READ_AT.exec(text(check?.message));

  return said ? said[1] : null;
}

function updateUrlCheckOf(json: Row): Row | null {
  const block = isRow(json.firefoxPreflight) ? json.firefoxPreflight : {};
  const rows = [...(Array.isArray(block.checks) ? block.checks : []), ...(Array.isArray(json.checks) ? json.checks : [])].filter(isRow);

  return rows.find((row) => text(row.id) === UPDATE_URL_CHECK) ?? null;
}

function foundUpdateUrl(json: Row, projectPath: string): string | null {
  return manifestUpdateUrlOf(projectPath) ?? updateUrlOfCheck(updateUrlCheckOf(json));
}

export function firefoxUpdateManifestOf(json: Row, ref: ProjectRef | null, projectPath: string, api?: string): FirefoxUpdateManifest | null {
  const channel = firefoxReleaseChannelOf(json);
  const updateManifestUrl = updateManifestAddress(ref, channel, api);
  if (!updateManifestUrl) return null;

  const found = foundUpdateUrl(json, projectPath);
  const mismatch = found !== null && found !== updateManifestUrl;
  const check = updateUrlCheckOf(json);
  const platform = text(check?.message);
  const platformPassed = text(check?.status) === "pass";
  const promise = found === null && !platformPassed ? storeMdNoNetworkPromise(projectPath) : null;
  const say = mismatch
    ? updateUrlMismatchSentence(found, updateManifestUrl)
    : platformPassed && platform
      ? platform
      : found
        ? `The manifest names the platform's update_url ${updateManifestUrl}; the platform rewrites updates.json after every signing.`
        : promise
          ? updateUrlNotSuggestedSentence(promise.line, updateManifestUrl)
          : namesHostedManifest(platform)
            ? platform
            : updateManifestSentence(updateManifestUrl);

  const served = servedFieldsOf(json);
  const servedSay =
    served.served !== undefined && !SERVED_WORDS.test(say) && !mismatch
      ? ` ${updateManifestServedSentence({ ...served, url: updateManifestUrl, served: served.served })}`
      : "";

  return {
    channel,
    updateManifestUrl,
    channelXpiUrl: channelXpiAddress(ref, channel, api),
    manifestUpdateUrl: found,
    suggested: !mismatch && found === null && !platformPassed && !promise,
    ...(promise ? { noNetworkPromise: promise.line } : {}),
    ...served,
    say: `${say}${servedSay}`,
  };
}

function relayRow(row: Row, view: FirefoxUpdateManifest): Row {
  const mismatch = view.manifestUpdateUrl !== null && view.manifestUpdateUrl !== view.updateManifestUrl;
  if (!mismatch && text(row.status) === "pass" && text(row.message)) return row;
  if (!mismatch && !view.noNetworkPromise && namesHostedManifest(row.message)) return row;

  return {
    ...row,
    status: mismatch ? "warn" : "pass",
    severity: mismatch ? "warning" : "info",
    message: view.say,
    expected: view.updateManifestUrl,
    ...(view.manifestUpdateUrl ? { actual: view.manifestUpdateUrl } : {}),
  };
}

export function relayFirefoxUpdateUrl(json: Row, view: FirefoxUpdateManifest | null): Row {
  if (!view) return json;

  const found = updateUrlCheckOf(json);
  const relayed = relayRow(found ?? { id: UPDATE_URL_CHECK, label: "Firefox update_url", stage: "review" }, view);
  const rows = (list: unknown) => (Array.isArray(list) ? list.map((row) => (isRow(row) && text(row.id) === UPDATE_URL_CHECK ? relayed : row)) : list);
  const block = isRow(json.firefoxPreflight) ? json.firefoxPreflight : null;
  const ids = (list: unknown) => (Array.isArray(list) ? list.map((id) => text(id)) : []);
  const warned = relayed.status === "warn";
  const warnings = block ? ids(block.warnings).filter((id) => id !== UPDATE_URL_CHECK).concat(warned ? [UPDATE_URL_CHECK] : []) : [];
  const added = !found && warned;

  return {
    ...json,
    ...(Array.isArray(json.checks) || added ? { checks: [...(rows(json.checks) as unknown[] | undefined) ?? [], ...(added ? [relayed] : [])] } : {}),
    ...(block ? { firefoxPreflight: { ...block, checks: [...((rows(block.checks) as unknown[] | undefined) ?? []), ...(added ? [relayed] : [])], warnings } } : {}),
  };
}

export function channelBrowsers(channels: ChannelEntry[], channel: string, fallback: readonly string[]): string[] {
  const on = channels.map((entry) => splitChannelKey(entry.channel)).filter((key) => key.channel === channel);
  const named = on.map((key) => key.browser).filter((browser): browser is string => Boolean(browser));

  return named.length ? named : on.length ? [...fallback] : [];
}

export function servedOfAnswer(body: unknown): UpdateManifestServed | undefined {
  if (!isRow(body)) return undefined;

  const firefox = isRow(body.firefox) ? body.firefox : null;

  return updateManifestServedOf(body.updateManifest) ?? updateManifestServedOf(firefox?.updateManifest);
}

export function firefoxChannelFields(ref: ProjectRef | null, channel: string, browsers: readonly string[], api?: string, served?: UpdateManifestServed): Row {
  if (!browsers.some((browser) => text(browser).toLowerCase() === "firefox")) return {};

  const updateManifestUrl = updateManifestAddress(ref, channel, api);
  if (!updateManifestUrl) return {};

  return {
    firefox: {
      channel: text(channel),
      updateManifestUrl,
      channelXpiUrl: channelXpiAddress(ref, channel, api),
      ...(served ? { updateManifest: { ...served, url: served.url || updateManifestUrl } } : {}),
    },
  };
}

export function firefoxChannelSentence(fields: Row): string {
  const firefox = isRow(fields.firefox) ? fields.firefox : null;
  if (!firefox) return "";

  const url = text(firefox.updateManifestUrl);
  const served = updateManifestOf(isRow(firefox.updateManifest) ? { url, ...firefox.updateManifest } : null);
  const lead = `Firefox installs from the ${text(firefox.channel)} channel update through ${url}, which the platform rewrites after every signing and whose update_link is ${text(firefox.channelXpiUrl)}, when the manifest names that update_url in browser_specific_settings.gecko. ${UPDATE_URL_NETWORK_NOTE}`;

  return served ? `${lead} ${served.say}` : lead;
}
