// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { nameRefusedInjection } from "../lib/injection-refusal";
import { readyContractPath } from "../lib/session-paths";
import { schema as evalSchema } from "../tools/eval";
import { schema as startSchema } from "../tools/start";
import { handler as wait, schema as waitSchema } from "../tools/wait";
import { attachedDevContract } from "./fixtures/engine-answers";

const require = createRequire(import.meta.url);
const enginePackage = require("extension-develop/package.json") as { version: string };

const engineDist = path.join(path.dirname(require.resolve("extension-develop/package.json")), "dist");
const SOURCE_EXTENSIONS = new Set([".mjs", ".cjs", ".js", ".ts"]);

function sources(dir: string): string[] {
  const out: string[] = [];

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);

    if (entry.isDirectory()) out.push(...sources(full));
    else if (SOURCE_EXTENSIONS.has(path.extname(entry.name))) out.push(full);
  }

  return out;
}

const distText = sources(engineDist).map((file) => fs.readFileSync(file, "utf8"));
const engineHas = (token: string): boolean => distText.some((text) => text.includes(token));

const ENGINE_TOKENS = {
  reloadedAt: engineHas("reloadedAt"),
  InjectionRefused: engineHas("InjectionRefused"),
  startProductionControl: engineHas("startProductionControl"),
};

const lacking = Object.entries(ENGINE_TOKENS)
  .filter(([, present]) => !present)
  .map(([token]) => token);

const EARLIER = "2026-10-05T12:00:00.000Z";
const UNRELEASED_ENGINE = /Extension\.js 4\.1\.34, not yet released/;

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-engine-dist-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function stamp(browser: string, contract: Record<string, unknown>): void {
  const file = readyContractPath(dir, browser);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(contract));
}

function later(ms: number): string {
  return new Date(Date.now() + ms).toISOString();
}

function refusalFrame(error: Record<string, unknown>): Record<string, any> {
  return { ok: false, command: "eval", status: "error", error: { ...error }, value: null };
}

async function rebuildWithoutStamp(): Promise<Record<string, any>> {
  stamp("chrome", attachedDevContract("chrome", { compiledAt: EARLIER, ts: EARLIER }));
  const waiting = wait({ projectPath: dir, browser: "chrome", for: "rebuild", timeoutMs: 4000 });

  await new Promise((resolve) => setTimeout(resolve, 300));
  const compiledAt = later(0);
  stamp("chrome", attachedDevContract("chrome", { compiledAt, ts: compiledAt, runtime: "detached", executorDetachedAt: compiledAt }));
  await new Promise((resolve) => setTimeout(resolve, 300));
  stamp("chrome", attachedDevContract("chrome", { compiledAt, ts: later(50) }));

  return JSON.parse(await waiting);
}

async function rebuildWithStamp(): Promise<{ result: Record<string, any>; reloadedAt: string }> {
  const before = { reloadedAt: EARLIER, reloadKind: "full", reloadLabel: "earlier" };
  stamp("chrome", attachedDevContract("chrome", { compiledAt: EARLIER, ts: EARLIER, ...before }));
  const waiting = wait({ projectPath: dir, browser: "chrome", for: "rebuild", timeoutMs: 6000 });

  await new Promise((resolve) => setTimeout(resolve, 300));
  const compiledAt = later(0);
  stamp("chrome", attachedDevContract("chrome", { compiledAt, ts: compiledAt, ...before }));
  await new Promise((resolve) => setTimeout(resolve, 600));
  const reloadedAt = later(0);
  stamp("chrome", attachedDevContract("chrome", { compiledAt, ts: reloadedAt, reloadedAt, reloadKind: "content", reloadLabel: "content script content/scripts.js" }));

  return { result: JSON.parse(await waiting), reloadedAt };
}

describe(`the installed engine (extension-develop ${enginePackage.version}) and what the server does with what it lacks`, () => {
  it(`records the engine tokens the server relies on: ${lacking.length ? `${lacking.join(", ")} missing` : "all present"}`, () => {
    expect(distText.length).toBeGreaterThan(0);
    expect(Object.keys(ENGINE_TOKENS).sort()).toEqual(["InjectionRefused", "reloadedAt", "startProductionControl"]);
  });

  describe(`reloadedAt (the reload stamp extension_wait for: "rebuild" reads) is ${ENGINE_TOKENS.reloadedAt ? "written" : "not written"} by this engine`, () => {
    if (ENGINE_TOKENS.reloadedAt) {
      it("reads the stamp and answers reloaded", async () => {
        const { result, reloadedAt } = await rebuildWithStamp();

        expect(result.status).toBe("rebuilt");
        expect(result.value.reload).toMatchObject({ outcome: "reloaded", reloadedAt, reloadKind: "content" });
      });
    } else {
      it("falls back to watching the background reconnect and the description says so", async () => {
        const result = await rebuildWithoutStamp();

        expect(result.status).toBe("rebuilt");
        expect(result.value.reload.outcome).toBe("reattached");
        expect(result.value.reload.reloadedAt).toBeUndefined();
        expect(waitSchema.description).toMatch(UNRELEASED_ENGINE);
        expect(waitSchema.description).toMatch(/reattached, still-detached or not-stamped/);
      });
    }
  });

  describe(`InjectionRefused (the refused-injection name behind E_PAGE_NOT_SCRIPTABLE) is ${ENGINE_TOKENS.InjectionRefused ? "answered" : "not answered"} by this engine`, () => {
    if (ENGINE_TOKENS.InjectionRefused) {
      it("names the refused tab by what it shows", () => {
        const web = refusalFrame({ code: "E_COMMAND_UNSUPPORTED_FOR_TARGET", name: "InjectionRefused", message: "Cannot access contents of the page." });
        nameRefusedInjection(web, { browser: "chrome", url: "https://example.com/" });
        expect(web.status).toBe("page-not-scriptable");
        expect(web.error.code).toBe("E_PAGE_NOT_SCRIPTABLE");
        expect(web.error.cliCode).toBe("E_COMMAND_UNSUPPORTED_FOR_TARGET");

        const page = refusalFrame({ code: "E_COMMAND_UNSUPPORTED_FOR_TARGET", name: "InjectionRefused", message: "Cannot access contents of the page." });
        nameRefusedInjection(page, { browser: "chrome", url: "chrome-extension://abc/options.html" });
        expect(page.status).toBe("extension-page-unreachable");
        expect(page.error.code).toBe("E_EXTENSION_PAGE_UNREACHABLE");
      });
    } else {
      it("leaves the engine's missing-target answer alone and the description says so", () => {
        const frame = refusalFrame({ code: "E_TARGET_NOT_FOUND", name: "TargetNotFound", message: "No tab matched the target." });

        nameRefusedInjection(frame, { browser: "chrome", url: "chrome://extensions" });

        expect(frame.status).toBe("error");
        expect(frame.error.code).toBe("E_TARGET_NOT_FOUND");
        expect(frame.error.cliCode).toBeUndefined();
        expect(frame.hint).toBeUndefined();
        expect(evalSchema.description).toMatch(UNRELEASED_ENGINE);
        expect(evalSchema.description).toMatch(/still answers as a missing target/);
      });
    }
  });

  describe(`startProductionControl (what start --allow-control turns on) is ${ENGINE_TOKENS.startProductionControl ? "present" : "absent"} in this engine`, () => {
    if (ENGINE_TOKENS.startProductionControl) {
      it("still takes allowControl and allowEval", () => {
        expect(Object.keys(startSchema.inputSchema.properties)).toEqual(expect.arrayContaining(["allowControl", "allowEval"]));
      });
    } else {
      it("describes the refusal a 4.1.33 project gets and the way around it", () => {
        expect(startSchema.description).toMatch(UNRELEASED_ENGINE);
        expect(startSchema.description).toMatch(/refused as engine-unsupported/);
        expect(startSchema.description).toMatch(/extension_dev drives the run instead/);
      });
    }
  });
});
