import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const srcDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

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

/* @invariant Three entries left this map the day it was checked against the tokens above:
   lib/act.ts, tools/open.ts and tools/eval.ts match NONE of them. Their prose
   fallbacks read broker and browser messages, which is a different and much
   weaker coupling than reading first-party CLI copy, and the ban was never what
   held them back. Keeping them listed hid that, filled the cap, and implied a
   version floor they were waiting on: they are not. The engine at the pin still
   does not stamp a distinguishing code for a popup it cannot open in a headless
   session, nor for an active tab eval cannot reach, so those fallbacks are load
   bearing against the NEWEST engine rather than an old one. Removing the
   exemption puts all three under the ban, where they pass, and where a future
   edit that reached for CLI copy would now fail. */
const EXEMPT = new Map<string, string>([
  [
    "lib/legacy-stdout.ts",
    'the whole module is the deprecated stdout fallback, and boot-verdict reaches it only when speaksMachineContract is false. That probe keys on ready.json schema:1, which the engine first stamps in 4.0.17, so 4.0.17 is the floor for BOTH scrapes: the earlier 4.0.10 figure recorded here for the compile one was never the gate, since status:"error" long predates it and the scrape runs anyway on a contract that does not advertise schema 1. 4.0.17 was tagged 2026-07-27, so a project on 4.0.16 or any 3.x is an ordinary thing to meet, and this stays until that floor is old enough to require. legacy-stdout.test.ts holds the reachability proof to re-run before deleting',
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

describe("no tool reads the CLI's human copy: each token above appears only in first-party CLI copy, so matching one couples agent behaviour to a copy edit in another repo", () => {
  it("has sources to check", () => {
    expect(sources.length).toBeGreaterThan(20);
  });

  it("keeps every exemption a @deprecated fallback for a CLI without the machine contract: the list shrinks to zero, it never grows", () => {
    expect(EXEMPT.size).toBeLessThanOrEqual(1);
  });

  /* @invariant The cap only means something if it is tight. Naming the files that left
     stops the next reader from re-adding one on the assumption the slot was
     always spare, and fails if any of the three quietly starts matching CLI
     copy again under cover of a fresh exemption. */
  it("no longer exempts the three files that never matched CLI copy", () => {
    for (const relative of ["lib/act.ts", "tools/open.ts", "tools/eval.ts"]) {
      expect(EXEMPT.has(relative), `${relative} is exempt again`).toBe(false);
      const source = sources.find((s) => s.relative === relative);
      expect(source, `${relative} no longer exists`).toBeDefined();
      expect(
        CLI_COPY_TOKENS.filter((token) =>
          (source as { text: string }).text.includes(token),
        ),
      ).toEqual([]);
    }
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
