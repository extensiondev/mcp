// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import fs from "node:fs";
import path from "node:path";

import { ensureProjectIgnored, type ProjectIgnoreState } from "./project-ignore";

export const SHARE_STATE_DIR = ".extension.dev";

export const SHARE_RECORD_FILE = "shared-previews.json";

const FILE_NOTE =
  "Every preview link shared from this project. revokeUrl is the only handle that kills a link before expiresAt, and the platform mints a new id on every share, so a lost revokeUrl cannot be recovered. Safe to delete once every link below has expired.";

const IGNORE_COMMENT =
  "# Extension.dev local state: revoke handles for shared previews, not part of your extension.";

export interface SharedPreviewEntry {
  sharedAt: string;
  previewUrl: string;
  artifactId: string;
  revokeUrl?: string;
  expiresAt?: string;
  zipUrl?: string;
  name?: string;
  version?: string;
  browser?: string;
  distDir?: string;
}

export interface ShareRecordOutcome {
  recorded: boolean;
  path: string;
  entries?: number;
  gitignored?: ProjectIgnoreState;
  preserved?: string;
  note: string;
  warning?: string;
}

export function sharedPreviewsPath(projectPath: string): string {
  return path.join(projectPath, SHARE_STATE_DIR, SHARE_RECORD_FILE);
}

function loadExisting(file: string): {
  entries: SharedPreviewEntry[];
  unreadable: boolean;
} {
  if (!fs.existsSync(file)) return { entries: [], unreadable: false };
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return { entries: [], unreadable: true };
  }
  try {
    const parsed = JSON.parse(raw) as { shares?: unknown };
    if (Array.isArray(parsed?.shares)) {
      return {
        entries: parsed.shares as SharedPreviewEntry[],
        unreadable: false,
      };
    }
  } catch {
  }
  return { entries: [], unreadable: true };
}

export interface SharedPreviewsFile {
  path: string;
  exists: boolean;
  unreadable: boolean;
  entries: SharedPreviewEntry[];
}

export function readSharedPreviews(projectPath: string): SharedPreviewsFile {
  const file = sharedPreviewsPath(projectPath);
  if (!fs.existsSync(file)) {
    return { path: file, exists: false, unreadable: false, entries: [] };
  }
  const existing = loadExisting(file);
  return {
    path: file,
    exists: true,
    unreadable: existing.unreadable,
    entries: existing.entries.filter(
      (entry) => entry && typeof entry.artifactId === "string",
    ),
  };
}

export function recordSharedPreview(
  projectPath: string,
  entry: SharedPreviewEntry,
): ShareRecordOutcome {
  const file = sharedPreviewsPath(projectPath);
  let preserved: string | undefined;
  let entries: SharedPreviewEntry[];
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const existing = loadExisting(file);
    if (existing.unreadable) {
      preserved = path.join(
        path.dirname(file),
        `shared-previews.${Date.now()}.unreadable.json`,
      );
      fs.renameSync(file, preserved);
    }
    entries = [...existing.entries, entry];
    fs.writeFileSync(
      file,
      `${JSON.stringify({ version: 1, note: FILE_NOTE, shares: entries }, null, 2)}\n`,
    );
  } catch (error) {
    return {
      recorded: false,
      path: file,
      note: `Could not write the share record to ${file}: ${
        error instanceof Error ? error.message : String(error)
      }. The revokeUrl in this response is then the only copy, so keep it: re-sharing mints a new link and leaves this one live until expiresAt.`,
    };
  }

  const ignore = ensureProjectIgnored(projectPath, {
    entry: `${SHARE_STATE_DIR}/`,
    aliases: [SHARE_STATE_DIR, `/${SHARE_STATE_DIR}`, `/${SHARE_STATE_DIR}/`],
    comment: IGNORE_COMMENT,
  });

  return {
    recorded: true,
    path: file,
    entries: entries.length,
    gitignored: ignore.state,
    ...(preserved ? { preserved } : {}),
    note:
      `The revoke handle was also written to ${file}, which keeps every share this project has made.` +
      (preserved
        ? ` The previous file could not be read, so it was kept as ${preserved} rather than overwritten.`
        : ""),
    ...(ignore.state === "failed"
      ? {
          warning: `${SHARE_STATE_DIR}/ is not in this project's .gitignore and could not be added, so add it yourself before committing.`,
        }
      : {}),
  };
}
