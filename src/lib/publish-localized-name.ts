// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { projectApiBytes } from "./project-api-bytes";
import { openProjectApi, type ProjectApi } from "./project-api";
import { readZipEntry } from "./zip-entries";

type Row = Record<string, unknown>;

const PACKAGES = ["chrome.zip", "edge.zip", "firefox.zip"];
const MAX_PACKAGE_BYTES = 256 * 1024 * 1024;
const ZIP_LIMITS = { maxEntries: 50_000, maxBytes: 1024 * 1024 };
const MESSAGE_KEY = /^__MSG_([A-Za-z0-9_@]+)__$/;

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function messageKeyOf(name: unknown): string | null {
  return MESSAGE_KEY.exec(text(name))?.[1] ?? null;
}

export function localizedMessage(messages: unknown, key: string): string | null {
  if (!messages || typeof messages !== "object") return null;

  const wanted = key.toLowerCase();
  const entry = Object.entries(messages as Row).find(([name]) => name.toLowerCase() === wanted)?.[1];
  const message = entry && typeof entry === "object" ? text((entry as Row).message) : "";

  return message && !messageKeyOf(message) ? message : null;
}

function jsonEntry(bytes: Buffer, name: string): Row | string {
  const read = readZipEntry(bytes, name, ZIP_LIMITS);
  if (!read.ok) return read.message;

  try {
    const parsed = JSON.parse(read.data.toString("utf8").replace(/^\uFEFF/, ""));

    return parsed && typeof parsed === "object" ? (parsed as Row) : `${name} is not a JSON object`;
  } catch {
    return `${name} is not valid JSON`;
  }
}

type NameRead = { name: string; from: string } | { problem: string };

function nameFromPackage(bytes: Buffer, file: string): NameRead {
  const manifest = jsonEntry(bytes, "manifest.json");
  if (typeof manifest === "string") return { problem: `${file}: ${manifest}` };

  const raw = text(manifest.name);
  const key = messageKeyOf(raw);
  if (raw && !key) return { name: raw, from: `${file}:manifest.json` };
  if (!key) return { problem: `${file}: manifest.json names no extension` };

  const locale = text(manifest.default_locale);
  if (!locale) return { problem: `${file}: the manifest name is a localized message but manifest.json sets no default_locale` };

  const entry = `_locales/${locale}/messages.json`;
  const messages = jsonEntry(bytes, entry);
  if (typeof messages === "string") return { problem: `${file}: ${messages}` };

  const message = localizedMessage(messages, key);

  return message ? { name: message, from: `${file}:${entry}` } : { problem: `${file}: ${entry} has no message for the manifest name` };
}

async function readPackageName(api: ProjectApi, sha: string): Promise<NameRead> {
  for (const file of PACKAGES) {
    const sent = await projectApiBytes(api, `builds/${encodeURIComponent(sha)}/artifacts/${file}`, { maxBytes: MAX_PACKAGE_BYTES });
    if (!sent.ok && sent.status === 404) continue;
    if (!sent.ok) return { problem: sent.message };

    return nameFromPackage(sent.bytes, file);
  }

  return { problem: `build ${sha} has no chrome, edge or firefox package` };
}

export async function localizeExtensionName(data: Row, args: { project?: string; api?: string }): Promise<string | null> {
  const named = text(data.extensionName);
  const key = messageKeyOf(named);
  if (named && !key) return null;

  const sha = text(data.buildSha);
  const opened = sha ? await openProjectApi({ command: "extension_publish", project: args.project, api: args.api }) : null;
  const read: NameRead = !sha
    ? { problem: "the answer named no build to read it from" }
    : opened && opened.ok
      ? await readPackageName(opened.api, sha)
      : { problem: opened?.message ?? "the project could not be opened" };

  if ("name" in read) {
    data.extensionName = read.name;
    data.extensionNameFrom = read.from;

    return null;
  }

  if (!key) return null;

  data.extensionName = null;

  return `The build's manifest names the extension by a localized message that could not be resolved (${read.problem}), so the tester message uses the project's name instead.`;
}
