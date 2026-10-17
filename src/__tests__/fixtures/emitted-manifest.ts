import fs from "node:fs";
import path from "node:path";

import { filterKeysForThisBrowser } from "extension-develop/manifest";

type Body = Record<string, unknown>;

export function writeEmittedManifest(projectPath: string, browser: string, source: Body): Body {
  const emitted = filterKeysForThisBrowser(
    source as Parameters<typeof filterKeysForThisBrowser>[0],
    browser as Parameters<typeof filterKeysForThisBrowser>[1],
  ) as Body;
  const distDir = path.join(projectPath, "dist", browser);
  fs.mkdirSync(distDir, { recursive: true });
  fs.writeFileSync(path.join(distDir, "manifest.json"), JSON.stringify(emitted));

  return emitted;
}
