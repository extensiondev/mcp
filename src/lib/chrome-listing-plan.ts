// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { CHROME_JUSTIFICATION_LIMIT } from "./chrome-dashboard-agent";
import { isRow, text } from "./row";

export type ChromeVisibilityPick = "unlisted" | "private";

export type PlanFile = { name: string; path: string; sha256: string };

export type ChromePlan = {
  dir: string;
  item: { publisherId: string; itemId: string } | null;
  fields: Record<string, string>;
  labels: Record<string, string>;
  justifications: Array<{ permission: string; text: string }>;
  visibility: ChromeVisibilityPick;
  notes: string[];
  pkg: PlanFile | null;
  icon: PlanFile[];
  screenshots: PlanFile[];
  declarations: string[];
  left: string[];
  live: boolean;
  account: string;
};

export type FetchBytes = (url: string, maxBytes: number) => Promise<{ ok: true; bytes: Buffer } | { ok: false; message: string }>;

const MAX_PACKAGE_BYTES = 48 * 1024 * 1024;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_SCREENSHOTS = 5;
const ICON_SIZE = "128x128";
const SCREENSHOT_SIZES = new Set(["1280x800", "640x400"]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const ZIP = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const ITEM_ADDRESS = /^https:\/\/chrome\.google\.com\/(?:u\/\d+\/)?webstore\/devconsole\/([^/?#\s]+)\/([a-p]{32})(?:[/?#]|$)/i;
const SAFE_NAME = /[^a-z0-9._-]+/gi;
const ITEM_ROWS = new Set(["chrome.item", "chrome.store_connection", "chrome.store_icon", "chrome.screenshots"]);

const rows = (value: unknown): Array<Record<string, unknown>> => (Array.isArray(value) ? value.filter(isRow) : []);

export const sha256Of = (bytes: Buffer): string => crypto.createHash("sha256").update(bytes).digest("hex");

export function imageSize(bytes: Buffer): { type: "png" | "jpeg"; width: number; height: number } | null {
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(PNG)) return { type: "png", width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;

  for (let at = 2; at + 9 < bytes.length; ) {
    if (bytes[at] !== 0xff) return null;

    const marker = bytes[at + 1]!;
    const length = bytes.readUInt16BE(at + 2);

    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return { type: "jpeg", height: bytes.readUInt16BE(at + 5), width: bytes.readUInt16BE(at + 7) };

    at += 2 + length;
  }

  return null;
}

export function itemOf(dashboardUrl: unknown): { publisherId: string; itemId: string } | null {
  const match = ITEM_ADDRESS.exec(text(dashboardUrl));

  return match?.[1] && match[2] ? { publisherId: match[1], itemId: match[2].toLowerCase() } : null;
}

export function visibilityPick(raw: string): { pick: ChromeVisibilityPick; note: string } {
  if (/^private\b/i.test(raw)) return { pick: "private", note: "" };
  if (/^public\b/i.test(raw)) return { pick: "unlisted", note: "STORE.md asks for Public, but a first draft is set Unlisted, the least public option; switch it on Distribution when you choose to list it." };

  return { pick: "unlisted", note: "" };
}

export function justificationLines(raw: string): Array<{ permission: string; text: string }> {
  return raw
    .split("\n")
    .map((line) => {
      const at = line.indexOf(": ");

      return at > 0 ? { permission: line.slice(0, at).trim().replace(/^`|`$/g, ""), text: line.slice(at + 2).trim() } : null;
    })
    .filter((row): row is { permission: string; text: string } => Boolean(row?.permission && row.text));
}

function fileName(raw: string, fallback: string): string {
  const name = raw.replace(SAFE_NAME, "-").replace(/^-+/, "").slice(0, 100);

  return name || fallback;
}

function keep(dir: string, name: string, bytes: Buffer): PlanFile {
  const target = path.join(dir, name);

  fs.writeFileSync(target, bytes, { mode: 0o600 });

  return { name, path: target, sha256: sha256Of(bytes) };
}

/* @invariant A FILE REACHES THE DASHBOARD ONLY AS THE BYTES THE PLATFORM
 * VOUCHED FOR. The package lands only when its SHA-256 is the digest the
 * build recorded and it is a zip; each image lands only when it is a PNG or
 * JPEG of the size Chrome asks for that slot. Each kept file is written once
 * to a private folder, and its digest is checked again just before it is set
 * on the page, so nothing between the check and the slot can swap it.
 */
export async function chromePlan(read: unknown, fetchBytes: FetchBytes, tempRoot: string = os.tmpdir()): Promise<ChromePlan> {
  const body = isRow(read) ? read : {};
  const dir = fs.mkdtempSync(path.join(tempRoot, "extension-dev-chrome-"));

  fs.chmodSync(dir, 0o700);

  const fields: Record<string, string> = {};
  const labels: Record<string, string> = {};
  const notes: string[] = [];
  const declarations: string[] = [];
  const icon: PlanFile[] = [];
  const screenshots: PlanFile[] = [];

  for (const page of rows(body.pages)) {
    for (const field of rows(page.fields)) {
      const id = text(field.id);

      if (id && typeof field.text === "string" && field.text.trim()) {
        fields[id] = field.text.trim();
        labels[id] = text(field.label) || id;
      }
    }

    for (const answer of rows(page.answers)) if (answer.kind === "owner-certifies") declarations.push(text(answer.label) || text(answer.id));

    for (const image of rows(page.images)) {
      const id = text(image.id);
      const slot = id === "chrome.store_icon" ? icon : id === "chrome.screenshots" ? screenshots : null;
      if (!slot) continue;

      for (const file of rows(image.files)) {
        if (slot === screenshots && screenshots.length >= MAX_SCREENSHOTS) break;
        if (slot === icon && icon.length >= 1) break;

        const name = fileName(text(file.name), `${id}-${slot.length + 1}.png`);
        const got = await fetchBytes(text(file.url), MAX_IMAGE_BYTES);

        if (!got.ok) {
          notes.push(`${name} was not fetched (${got.message})`);
          continue;
        }

        const size = imageSize(got.bytes);
        const dims = size ? `${size.width}x${size.height}` : "";

        if (!size || got.bytes.length > MAX_IMAGE_BYTES) notes.push(`${name} is not a PNG or JPEG under 4 MB, so it was left out`);
        else if (slot === icon && dims !== ICON_SIZE) notes.push(`${name} is ${dims}, and the store icon must be ${ICON_SIZE}`);
        else if (slot === screenshots && !SCREENSHOT_SIZES.has(dims)) notes.push(`${name} is ${dims}, and Chrome takes screenshots at 1280x800 or 640x400`);
        else slot.push(keep(dir, name, got.bytes));
      }
    }
  }

  let pkg: PlanFile | null = null;
  const wanted = isRow(body.package) ? body.package : null;
  const digest = text(wanted?.sha256).toLowerCase();

  if (wanted && /^[0-9a-f]{64}$/.test(digest)) {
    const got = await fetchBytes(text(wanted.url), MAX_PACKAGE_BYTES);

    if (!got.ok) notes.push(`the package was not fetched (${got.message})`);
    else if (sha256Of(got.bytes) !== digest) notes.push("the package bytes do not match the SHA-256 the build recorded, so it was not used");
    else if (!got.bytes.subarray(0, 4).equals(ZIP)) notes.push("the package is not a zip, so it was not used");
    else pkg = keep(dir, "chrome.zip", got.bytes);
  } else {
    notes.push("the platform names no verified package for Chrome, so no new item can be made");
  }

  const justifications = justificationLines(fields["chrome.permission_justifications"] ?? "");
  const hostLength = justifications.filter((line) => /:\/\/|^<all_urls>$|^\*/.test(line.permission)).map((line) => `${line.permission}: ${line.text}`).join("\n").length;

  if (hostLength > CHROME_JUSTIFICATION_LIMIT) notes.push(`the host reasons under Permissions justification join to ${hostLength.toLocaleString("en-US")} characters and Chrome's Host permission justification takes at most ${CHROME_JUSTIFICATION_LIMIT.toLocaleString("en-US")}, so only the whole reasons that fit are typed and the rest are named in the checklist`);

  for (const line of justifications) if (!/:\/\/|^<all_urls>$|^\*/.test(line.permission) && line.text.length > CHROME_JUSTIFICATION_LIMIT) notes.push(`the ${line.permission} reason is ${line.text.length.toLocaleString("en-US")} characters and Chrome takes at most ${CHROME_JUSTIFICATION_LIMIT.toLocaleString("en-US")}, so it is not typed`);

  const seen = visibilityPick(fields["chrome.visibility"] ?? "");

  if (seen.note) notes.push(seen.note);

  const left = rows(body.left).filter((row) => !ITEM_ROWS.has(text(row.id))).map((row) => text(row.label) || text(row.id)).filter(Boolean);

  return {
    dir,
    item: itemOf(body.dashboardUrl),
    fields,
    labels,
    justifications,
    visibility: seen.pick,
    notes,
    pkg,
    icon,
    screenshots,
    declarations,
    left,
    live: text(body.state) === "done" && isRow(body.read) && text(body.read.word) === "published",
    account: text(body.connectedAs),
  };
}

export function stillSame(file: PlanFile): boolean {
  try {
    return sha256Of(fs.readFileSync(file.path)) === file.sha256;
  } catch {
    return false;
  }
}
