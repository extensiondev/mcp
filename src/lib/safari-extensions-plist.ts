// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import os from "node:os";
import path from "node:path";

import { posixPath } from "./session-paths";

import type { SigningIdentity } from "./safari-signing";

export const UNSIGNED_IDENTITY = "UNSIGNED";

export function safariExtensionsPlistPath(home: string = os.homedir()): string {
  return path.posix.join(posixPath(home), "Library", "Containers", "com.apple.Safari", "Data", "Library", "Safari", "WebExtensions", "Extensions.plist");
}

export type PlistValue = string | number | boolean | PlistValue[] | { [key: string]: PlistValue } | null;

function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

export function parsePlistXml(xml: string): PlistValue {
  const tokens = (xml.match(/<[^>]*>|[^<]+/g) ?? []).filter((token) => (token.startsWith("<") ? !/^<[?!]/.test(token) : token.trim() !== ""));
  let at = 0;

  const text = (close: string): string => {
    let out = "";
    while (at < tokens.length && tokens[at] !== close) out += tokens[at++];
    at += 1;

    return decodeEntities(out);
  };

  const value = (): PlistValue => {
    const tag = tokens[at++];
    if (tag === undefined) return null;

    if (tag === "<dict>") {
      const out: { [key: string]: PlistValue } = {};

      while (at < tokens.length && tokens[at] !== "</dict>") {
        if (tokens[at++] !== "<key>") continue;

        const name = text("</key>");
        out[name] = value();
      }

      at += 1;

      return out;
    }

    if (tag === "<array>") {
      const out: PlistValue[] = [];
      while (at < tokens.length && tokens[at] !== "</array>") out.push(value());
      at += 1;

      return out;
    }

    if (tag === "<true/>") return true;
    if (tag === "<false/>") return false;
    if (tag === "<dict/>") return {};
    if (tag === "<array/>") return [];
    if (tag === "<string/>" || tag === "<data/>" || tag === "<date/>") return "";
    if (tag === "<string>") return text("</string>");
    if (tag === "<date>") return text("</date>");
    if (tag === "<data>") return text("</data>").replace(/\s+/g, "");
    if (tag === "<integer>") return Number(text("</integer>"));
    if (tag === "<real>") return Number(text("</real>"));
    if (tag.startsWith("<plist")) return value();

    return null;
  };

  return value();
}

export interface SafariExtensionRow {
  bundleId: string;
  identity: string;
  enabled: boolean;
  removed: boolean;
  addedAt: string | null;
  enabledChangedAt: string | null;
  removedAt: string | null;
}

function dateOf(row: { [key: string]: PlistValue }, key: string): string | null {
  const value = row[key];

  return typeof value === "string" && value ? value : null;
}

export function parseSafariExtensionsPlist(xml: string): SafariExtensionRow[] {
  const top = parsePlistXml(xml);
  if (!top || typeof top !== "object" || Array.isArray(top)) return [];

  const rows: SafariExtensionRow[] = [];

  for (const [key, entry] of Object.entries(top)) {
    const match = key.match(/^(.+?) \(([^()]+)\)$/);
    if (!match || !entry || typeof entry !== "object" || Array.isArray(entry)) continue;

    const removedAt = dateOf(entry, "RemovedDate");
    rows.push({
      bundleId: match[1]!,
      identity: match[2]!,
      enabled: entry.Enabled === true && removedAt === null,
      removed: removedAt !== null,
      addedAt: dateOf(entry, "AddedDate"),
      enabledChangedAt: dateOf(entry, "EnabledModificationDate"),
      removedAt,
    });
  }

  return rows;
}

export function plistIdentityOf(identity: SigningIdentity | null | undefined): string | null {
  if (!identity || identity === "unknown") return null;

  return identity === "ad-hoc" ? UNSIGNED_IDENTITY : identity.replace(/^team:/, "");
}

export function describeIdentity(identity: string): string {
  return identity === UNSIGNED_IDENTITY ? "unsigned (ad-hoc)" : `signed by team ${identity}`;
}
