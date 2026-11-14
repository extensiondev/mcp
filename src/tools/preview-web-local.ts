// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import fs from "node:fs";
import path from "node:path";

import * as build from "./build";
import { navigateToUrl } from "./open";
import { engineBrowserName } from "../lib/browser-family";
import { uploadPreview } from "../lib/preview-upload";
import { engineProjectRoot } from "../lib/session-paths";
import { recordSharedPreview } from "../lib/share-record";

import type { PreviewWebLocal } from "./preview-web";

const PREVIEW_APP_LOCATIONS = [
  ["apps", "web", "preview.extension.dev"],
  ["apps", "preview.extension.dev"],
  ["preview.extension.dev"],
];

function previewDevCheckout(startPaths: string[], label: string): string | null {
  const seen = new Set<string>();

  for (const start of startPaths) {
    let dir: string;

    try {
      dir = path.resolve(start);
    } catch {
      continue;
    }

    for (let depth = 0; depth < 8; depth++) {
      if (seen.has(dir)) break;

      seen.add(dir);

      for (const location of PREVIEW_APP_LOCATIONS) {
        const manifest = path.join(dir, ...location, "package.json");

        try {
          const parsed = JSON.parse(fs.readFileSync(manifest, "utf8")) as {
            name?: string;
          };
          if (parsed.name === label) return dir;
        } catch {
        }
      }

      const parent = path.dirname(dir);
      if (parent === dir) break;

      dir = parent;
    }
  }

  return null;
}

export const PREVIEW_WEB_LOCAL: PreviewWebLocal = {
  build: (projectPath, browser) => build.handler({ projectPath, browser }),
  distDirOf: (args, browser) =>
    args.distPath
      ? path.resolve(args.distPath)
      : path.join(engineProjectRoot(args.projectPath), "dist", engineBrowserName(browser)),
  manifestExists: (manifestPath) => fs.existsSync(manifestPath),
  readManifest: (manifestPath) => JSON.parse(fs.readFileSync(manifestPath, "utf8")),
  devCheckout: (projectPath, label) => previewDevCheckout([projectPath, process.cwd()], label),
  navigate: (projectPath, browser, url) => navigateToUrl(projectPath, browser, url),
  uploadPreview,
  recordSharedPreview,
};
