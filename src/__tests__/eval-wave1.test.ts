import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { describe, it, expect, vi, afterEach } from "vitest";

import { remoteValueNote } from "../lib/cdp-extension-page";
import { matchPatternRegexSource, executeScriptExpression } from "../tools/inspect-gecko";
import { CALL_TIMEOUT } from "../lib/common-schema";
import { schema as evalSchema } from "../tools/eval";

import type * as ExecModule from "../lib/exec";

const exec = vi.hoisted(() => ({ result: { code: 0, stdout: "", stderr: "", timedOut: false, signal: null as string | null } }));
vi.mock("../lib/exec", async (importOriginal) => ({
  ...(await importOriginal<typeof ExecModule>()),
  runExtensionCli: async () => exec.result,
}));

const { runActVerb } = await import("../lib/act");

afterEach(() => {
  exec.result = { code: 0, stdout: "", stderr: "", timedOut: false, signal: null };
});

describe("wave 1: extension_eval says where and what it ran", () => {
  it("maps a legacy frame's error name to its code when the engine sent no code", async () => {
    exec.result = { code: 1, stdout: JSON.stringify({ ok: false, error: { name: "NoSession", message: "no session" } }), stderr: "", timedOut: false, signal: null };
    const out = JSON.parse(await runActVerb(["storage", "get", "/p"], "/p", 1000, "extension_storage"));
    expect(out.ok).toBe(false);
    expect(out.error.code).toBe("E_NO_SESSION");
    expect(out.error.name).toBe("NoSession");
  });

  it("a run this server stopped is unconfirmed, not 'exited with code null'", async () => {
    exec.result = { code: null as unknown as number, stdout: "", stderr: "", timedOut: true, signal: "SIGTERM" };
    const out = JSON.parse(await runActVerb(["storage", "set", "/p"], "/p", 1000, "extension_storage"));
    expect(out.status).toBe("cli-timeout");
    expect(out.error.message).toMatch(/may already have acted/);
    expect(out.error.message).not.toMatch(/exited with code/);
  });

  it("an exit 0 with unreadable stdout is unconfirmed, not 'exited with code 0'", async () => {
    exec.result = { code: 0, stdout: "progress: done\n", stderr: "", timedOut: false, signal: null };
    const out = JSON.parse(await runActVerb(["open", "popup", "/p"], "/p", 1000, "extension_open"));
    expect(out.status).toBe("cli-unreadable");
    expect(out.error.message).toMatch(/may have acted/);
  });

  it("values JSON cannot carry are named", () => {
    expect(remoteValueNote({ type: "number", unserializableValue: "NaN" })).toMatch(/NaN.*string "NaN"/);
    expect(remoteValueNote({ type: "bigint", unserializableValue: "12n" })).toMatch(/BigInt/);
    expect(remoteValueNote({ type: "undefined" })).toMatch(/undefined.*null/);
    expect(remoteValueNote({ type: "number", value: 1 })).toBeUndefined();
  });

  it("the Gecko picker matches a match pattern, not a substring", () => {
    const re = new RegExp(matchPatternRegexSource("https://www.youtube.com/*"));
    expect(re.test("https://www.youtube.com/watch?v=x")).toBe(true);
    expect(re.test("https://youtube.com/")).toBe(false);
    const sub = new RegExp(matchPatternRegexSource("*://*.example.com/*"));
    expect(sub.test("https://a.example.com/x")).toBe(true);
    expect(sub.test("http://example.com/")).toBe(true);
    expect(sub.test("https://evil.com/example.com/")).toBe(false);
    expect(executeScriptExpression("https://www.youtube.com/*", "1")).toContain("new RegExp(");
    expect(executeScriptExpression("youtube", "1")).toContain("indexOf(");
  });

  it("the generated picker runs and picks the right tab", () => {
    const code = executeScriptExpression("https://www.youtube.com/*", "1");
    const script = `const tabs=[{id:1,url:"https://news.test/"},{id:2,url:"https://www.youtube.com/watch?v=x"}];
      const browser={tabs:{query:async()=>tabs,executeScript:async(id)=>[id]}};
      (${code}).then(r=>process.stdout.write(JSON.stringify(r)));`;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-picker-"));

    try {
      const file = path.join(dir, "p.mjs");
      fs.writeFileSync(file, script);
      const run = spawnSync(process.execPath, [file], { encoding: "utf8" });
      expect(JSON.parse(run.stdout)).toEqual({ frames: [2] });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("and 99c, 99f: the descriptions say what the routes do", () => {
    expect(CALL_TIMEOUT.description).toMatch(/30000.*10000.*15000/);
    expect(evalSchema.description).toMatch(/user gesture/);
  });
});
