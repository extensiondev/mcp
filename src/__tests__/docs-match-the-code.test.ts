/* @invariant the shipped docs validate against the
 * schemas the server registers, the tool reference is generated from them,
 * and the numbers the docs quote are the code's. Each cell failed before its
 * fix. */

import fs from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import { describe, it, expect } from "vitest";

import { tools } from "../index";
import { renderToolsDoc } from "../lib/docs-tools";
import { validateToolInput } from "../lib/validate-input";
import { TOOL_POLICY } from "../lib/tool-policy";
import { REAL_BROWSERS } from "../lib/common-schema";

const require = createRequire(import.meta.url);
const read = (rel: string) => fs.readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), "utf8");
const DOCS = [
  "README.md",
  "claude/README.md",
  "claude/CLAUDE.md",
  "claude/ARCHITECTURE.md",
  "claude/commands/extension.md",
  "claude/commands/extension-add.md",
  "claude/commands/extension-debug.md",
  "claude/commands/extension-publish.md",
  "claude/rules/extension-dev.md",
  "claude/rules/cross-browser.md",
];

function looseJson(objectText: string): Record<string, unknown> | null {
  const quoted = objectText
    .replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)\s*:/g, '$1"$2":')
    .replace(/'([^'\\]*)'/g, '"$1"')
    .replace(/,\s*([}\]])/g, "$1");

  try {
    const parsed = JSON.parse(quoted);

    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

describe("109: the docs say what the code does", () => {
  it("renders the tool reference from the schemas, and the file on disk is that rendering", () => {
    const rendered = `${renderToolsDoc(tools.map((t) => t.schema))  }\n`;

    if (process.env.WRITE_TOOLS_DOC === "1") {
      fs.writeFileSync(fileURLToPath(new URL("../../claude/rules/mcp-tools.md", import.meta.url)), rendered);
    }

    expect(read("claude/rules/mcp-tools.md")).toBe(rendered);
    for (const tool of tools) expect(read("claude/rules/mcp-tools.md")).toContain(`## ${tool.schema.name}`);
  });

  it("validates every example call in the docs against the current schemas", () => {
    const byName = new Map(tools.map((t) => [t.schema.name, t.schema]));
    let checked = 0;

    for (const rel of DOCS) {
      const text = read(rel);
      const calls = text.matchAll(/\b(extension_[a-z_]+)\(\s*(\{[\s\S]*?\})\s*\)/g);

      for (const call of calls) {
        const [, name, objectText] = call;
        const schema = byName.get(name);
        expect(schema, `${rel} calls ${name}, which is not a tool`).toBeDefined();
        const args = looseJson(objectText);
        if (!args) continue;

        checked += 1;
        const issues = validateToolInput(schema!.inputSchema as Record<string, unknown>, args);
        expect(issues, `${rel}: ${name}(${objectText.replace(/\s+/g, " ")}) -> ${issues.map((i) => i.message ?? JSON.stringify(i)).join("; ")}`).toEqual([]);
      }
    }

    expect(checked).toBeGreaterThanOrEqual(3);
  });

  it("names no input, slug, event or recipe the code refuses", () => {
    const all = DOCS.map(read).join("\n");
    expect(all).not.toMatch(/sidebar-claude|sidebar-transformers-js|src\/lib\/claude\.ts/);
    expect(all).not.toMatch(/include: "releases"/);
    expect(all).not.toMatch(/`page_html`|`extension_root_tree`|`console_summary`/);
    expect(all).not.toMatch(/--browser=chrome,firefox/);
    expect(all).not.toMatch(/the assertions except `surface-rendered`/);
    expect(all).not.toMatch(/releases\/download\/nightly\/templates-meta\.json/);
    expect(read("claude/README.md")).toMatch(/Apache-2\.0/);
    expect(read("claude/README.md")).not.toMatch(/^MIT$/m);
  });

  it("quotes the code's own numbers", () => {
    const pkg = require("../../package.json") as { engines: { node: string } };
    const engine = require("extension-develop/package.json") as { engines: { node: string } };
    expect(pkg.engines.node).toBe(engine.engines.node);
    const server = require("../../server.json") as { description: string };
    expect(server.description).toContain(`${tools.length} tools, ${REAL_BROWSERS.length} browsers`);
    const local = Object.values(TOOL_POLICY).filter((p) => p.group === "local").length;
    expect(read("README.md")).toContain(`exposes the ${local} of its ${tools.length} tools that work on this machine (the ${tools.length - local} platform tools are off)`);
  });
});
