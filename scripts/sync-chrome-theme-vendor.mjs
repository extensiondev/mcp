// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, "..");
const SOURCE_DIR = path.resolve(
  pkgRoot,
  "../extensiondev-emulator/src/browser-ui/lib",
);
const VENDOR_DIR = path.resolve(pkgRoot, "src/lib/vendor/chrome-theme");

const FILES = [
  "chrome-theme-color-math.ts",
  "chrome-theme-reference.ts",
  "chrome-theme-resolve.ts",
];

function header(file) {
  return [
    "// VENDORED FILE - DO NOT HAND-EDIT.",
    "//",
    `// Synced verbatim from packages/extensiondev-emulator/src/browser-ui/lib/${file}`,
    "// by packages/public-extensiondev-mcp/scripts/sync-chrome-theme-vendor.mjs.",
    "//",
    "// The published @extension.dev/mcp must not take a workspace dependency on",
    "// @extensiondev/emulator (the carrier ships decoupled), so this pure resolver",
    "// is copied in. Edit the emulator source, then re-run the sync script.",
    "",
    "",
  ].join("\n");
}

async function main() {
  await fs.mkdir(VENDOR_DIR, { recursive: true });
  for (const file of FILES) {
    const raw = await fs.readFile(path.join(SOURCE_DIR, file), "utf8");
    await fs.writeFile(path.join(VENDOR_DIR, file), header(file) + raw, "utf8");
    process.stderr.write(`synced ${file}\n`);
  }
  process.stderr.write(`Vendored ${FILES.length} file(s) into ${VENDOR_DIR}\n`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
