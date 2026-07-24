// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const source = path.resolve(
  packageRoot,
  "../../apps/extension-core/dist/chromium",
);
const target = path.join(packageRoot, "extensions", "live-preview", "chromium");

if (!fs.existsSync(path.join(source, "manifest.json"))) {
  console.error(`No built carrier at ${source}; run pnpm build there first.`);
  process.exit(1);
}
fs.rmSync(target, { recursive: true, force: true });
fs.cpSync(source, target, { recursive: true });
const manifest = JSON.parse(
  fs.readFileSync(path.join(target, "manifest.json"), "utf-8"),
);
console.log(`Synced carrier ${manifest.version} into ${target}`);
