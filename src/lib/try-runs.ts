// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { localizedMessage, messageKeyOf } from "./publish-localized-name";
import { unpackZip } from "./zip-entries";

export const TRY_ROOT_ENV = "EXTENSION_TRY_DIR";
export const TRY_MARKER = "try.json";
export const TRY_EXTENSION_DIR = "src";
export const TRY_PROFILE_DIR = "profile";
export const TRY_SCREENSHOTS_DIR = "screenshots";

const MAX_ENTRIES = 20_000;
const MAX_UNPACKED_BYTES = 512 * 1024 * 1024;

export interface TryRun {
  dir: string;
  project: string;
  browser: string;
  buildId: string;
  version: string | null;
  startedAt: string;
}

type Row = Record<string, unknown>;

function isRow(value: unknown): value is Row {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function tryRoot(): string {
  const configured = String(process.env[TRY_ROOT_ENV] || "").trim();

  return configured ? path.resolve(configured) : path.join(os.tmpdir(), "extension-try");
}

export function tryScreenshotsDir(): string {
  return path.join(tryRoot(), TRY_SCREENSHOTS_DIR);
}

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").slice(0, 60);
}

export function openTryRun(facts: Omit<TryRun, "dir" | "startedAt">): TryRun {
  const root = tryRoot();
  fs.mkdirSync(root, { recursive: true });

  const [workspace = "", project = ""] = facts.project.split("/");
  const dir = fs.mkdtempSync(path.join(root, `${slug(workspace)}--${slug(project)}--${slug(facts.browser)}-`));
  const startedAt = new Date().toISOString();

  fs.writeFileSync(path.join(dir, TRY_MARKER), `${JSON.stringify({ ...facts, startedAt }, null, 2)}\n`);
  fs.writeFileSync(path.join(dir, "package.json"), `${JSON.stringify({ name: "extension-try", private: true }, null, 2)}\n`);

  const run: TryRun = { ...facts, dir, startedAt };

  return run;
}

export function removeTryRun(dir: string): boolean {
  const root = tryRoot();
  const resolved = path.resolve(dir);

  if (path.dirname(resolved) !== root || !fs.existsSync(path.join(resolved, TRY_MARKER))) return false;

  try {
    fs.rmSync(resolved, { recursive: true, force: true });
  } catch {
    return false;
  }

  return !fs.existsSync(resolved);
}

export function listTryRuns(project: string, browser?: string): TryRun[] {
  const root = tryRoot();
  let names: string[];

  try {
    names = fs.readdirSync(root);
  } catch {
    return [];
  }

  const wanted = project.toLowerCase();
  const runs: TryRun[] = [];

  for (const name of names) {
    const dir = path.join(root, name);
    let marker: unknown;

    try {
      marker = JSON.parse(fs.readFileSync(path.join(dir, TRY_MARKER), "utf8"));
    } catch {
      continue;
    }

    if (!isRow(marker) || String(marker.project ?? "").toLowerCase() !== wanted) continue;
    if (browser && marker.browser !== browser) continue;

    runs.push({
      dir,
      project: String(marker.project),
      browser: String(marker.browser ?? ""),
      buildId: String(marker.buildId ?? ""),
      version: typeof marker.version === "string" ? marker.version : null,
      startedAt: String(marker.startedAt ?? ""),
    });
  }

  return runs;
}

export type Unpacked =
  | { ok: true; extensionDir: string; files: number; bytes: number; manifest: Row }
  | { ok: false; message: string };

export function unpackTryPackage(run: TryRun, bytes: Buffer): Unpacked {
  const extensionDir = path.join(run.dir, TRY_EXTENSION_DIR);
  const unpacked = unpackZip(bytes, extensionDir, { maxEntries: MAX_ENTRIES, maxBytes: MAX_UNPACKED_BYTES });

  if (!unpacked.ok) return unpacked;

  let manifest: unknown;

  try {
    manifest = JSON.parse(fs.readFileSync(path.join(extensionDir, "manifest.json"), "utf8"));
  } catch {
    return { ok: false, message: "the package has no readable manifest.json at its root" };
  }

  if (!isRow(manifest)) return { ok: false, message: "the package's manifest.json is not a JSON object" };

  return { ok: true, extensionDir, files: unpacked.files, bytes: unpacked.bytes, manifest };
}

export function displayName(extensionDir: string, manifest: Row): string | null {
  const name = typeof manifest.name === "string" ? manifest.name.trim() : "";
  const key = messageKeyOf(name);
  if (!key) return name || null;

  const locale = typeof manifest.default_locale === "string" ? manifest.default_locale : "en";

  try {
    const messages = JSON.parse(fs.readFileSync(path.join(extensionDir, "_locales", locale, "messages.json"), "utf8"));

    return localizedMessage(messages, key);
  } catch {
    return null;
  }
}
