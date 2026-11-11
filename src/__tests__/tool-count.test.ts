import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { tools as ALL_TOOLS } from "../index";

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

const read = (relative: string): string =>
  fs.readFileSync(path.join(packageRoot, relative), "utf8");

const registeredNames = ALL_TOOLS.map((t) => t.schema.name).sort();
const count = ALL_TOOLS.length;

const RETIRED_TOOL_NAMES = [
  "extension_deploy",
  "extension_source_inspect",
  "extension_dom_inspect",
  "extension_detect_browsers",
  "extension_list_browsers",
  "extension_install_browser",
  "extension_uninstall_browser",
  "extension_login",
  "extension_logout",
  "extension_whoami",
  "extension_list_templates",
  "extension_get_template_source",
  "extension_release_list",
  "extension_store_status",
  "extension_preview",
];

const COUNT_BEARING_FILES = ["package.json", "server.json"];
const TOOL_NAMING_FILES = [...COUNT_BEARING_FILES, "README.md"];

const countsIn = (text: string): number[] =>
  [...text.matchAll(/(\d+)\s+(?:MCP\s+)?tools\b/g)].map((m) => Number(m[1]));

describe("the tool count is derived, never typed", () => {
  it("has a registry with no duplicate names", () => {
    expect(new Set(registeredNames).size).toBe(count);
  });

  for (const file of COUNT_BEARING_FILES) {
    it(`states the registry size, and only the registry size, in ${file}`, () => {
      const stated = countsIn(read(file));
      expect(stated.length).toBeGreaterThan(0);
      expect(stated).toEqual(stated.map(() => count));
    });
  }

  it("states no count in the README, which listings copy and keep after the registry moves", () => {
    expect(countsIn(read("README.md"))).toEqual([]);
  });

  it("names only registered tools in the README, which points at the generated reference for the list", () => {
    const named = [...new Set([...read("README.md").matchAll(/\bextension_[a-z_]+\b/g)].map((m) => m[0]))];
    expect(named.length).toBeGreaterThan(0);
    expect(named.filter((name) => !registeredNames.includes(name))).toEqual([]);
    expect(read("README.md")).toContain("https://docs.extension.dev/tools/mcp#reference");
  });

  it("never names a tool the server no longer registers", () => {
    for (const surface of TOOL_NAMING_FILES) {
      const text = read(surface);

      for (const retired of RETIRED_TOOL_NAMES) {
        expect(
          new RegExp(`${retired}\\b`).test(text),
          `${surface} still names ${retired}`,
        ).toBe(false);
      }
    }
  });

  it("keeps the retired list disjoint from the live registry", () => {
    for (const retired of RETIRED_TOOL_NAMES) {
      expect(registeredNames).not.toContain(retired);
    }
  });
});
