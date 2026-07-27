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

const COUNT_BEARING_FILES = ["package.json", "server.json", "README.md"];

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

  it("carries the count in the README tagline, where npm reads it", () => {
    const tagline = read("README.md")
      .split("\n")
      .find((line) => line.startsWith("> "));
    expect(tagline).toBeDefined();
    expect(countsIn(tagline as string)).toEqual([count]);
  });

  it("documents every registered tool in the README table, and nothing else", () => {
    const documented = [
      ...read("README.md").matchAll(/^\| \w+ \| `(extension_\w+)` \|/gm),
    ].map((m) => m[1]);
    expect([...documented].sort()).toEqual(registeredNames);
    expect(documented.length).toBe(count);
  });

  it("never names a tool the server no longer registers", () => {
    for (const surface of COUNT_BEARING_FILES) {
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
