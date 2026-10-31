// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import fs from "node:fs";
import path from "node:path";

import { storeConfigView } from "./platform-store-records";
import { openProjectApi, projectApiGet } from "./project-api";
import { resolveProjectRef } from "./registry";
import { STORE_MD_FILENAME } from "./store-md";
import { bulletLine, storeOwnLinesBody } from "./store-md-bullets";
import { classifyStore } from "./store-md-listing";

export type AmoChannel = "listed" | "unlisted";

export type AmoChannelSource = "store-md" | "platform";

export interface AmoChannelRead {
  channel: AmoChannel | null;
  source: AmoChannelSource | null;
}

export const UPDATE_URL_LINT_CODE = "MANIFEST_UPDATE_URL";

const UPDATE_URL_LINE = /\bAMO error MANIFEST_UPDATE_URL\b/;
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
const CHANNEL_KEY = /^(?:(?:amo|release|firefox|add-ons?) )?channel$/i;
const SECTION_HEADING = /^## +(.+?)\s*$/;
const FIREFOX_BROWSERS = new Set(["firefox", "firefox-based"]);

export function amoChannelOf(value: string): AmoChannel | null {
  const raw = value.trim().toLowerCase();
  if (/^unlisted\b/.test(raw)) return "unlisted";
  if (/^listed\b/.test(raw)) return "listed";

  return null;
}

export function isUpdateUrlLintLine(line: string): boolean {
  return UPDATE_URL_LINE.test(line.replace(ANSI, ""));
}

function firefoxSectionBody(content: string): string | null {
  const kept: string[] = [];
  let inside = false;

  for (const line of content.replace(/<!--[\s\S]*?-->/g, "").split("\n")) {
    const heading = SECTION_HEADING.exec(line);

    if (heading) {
      if (inside) break;

      inside = classifyStore(heading[1]!).includes("firefox");
      continue;
    }

    if (inside) kept.push(line);
  }

  return inside ? kept.join("\n") : null;
}

export function storeMdFirefoxChannel(content: string): AmoChannel | null {
  const body = firefoxSectionBody(content);
  if (body === null) return null;

  for (const line of storeOwnLinesBody(body).split("\n")) {
    const bullet = bulletLine(line.trim());
    if (bullet && CHANNEL_KEY.test(bullet.key)) return amoChannelOf(bullet.value);
  }

  return null;
}

function storeMdChannelOf(projectPath: string): AmoChannel | null {
  if (!projectPath.trim()) return null;

  try {
    return storeMdFirefoxChannel(fs.readFileSync(path.join(projectPath, STORE_MD_FILENAME), "utf8"));
  } catch {
    return null;
  }
}

async function platformFirefoxChannel(): Promise<AmoChannel | null> {
  try {
    const ref = resolveProjectRef();
    if (!ref) return null;

    const opened = await openProjectApi({ command: "extension_build", expect: ref });
    if (!opened.ok) return null;

    const config = await projectApiGet<Record<string, unknown>>(opened.api, "stores/config");
    if (!config.ok) return null;

    const view = storeConfigView(config.json.firefox, "firefox");

    return amoChannelOf(view?.releaseChannel ?? view?.submissionMode ?? "");
  } catch {
    return null;
  }
}

export async function readAmoChannel(projectPath: string): Promise<AmoChannelRead> {
  const fromFile = storeMdChannelOf(projectPath);
  if (fromFile) return { channel: fromFile, source: "store-md" };

  const fromPlatform = await platformFirefoxChannel();

  return fromPlatform ? { channel: fromPlatform, source: "platform" } : { channel: null, source: null };
}

function channelSource(read: AmoChannelRead): string {
  return read.source === "platform"
    ? `the project's Firefox store setting on extension.dev says ${read.channel}`
    : `STORE.md \`## Firefox Add-ons\` says \`- Channel: ${read.channel}\``;
}

export const UPDATE_URL_UNKNOWN_CHANNEL =
  "AMO refuses update_url on a listed submission; it is fine unlisted (STORE.md `- Channel:` decides). AMO's linter reported MANIFEST_UPDATE_URL (\"update_url\" is not allowed) on browser_specific_settings.gecko.update_url; write `- Channel: unlisted` or `- Channel: listed` under `## Firefox Add-ons` in STORE.md so this check can say which applies.";

export function updateUrlLineFor(read: AmoChannelRead): string {
  if (read.channel === "unlisted") {
    return `update_url is fine for an unlisted (self-distributed) add-on; remove it before a listed submission. AMO's linter reported MANIFEST_UPDATE_URL ("update_url" is not allowed) because it checks every manifest against the listed channel's rules; this project ships unlisted (${channelSource(read)}), where AMO signs the file with browser_specific_settings.gecko.update_url in place.`;
  }

  if (read.channel === "listed") {
    return `Remove browser_specific_settings.gecko.update_url before the listed submission: AMO refuses update_url on a listed submission (MANIFEST_UPDATE_URL, "update_url" is not allowed), so the upload would be refused; this project ships listed (${channelSource(read)}). update_url is fine only for an unlisted (self-distributed) add-on.`;
  }

  return UPDATE_URL_UNKNOWN_CHANNEL;
}

export async function channelAwareBuildWarnings(warnings: string[], browser: string, projectPath: string): Promise<string[]> {
  if (!FIREFOX_BROWSERS.has(browser) || !warnings.some(isUpdateUrlLintLine)) return warnings;

  const sentence = updateUrlLineFor(await readAmoChannel(projectPath));

  return warnings.map((line) => (isUpdateUrlLintLine(line) ? sentence : line));
}
