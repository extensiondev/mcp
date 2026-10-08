import fs from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, it, expect } from "vitest";

import { SERVER_INSTRUCTIONS } from "../index";
import { schema as devSchema } from "../tools/dev";
import { schema as waitSchema } from "../tools/wait";

const read = (rel: string) =>
  fs.readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), "utf8");

const SHIPPED_RUN_DOCS = [
  "claude/CLAUDE.md",
  "claude/commands/extension.md",
  "claude/commands/extension-add.md",
  "claude/commands/extension-debug.md",
  "claude/rules/extension-dev.md",
];

describe("running an extension is one call: extension_dev waits and answers ready", () => {
  it("the wait tool names the cases that still need it and says a ready dev answer is not one", () => {
    expect(waitSchema.description).toMatch(/started with wait:false/);
    expect(waitSchema.description).toMatch(/ready\.status was not "ready"/);
    expect(waitSchema.description).toMatch(/build-only \(noBrowser\) session/);
    expect(waitSchema.description).toMatch(/nothing left to wait for/);
  });

  it("the dev tool and the server instructions say a ready answer ends the recipe", () => {
    expect(devSchema.description).toMatch(
      /ready\.status is "ready" the session is up and nothing else needs calling/,
    );

    expect(devSchema.description).not.toMatch(/process info that extension_wait/);
    expect(SERVER_INSTRUCTIONS).toMatch(/extension_dev runs the dev session and answers once it is ready/);
    expect(SERVER_INSTRUCTIONS).not.toMatch(/extension_wait blocks until it is ready/);
  });

  it("the shipped rules and the run command describe one call, never dev then wait", () => {
    expect(read("claude/CLAUDE.md")).toMatch(/`extension_dev` is the whole run recipe/);
    expect(read("claude/commands/extension.md")).toMatch(/do not call `extension_wait` after it/);

    for (const doc of SHIPPED_RUN_DOCS) {
      expect(read(doc), doc).not.toMatch(/then (call )?`?extension_wait/);
      expect(read(doc), doc).not.toMatch(/`extension_wait`[^.\n]*to check\b/);
    }
  });
});
