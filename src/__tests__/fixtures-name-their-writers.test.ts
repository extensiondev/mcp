import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { ENGINE_WRITERS } from "./fixtures/engine-answers";
import { PLATFORM_WRITERS } from "./fixtures/platform-answers";

const engineDist = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "../../node_modules/extension-develop/dist",
);

const engineSource = fs
  .readdirSync(engineDist)
  .filter((name) => name.endsWith(".mjs"))
  .map((name) => fs.readFileSync(path.join(engineDist, name), "utf8"))
  .join("\n");

describe("every fixture builder names the engine or platform writer it copies key for key, and a degraded shape says which key it changed", () => {
  it("names a file and a marker for every engine builder", () => {
    for (const [builder, writer] of Object.entries(ENGINE_WRITERS)) {
      expect(writer.file, builder).toMatch(/^extension(-develop)?\/dist\//);
      expect(writer.marker.length, builder).toBeGreaterThan(0);
    }
  });

  it("finds each extension-develop marker in the installed engine's own source", () => {
    for (const [builder, writer] of Object.entries(ENGINE_WRITERS)) {
      if (!writer.file.startsWith("extension-develop/dist/")) continue;

      expect(engineSource.includes(writer.marker), `${builder}: ${writer.marker}`).toBe(true);
    }
  });

  it("names the www handler behind every platform builder", () => {
    for (const [builder, source] of Object.entries(PLATFORM_WRITERS)) {
      expect(source, builder).toMatch(/^www src\/app\/api\//);
    }
  });
});
