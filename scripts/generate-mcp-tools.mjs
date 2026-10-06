// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const { tools, renderToolsDoc } = await import("../dist/module.js");
const out = fileURLToPath(new URL("../claude/rules/mcp-tools.md", import.meta.url));
writeFileSync(out, renderToolsDoc(tools.map((t) => t.schema)) + "\n");
console.log(`wrote ${out} for ${tools.length} tools`);
