import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { envelope } from "../lib/envelope";
import { webdriverSessionEndedHint } from "../lib/webdriver";
import { actVerbAnswer, evalRefusal } from "./fixtures/engine-answers";

import type * as ActModule from "../lib/act";

type Call = { cli: string[]; expression: string };
const calls: Call[] = [];
let respond: (call: Call) => string = () =>
  envelope({ ok: true, command: "extension_eval", status: "ok", value: 1 });

vi.mock("../lib/act", async (importOriginal) => {
  const actual = await importOriginal<typeof ActModule>();

  return {
    ...actual,
    runActVerb: async (cli: string[]) => {
      const at = cli.indexOf("--");
      const call = { cli, expression: at === -1 ? "" : cli[at + 1] };
      calls.push(call);

      return respond(call);
    },
  };
});

const evalTool = await import("../tools/eval");

const dirs: string[] = [];

function project(browser: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-eval-safari-"));
  dirs.push(dir);
  const dist = path.join(dir, "dist", browser);
  fs.mkdirSync(dist, { recursive: true });
  fs.writeFileSync(
    path.join(dist, "manifest.json"),
    JSON.stringify({
      manifest_version: 3,
      name: "Leon",
      background: { service_worker: "bg.js" },
      action: { default_popup: "popup.html" },
    }),
  );

  return dir;
}

const webkitCspRefusal = () =>
  actVerbAnswer(
    evalRefusal({
      code: "E_CSP_BLOCKS_EVAL",
      name: "CspBlocksEval",
      message:
        'eval is blocked in the extension background by the extension\'s content_security_policy, which allows no unsafe-eval. Use context: "page" (targets the active tab; pass url or tab to pick another) (eval runs in the page\'s MAIN world), or run on a build whose CSP permits it. Engine: webkit',
      engine: "webkit",
    }),
    "extension_eval",
  );

afterEach(() => {
  calls.length = 0;
  respond = () => envelope({ ok: true, command: "extension_eval", status: "ok", value: 1 });
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("extension_eval on Safari names the contexts it cannot reach", () => {
  it("refuses a background eval with the Safari limit and the three alternatives", async () => {
    const dir = project("safari");
    respond = webkitCspRefusal;

    const result = JSON.parse(
      await evalTool.handler({ projectPath: dir, browser: "safari", context: "background", expression: "1" }),
    );

    expect(result.ok).toBe(false);
    expect(result.status).toBe("safari-context-unreachable");
    expect(result.error.code).toBe("E_SAFARI_CONTEXT_UNREACHABLE");
    expect(result.error.message).toContain("reaches only page contexts");
    expect(result.error.message).toContain("WebDriver");
    expect(result.error.message).toContain("The background context is out of reach");
    expect(result.value).toEqual({ browser: "safari", context: "background" });
    expect(result.hint).toContain("extension_logs");
    expect(result.hint).toContain("extension_open url");
    expect(result.hint).toContain('extension_eval context: "page"');
    expect(result.hint).toContain("extension_screenshot");
    expect(result.hint).toContain("regular Safari window is outside the session");
    expect(JSON.stringify(result)).not.toContain("On a Chromium MV3 session");
    expect(calls).toHaveLength(1);
  });

  it("treats a Safari eval with no context as the background", async () => {
    const dir = project("safari");
    respond = webkitCspRefusal;

    const result = JSON.parse(await evalTool.handler({ projectPath: dir, browser: "safari", expression: "1" }));

    expect(result.status).toBe("safari-context-unreachable");
    expect(result.value.context).toBe("background");
  });

  it("refuses a popup eval the same way, naming the surface", async () => {
    const dir = project("safari");
    respond = webkitCspRefusal;

    const result = JSON.parse(
      await evalTool.handler({ projectPath: dir, browser: "safari", context: "popup", expression: "1" }),
    );

    expect(result.status).toBe("safari-context-unreachable");
    expect(result.error.message).toContain("The popup context is out of reach");
    expect(result.hint).toContain("run the same project on chrome or firefox");
  });

  it("stops an until poll on the Safari refusal instead of repeating it", async () => {
    const dir = project("safari");
    respond = webkitCspRefusal;

    const result = JSON.parse(
      await evalTool.handler({
        projectPath: dir,
        browser: "safari",
        context: "background",
        expression: "1",
        until: { timeoutMs: 3000 },
      }),
    );

    expect(result.status).toBe("safari-context-unreachable");
    expect(calls).toHaveLength(1);
  });

  it("leaves the same CSP refusal on Firefox to the engine-aware CSP hint", async () => {
    const dir = project("firefox");
    respond = () =>
      actVerbAnswer(
        evalRefusal({ code: "E_CSP_BLOCKS_EVAL", name: "CspBlocksEval", message: "eval is blocked by the extension's content_security_policy", engine: "firefox" }),
        "extension_eval",
      );

    const result = JSON.parse(
      await evalTool.handler({ projectPath: dir, browser: "firefox", context: "background", expression: "1" }),
    );

    expect(result.status).not.toBe("safari-context-unreachable");
    expect(result.error.name).toBe("CspBlocksEval");
    expect(result.hint).toContain("On Firefox");
  });

  it("leaves a genuine expression error on Safari alone", async () => {
    const dir = project("safari");
    respond = () =>
      actVerbAnswer(
        evalRefusal({ code: "E_EVAL", name: "ReferenceError", message: "nope is not defined", engine: "webkit" }),
        "extension_eval",
      );

    const result = JSON.parse(
      await evalTool.handler({ projectPath: dir, browser: "safari", context: "background", expression: "nope" }),
    );

    expect(result.status).not.toBe("safari-context-unreachable");
    expect(result.error.name).toBe("ReferenceError");
  });

  it("carries the Safari sentence in the description", () => {
    const description = evalTool.schema.description;

    expect(description).toContain("On Safari this tool reaches only page contexts");
    expect(description).toContain("extension_logs reads the background");
  });

  it("tells a dead-session answer how to get a driveable window back without a Settings trip", () => {
    const hint = webdriverSessionEndedHint("safari");

    expect(hint).toContain("The session ended; the dev server did not");
    expect(hint).toContain('browser: "safari", replace: true and enableExtension: true');
    expect(hint).toContain("allowEval: true");
    expect(hint).toContain("no Settings trip");
    expect(hint).toContain("Accessibility grant");
    expect(hint).not.toContain("extension_stop");
  });
});
