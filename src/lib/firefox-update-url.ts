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

import type { ChannelEntry, ProjectRef } from "./registry";

type Row = Record<string, unknown>;

export const UPDATE_URL_CHECK = "firefox.update_url";
export const DEFAULT_FIREFOX_CHANNEL = "stable";

const HOSTED_MANIFEST = /\/channels\/[^/\s"']+\/updates\.json/;
const RELEASE_CHANNEL_KEYS = ["releaseChannel", "targetChannel"];

export interface FirefoxUpdateManifest {
  channel: string;
  updateManifestUrl: string;
  channelXpiUrl: string;
  manifestUpdateUrl: string | null;
  say: string;
}

export function updateManifestSentence(address: string): string {
  return `Put browser_specific_settings.gecko.update_url: ${address} in the manifest for the firefox target; the platform rewrites updates.json after every signing.`;
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

  const manifest = readBuiltManifest(projectPath, "firefox")?.manifest as Record<string, any> | undefined;
  const settings =
    manifest?.browser_specific_settings ?? manifest?.["firefox:browser_specific_settings"] ?? manifest?.["gecko:browser_specific_settings"] ?? manifest?.applications;
  const url = settings?.gecko?.update_url;

  return typeof url === "string" && url.trim() ? url.trim() : null;
}

function updateUrlCheckOf(json: Row): Row | null {
  const block = isRow(json.firefoxPreflight) ? json.firefoxPreflight : {};
  const rows = [...(Array.isArray(block.checks) ? block.checks : []), ...(Array.isArray(json.checks) ? json.checks : [])].filter(isRow);

  return rows.find((row) => text(row.id) === UPDATE_URL_CHECK) ?? null;
}

function foundUpdateUrl(json: Row, projectPath: string): string | null {
  const local = manifestUpdateUrlOf(projectPath);
  if (local) return local;

  const actual = text(updateUrlCheckOf(json)?.actual);

  return /^https?:\/\//i.test(actual) ? actual : null;
}

export function firefoxUpdateManifestOf(json: Row, ref: ProjectRef | null, projectPath: string, api?: string): FirefoxUpdateManifest | null {
  const channel = firefoxReleaseChannelOf(json);
  const updateManifestUrl = updateManifestAddress(ref, channel, api);
  if (!updateManifestUrl) return null;

  const found = foundUpdateUrl(json, projectPath);
  const mismatch = found !== null && found !== updateManifestUrl;
  const platform = text(updateUrlCheckOf(json)?.message);
  const say = mismatch
    ? updateUrlMismatchSentence(found, updateManifestUrl)
    : found
      ? `The manifest names the platform's update_url ${updateManifestUrl}; the platform rewrites updates.json after every signing.`
      : namesHostedManifest(platform)
        ? platform
        : updateManifestSentence(updateManifestUrl);

  return { channel, updateManifestUrl, channelXpiUrl: channelXpiAddress(ref, channel, api), manifestUpdateUrl: found, say };
}

function relayRow(row: Row, view: FirefoxUpdateManifest): Row {
  const mismatch = view.manifestUpdateUrl !== null && view.manifestUpdateUrl !== view.updateManifestUrl;
  if (!mismatch && namesHostedManifest(row.message)) return row;

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

export function firefoxChannelFields(ref: ProjectRef | null, channel: string, browsers: readonly string[], api?: string): Row {
  if (!browsers.some((browser) => text(browser).toLowerCase() === "firefox")) return {};

  const updateManifestUrl = updateManifestAddress(ref, channel, api);
  if (!updateManifestUrl) return {};

  return { firefox: { channel: text(channel), updateManifestUrl, channelXpiUrl: channelXpiAddress(ref, channel, api) } };
}

export function firefoxChannelSentence(fields: Row): string {
  const firefox = isRow(fields.firefox) ? fields.firefox : null;
  if (!firefox) return "";

  return `Firefox installs from the ${text(firefox.channel)} channel update through ${text(firefox.updateManifestUrl)}, which the platform rewrites after every signing and whose update_link is ${text(firefox.channelXpiUrl)}; a manifest that names that update_url in browser_specific_settings.gecko stays current.`;
}
