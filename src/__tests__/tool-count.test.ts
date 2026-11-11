import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { tools as ALL_TOOLS } from "../index";
import { TOOL_POLICY } from "../lib/tool-policy";

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

const read = (relative: string): string =>
  fs.readFileSync(path.join(packageRoot, relative), "utf8");

const registeredNames = ALL_TOOLS.map((t) => t.schema.name).sort();
const count = ALL_TOOLS.length;
const platformCount = ALL_TOOLS.filter(
  (t) => TOOL_POLICY[t.schema.name]?.group === "platform",
).length;
const localCount = count - platformCount;

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

const COUNT_FREE_FILES = ["package.json", "server.json", "glama.json"];
const TOOL_NAMING_FILES = [...COUNT_FREE_FILES, "README.md"];

const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
  eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50,
};

const COUNT_PATTERN = new RegExp(
  `\\b(\\d+|${Object.keys(NUMBER_WORDS).join("|")})\\+?\\s+(?:(MCP|platform|local)\\s+)?tools\\b`,
  "gi",
);

type StatedCount = { stated: number; expected: number; text: string };

const countsIn = (text: string): StatedCount[] =>
  [...text.matchAll(COUNT_PATTERN)].map((m) => {
    const word = m[1].toLowerCase();
    const qualifier = (m[2] || "").toLowerCase();
    const expected = qualifier === "platform" ? platformCount : qualifier === "local" ? localCount : count;

    return { stated: word in NUMBER_WORDS ? NUMBER_WORDS[word] : Number(word), expected, text: m[0] };
  });

describe("the tool count is derived, never typed", () => {
  it("has a registry with no duplicate names", () => {
    expect(new Set(registeredNames).size).toBe(count);
  });

  for (const file of COUNT_FREE_FILES) {
    it(`states no tool count in ${file}, which every catalog copies and none refreshes`, () => {
      expect(countsIn(read(file))).toEqual([]);
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
