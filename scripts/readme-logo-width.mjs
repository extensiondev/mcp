// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const readmePath =
  process.env.README_LOGO_WIDTH_PATH ||
  fileURLToPath(new URL("../README.md", import.meta.url));
const githubWidth = "15.5%";
const npmWidth = "20.7%";

const mode = process.argv[2];
const [from, to] =
  mode === "npm" ? [githubWidth, npmWidth] : [npmWidth, githubWidth];

const readme = readFileSync(readmePath, "utf8");
const needle = `width="${from}"`;
if (!readme.includes(needle)) {
  console.error(`readme-logo-width: ${readmePath} holds no ${needle}, so nothing was rewritten for ${mode || "github"}`);
  process.exit(1);
}
writeFileSync(readmePath, readme.replace(needle, `width="${to}"`));
