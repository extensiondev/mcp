// Refresh the bundled live-preview carrier payload from the private
// extension-core build. Run from inside the extension.dev monorepo after
// `pnpm build` in apps/extension-core:
//
//   node scripts/sync-carrier.mjs
//
// The payload ships prebuilt in this public package (extensions/live-preview);
// the carrier's source stays private.
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
