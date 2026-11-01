import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { readyContractPath } from "../lib/session-paths";
import { sessionPorts } from "../lib/session-ports";
import { actFailure, readyContract, safariDevContract } from "./fixtures/engine-answers";

import type * as ExecModule from "../lib/exec";
import type * as SafariBackgroundModule from "../lib/safari-background";
import type { ReadyContract } from "../lib/types";

const cli = vi.hoisted(() => ({
  calls: [] as string[][],
  replies: [] as Array<{ code: number; stdout: string; stderr: string }>,
}));

vi.mock("../lib/exec", async (importOriginal) => {
  const actual = await importOriginal<typeof ExecModule>();

  return {
    ...actual,
    runExtensionCli: async (args: string[]) => {
      cli.calls.push(args);

      return cli.replies.shift() ?? { code: 1, stdout: "", stderr: "" };
    },
  };
});

vi.mock("../lib/safari-background", async (importOriginal) => {
  const actual = await importOriginal<typeof SafariBackgroundModule>();

  return { ...actual, SAFARI_WAKE_WAIT_MS: 200 };
});

const { runActVerb } = await import("../lib/act");

const DETACHED = {
  executorAttachedAt: "2026-10-31T10:00:00.000Z",
  executorDetachedAt: "2026-10-31T10:00:30.000Z",
  runtime: "detached",
};

const TIMED_OUT = "the WebDriver session request failed: timed out";

function noExecutor(verb: string) {
  return {
    code: 1,
    stdout: JSON.stringify(actFailure(verb, { name: "ControlUnavailable", code: "E_CONTROL_UNAVAILABLE", message: "no executor connected" })),
    stderr: "",
  };
}

describe("a Safari run without a WebDriver window never hints a route that needs one", () => {
  let project: string;

  beforeEach(() => {
    project = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-safari-no-window-"));
    cli.calls.length = 0;
    cli.replies.length = 0;
    const dist = path.join(project, "dist", "safari");
    fs.mkdirSync(dist, { recursive: true });
    fs.writeFileSync(
      path.join(dist, "manifest.json"),
      JSON.stringify({ name: "Rebeccat", manifest_version: 3, content_scripts: [{ matches: ["http://127.0.0.1/*"], js: ["content.js"] }] }),
    );

    const file = readyContractPath(project, "safari");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(safariDevContract({ unavailableReason: TIMED_OUT }, DETACHED)));
  });

  afterEach(() => {
    fs.rmSync(project, { recursive: true, force: true });
  });

  it.each([
    ["eval", "extension_eval", ["eval", "1", "--context", "page", "--url", "http://127.0.0.1:8766/call.html"]],
    ["navigate", "extension_open", ["navigate", "http://127.0.0.1:8766/call.html"]],
  ] as const)("%s from %s names the hand wake and the restart, not the other tool", async (verb, tool, args) => {
      cli.replies.push(noExecutor(verb));

      const parsed = JSON.parse(await runActVerb([...args, project, "--browser", "safari"], project, undefined, tool));

      expect(parsed.ok).toBe(false);
      expect(parsed.error.code).toBe("E_CONTROL_UNAVAILABLE");
      expect(parsed.hint).toContain(`This run has no WebDriver window (${TIMED_OUT})`);
      expect(parsed.hint).toContain('extension_open url and extension_eval context "page" drive that same window and refuse the same way');
      expect(parsed.hint).toContain("click its toolbar button");
      expect(parsed.hint).toContain("extension_dev and replace: true");
      expect(parsed.hint).not.toContain("needs no background on Safari");
      expect(parsed.hint).not.toContain("the automation window navigates there");
      expect(cli.calls).toHaveLength(1);
  });
});

describe("the ready answer says up front whether a Safari run has its WebDriver window", () => {
  function ports(overrides: Record<string, unknown>, browser = "safari") {
    return sessionPorts(readyContract("dev", browser, overrides) as unknown as ReadyContract);
  }

  it("answers none with the engine's reason and the tools that cannot run", () => {
    const answer = ports({ webdriverUnavailableReason: TIMED_OUT });

    expect(answer.webdriver).toBe("none");
    expect(answer.webdriverNote).toContain(`This run has no WebDriver window: ${TIMED_OUT}.`);
    expect(answer.webdriverNote).toContain('extension_open url, extension_eval context "page" and extension_screenshot');
    expect(answer.webdriverNote).toContain("replace: true");
  });

  it("answers connected when ready.json names the session", () => {
    const answer = ports({ webdriverPort: 4444, webdriverSessionId: "S-1" });

    expect(answer.webdriver).toBe("connected");
    expect(answer.webdriverNote).toBeUndefined();
  });

  it("answers pending while the launcher has stamped neither", () => {
    const answer = ports({});

    expect(answer.webdriver).toBe("pending");
    expect(answer.webdriverNote).toContain("extension_wait reads it again");
  });

  it("adds nothing to a Chromium answer", () => {
    expect("webdriver" in ports({ cdpPort: 9222 }, "chrome")).toBe(false);
  });
});
