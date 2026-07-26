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
    size: number;
    sizeFormatted: string;
    engine: string;
  }> = [];

  for (const browser of BROWSER_NAMES) {
    const browserDir = path.join(cacheRoot, browser);
    if (fs.existsSync(browserDir)) {
      const size = getDirSize(browserDir);
      installed.push({
        browser,
        path: browserDir,
        size,
        sizeFormatted: formatBytes(size),
        engine: browser === "firefox" ? "gecko" : "chromium",
      });
    }
  }

  return JSON.stringify({
    cacheRoot,
    cacheExists: fs.existsSync(cacheRoot),
    installed,
    availableToInstall: BROWSER_NAMES.filter(
      (b) => !installed.some((i) => i.browser === b),
    ),
    hint:
      installed.length === 0
        ? "No managed browsers found. Use extension_browsers with action: \"install\" to install one, or use a system-installed browser."
        : `${installed.length} managed browser(s) found. Use extension_browsers with action: "detect" for a full system scan.`,
  });
}
