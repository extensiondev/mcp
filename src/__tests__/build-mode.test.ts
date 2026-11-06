import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, it, expect, afterEach, vi } from "vitest";

import type * as ExecModule from "../lib/exec";

const cliCalls: string[][] = [];
let frameValueOverride: Record<string, unknown> | null = null;
let dropFrame = false;
let narrationOverride: string | null = null;
vi.mock("../lib/exec", async (importOriginal) => {
  const actual = await importOriginal<typeof ExecModule>();

  return {
    ...actual,
    runExtensionCli: async (args: string[]) => {
      cliCalls.push(args);
      const browser = browserFromCliArgs(args);
      const answer = buildCliAnswer(args[1]!, browser);
      writeEngineDist(args[1]!, browser);

      if (frameValueOverride) {
        const frame = JSON.parse(answer.stdout) as { value: Record<string, unknown> };
        answer.stdout = `${JSON.stringify({ ...frame, value: { ...frame.value, ...frameValueOverride } })}\n`;
      }

      if (dropFrame) answer.stdout = "";
      if (narrationOverride !== null) answer.stderr = narrationOverride;

      return answer;
    },
  };
});

const build = await import("../tools/build");
const { buildCliAnswer, browserFromCliArgs, writeEngineDist, buildNarration } = await import("./fixtures/engine-answers");

const tmpDirs: string[] = [];

function project(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-build-mode-"));
  tmpDirs.push(dir);
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src", "manifest.json"), JSON.stringify({ manifest_version: 3, name: "Fixture", version: "1.0.0" }));

  return dir;
}

afterEach(() => {
  cliCalls.length = 0;
  frameValueOverride = null;
  dropFrame = false;
  narrationOverride = null;
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("419: extension_build names the mode it built, and says a development build exists", () => {
  it("passes --mode development and answers value.mode from the engine's frame, with the hint saying what that build is for", async () => {
    const dir = project();
    frameValueOverride = { mode: "development" };

    const result = JSON.parse(await build.handler({ projectPath: dir, mode: "development" }));

    expect(result.ok).toBe(true);
    expect(cliCalls[0]).toContain("--mode");
    expect(cliCalls[0][cliCalls[0].indexOf("--mode") + 1]).toBe("development");
    expect(result.value.mode).toBe("development");
    expect(result.hint).toMatch(/^The development build is in /);
    expect(result.hint).toContain("Playwright");
    expect(result.hint).toContain("source maps");
  });

  it("answers mode production for a plain build and does not call it a development build", async () => {
    const dir = project();

    const result = JSON.parse(await build.handler({ projectPath: dir }));

    expect(result.ok).toBe(true);
    expect(cliCalls[0]).not.toContain("--mode");
    expect(result.value.mode).toBe("production");
    expect(result.hint).toMatch(/^The production build is in /);
    expect(result.hint).not.toContain("Playwright");
  });

  it("takes the engine's word over the argument when the frame records a different mode", async () => {
    const dir = project();
    frameValueOverride = { mode: "production" };

    const result = JSON.parse(await build.handler({ projectPath: dir, mode: "development" }));

    expect(result.value.mode).toBe("production");
  });

  it("reads the mode from the narration when an older engine writes no frame", async () => {
    const dir = project();
    dropFrame = true;
    narrationOverride = buildNarration("chrome").replace("built for production", "built for development");

    const result = JSON.parse(await build.handler({ projectPath: dir, mode: "development" }));

    expect(result.ok).toBe(true);
    expect(result.value.mode).toBe("development");
  });

  it("falls back to the argument only when neither the frame nor the narration says", () => {
    expect(build.builtMode(null, "compiled in 2 ms", "none")).toBe("none");
    expect(build.builtMode(null, "compiled in 2 ms", undefined)).toBe("production");
    expect(build.builtMode({ ok: true, command: "build", status: "built", value: { mode: "bogus" } } as never, "Extension built for development in dist/chrome", undefined)).toBe("development");
  });

  it("the description and the mode schema say a development build exists, what it is for, and where the answer names the mode", () => {
    const mode = (build.schema.inputSchema.properties as unknown as Record<string, { description: string }>).mode;

    expect(build.schema.description).toMatch(/mode:'development'/);
    expect(build.schema.description).toMatch(/Playwright/);
    expect(build.schema.description).toMatch(/value\.mode/);
    expect(mode.description).toMatch(/source maps/);
    expect(mode.description).toMatch(/NODE_ENV=development/);
    expect(mode.description).toMatch(/outDir/);
    expect(mode.description).toMatch(/value\.mode/);
  });
});
