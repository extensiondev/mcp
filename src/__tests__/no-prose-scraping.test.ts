import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const srcDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Tokens that only ever appear in first-party CLI copy. Matching on any of them
// couples agent behaviour to a copy edit in another repo.
const CLI_COPY_TOKENS = [
  "compiled with errors",
  "✖✖✖",
  "ERROR in ",
  "Module not found",
  "NOT FOUND",
  "SingletonLock",
  "ProcessSingleton",
  "Build Status:",
  "⏵⏵⏵",
  "Author says",
];

// Every exemption is a fallback for a CLI that does not speak the machine
// contract yet, and every one of them carries a @deprecated marker naming the
// condition for its deletion. The list shrinks to zero; it never grows.
const EXEMPT = new Map<string, string>([
  [
    "lib/legacy-stdout.ts",
    "the whole module is the deprecated stdout fallback",
  ],
  [
    "lib/act.ts",
    "the control-channel prose match, until the CLI act layer stamps error.code",
  ],
  [
    "tools/open.ts",
    "the headless/gesture prose match, until the CLI act layer stamps error.code",
  ],
  [
    "tools/build.ts",
    "the Size:/Build Status: scrapes, until build speaks the envelope",
  ],
]);

const walk = (dir: string): string[] => {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walk(full));
    } else if (entry.name.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
};

const sources = [
  ...walk(path.join(srcDir, "tools")),
  ...walk(path.join(srcDir, "lib")),
].map((file) => ({
  relative: path.relative(srcDir, file).split(path.sep).join("/"),
  text: fs.readFileSync(file, "utf8"),
}));

describe("no tool reads the CLI's human copy", () => {
  it("has sources to check", () => {
    expect(sources.length).toBeGreaterThan(20);
  });

  for (const { relative, text } of sources) {
    const hits = CLI_COPY_TOKENS.filter((token) => text.includes(token));
    if (EXEMPT.has(relative)) continue;

    it(`${relative} matches no retired CLI copy`, () => {
      expect(
        hits,
        `${relative} matches first-party CLI copy. Read the machine contract instead, or move the match into src/lib/legacy-stdout.ts behind a capability probe.`,
      ).toEqual([]);
    });
  }

  for (const [relative, why] of EXEMPT) {
    it(`${relative} is exempt only while it declares why (${why})`, () => {
      const source = sources.find((s) => s.relative === relative);
      expect(source, `${relative} is exempt but no longer exists`).toBeDefined();
      expect(
        /@deprecated|deprecated fallback|fallback until|until the CLI/i.test(
          (source as { text: string }).text,
        ),
        `${relative} is exempt from the prose ban but does not say when the exemption ends`,
      ).toBe(true);
    });
  }
});
