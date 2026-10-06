// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import * as fs from "node:fs";
import * as path from "node:path";
import { getManagedBrowsersCacheRoot } from "extension-install";
import { envelope } from "../lib/envelope";
import { findManagedBinaryIn } from "./detect-browsers";

const BROWSER_NAMES = ["chrome", "chromium", "edge", "firefox"] as const;

function getDirSize(dir: string): number {
  let total = 0;
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        total += getDirSize(full);
      } else {
        try {
          total += fs.statSync(full).size;
        } catch {
        }
      }
    }
  } catch {
  }
  return total;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;

  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export async function listManagedBrowsers(): Promise<string> {
  const cacheRoot = getManagedBrowsersCacheRoot();
  const installed: Array<{
    browser: string;
    path: string;
    binaryPath: string;
    size: number;
    sizeFormatted: string;
    engine: string;
  }> = [];
  const incomplete: Array<{ browser: string; path: string; size: number; sizeFormatted: string }> = [];

  /* @invariant INSTALLED MEANS A BINARY IS THERE. A directory left by an
     interrupted download used to count as "1 managed browser(s) found" and
     drop out of availableToInstall. */
  for (const browser of BROWSER_NAMES) {
    const browserDir = path.join(cacheRoot, browser);
    if (!fs.existsSync(browserDir)) continue;
    const size = getDirSize(browserDir);
    const binaryPath = findManagedBinaryIn(browserDir, browser);
    if (binaryPath) {
      installed.push({
        browser,
        path: browserDir,
        binaryPath,
        size,
        sizeFormatted: formatBytes(size),
        engine: browser === "firefox" ? "gecko" : "chromium",
      });
    } else {
      incomplete.push({ browser, path: browserDir, size, sizeFormatted: formatBytes(size) });
    }
  }

  return envelope({
    ok: true,
    command: "extension_browsers",
    status: "listed",
    value: {
      cacheRoot,
      cacheExists: fs.existsSync(cacheRoot),
      installed,
      incomplete,
      availableToInstall: BROWSER_NAMES.filter(
        (b) => !installed.some((i) => i.browser === b),
      ),
    },
    ...(incomplete.length
      ? {
          warnings: incomplete.map(
            (i) => `${i.browser}: ${i.path} holds ${i.sizeFormatted} but no ${i.browser} binary, which is what an interrupted download leaves; it is not installed. Reinstall it with extension_browsers action: "install", or remove it with action: "uninstall".`,
          ),
        }
      : {}),
    hint:
      installed.length === 0
        ? "No managed browsers found. Use extension_browsers with action: \"install\" to install one, or use a system-installed browser."
        : `${installed.length} managed browser(s) found. Use extension_browsers with action: "detect" for a full system scan.`,
  });
}
