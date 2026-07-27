import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { tools as ALL_TOOLS } from "../index";
import { ERROR_CODES, envelopeObject } from "../lib/envelope";
import { validateAgainstSchema } from "./envelope-validate";

const here = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.resolve(here, "..");
const schema = JSON.parse(
  fs.readFileSync(path.join(here, "contract", "envelope.schema.json"), "utf8"),
);

const registered = new Set(ALL_TOOLS.map((t) => t.schema.name));

const walk = (dir: string): string[] => {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
};

const sources = [
  ...walk(path.join(srcDir, "tools")),
  ...walk(path.join(srcDir, "lib")),
  path.join(srcDir, "index.ts"),
].map((file) => ({
  relative: path.relative(srcDir, file).split(path.sep).join("/"),
  text: fs.readFileSync(file, "utf8"),
}));

// `envelope()` and `envelopeObject()` are the only serializers allowed to
// produce a handler's return value. These files hand-serialize something that
// is not a tool result.
const RAW_SERIALIZER_ALLOWED = new Set([
  "lib/envelope.ts", // it *is* the serializer
  "lib/act.ts", // shapes the CLI's own frame
]);

describe("every returned frame is the schema-1 envelope", () => {
  it("registers 28 tools, all of them named in an envelope call", () => {
    expect(registered.size).toBe(ALL_TOOLS.length);
  });

  for (const { relative, text } of sources) {
    if (RAW_SERIALIZER_ALLOWED.has(relative)) continue;
    it(`${relative} returns no hand-built frame`, () => {
      const hits = [...text.matchAll(/return JSON\.stringify\(/g)];
      expect(
        hits.length,
        `${relative} returns a hand-built JSON frame. Use envelope() from src/lib/envelope.ts.`,
      ).toBe(0);
    });
  }

  it("names only registered tools in `command`, per decision D6", () => {
    const named = new Set<string>();
    for (const { text } of sources) {
      for (const match of text.matchAll(/command:\s*"(extension_[a-z_]+)"/g)) {
        named.add(match[1]);
      }
    }
    expect(named.size).toBeGreaterThan(0);
    for (const name of named) {
      expect(registered, `${name} is not a registered tool`).toContain(name);
    }
  });

  it("uses only declared error codes", () => {
    const declared = new Set<string>(ERROR_CODES);
    for (const { relative, text } of sources) {
      if (relative === "lib/envelope.ts") continue;
      for (const match of text.matchAll(/code:\s*"(E_[A-Z0-9_]+)"/g)) {
        expect(
          declared,
          `${relative} emits ${match[1]}, which is not in the ErrorCode union`,
        ).toContain(match[1]);
      }
    }
  });

  it("builds a frame the copied CLI schema accepts, for every tool name", () => {
    for (const tool of ALL_TOOLS) {
      const okFrame = envelopeObject({
        ok: true,
        command: tool.schema.name,
        status: "done",
        value: {},
      });
      const failFrame = envelopeObject({
        ok: false,
        command: tool.schema.name,
        status: "failed",
        error: { code: "E_INTERNAL", message: "x" },
      });
      expect(validateAgainstSchema(okFrame, schema)).toEqual([]);
      expect(validateAgainstSchema(failFrame, schema)).toEqual([]);
    }
  });
});
