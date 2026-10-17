import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type * as Exec from "../lib/exec";

const spawnCalls: Array<{ args: string[]; env?: Record<string, string> }> = [];

vi.mock("../lib/exec", async (importOriginal) => {
  const actual = await importOriginal<typeof Exec>();

  return {
    ...actual,
    spawnExtensionCli: vi.fn((args: string[], options?: { env?: Record<string, string> }) => {
      spawnCalls.push({ args, env: options?.env });
      const child = Object.assign(new EventEmitter(), { pid: 4_000_000 + spawnCalls.length, exitCode: null, signalCode: null });

      return { child, logPath: "/dev/null", readOutput: () => "" };
    }),
  };
});

vi.mock("extension-create", () => ({
  extensionCreate: vi.fn(async (_input: string, opts: { template: string }) => {
    fs.mkdirSync(scaffoldTarget, { recursive: true });
    fs.writeFileSync(path.join(scaffoldTarget, "manifest.json"), "{}");

    return {
      projectPath: scaffoldTarget,
      projectName: path.basename(scaffoldTarget),
      template: opts.template,
      depsInstalled: true,
      packageManager: "npm",
    };
  }),
}));

let scaffoldTarget = "";

const { headlessLaunch } = await import("../lib/launch-flags");
const dev = await import("../tools/dev");
const start = await import("../tools/start");
const { sessionIsHeadless } = await import("../tools/open");
const { removeSession } = await import("../lib/process-manager");
const create = await import("../tools/create");
const addFeature = await import("../tools/add-feature");
const { SERVER_INSTRUCTIONS } = await import("../index");

const ENV_KEYS = [
  "EXTENSION_HEADLESS",
  "EXTENSION_BROWSER_FLAGS",
  "EXTENSION_DEV_NO_TELEMETRY",
  "EXTENSION_TEMPLATES_COMMIT",
];
const saved: Record<string, string | undefined> = {};
const dirs: string[] = [];

function tmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);

  return dir;
}

beforeEach(() => {
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  process.env.EXTENSION_HEADLESS = "1";
  process.env.EXTENSION_BROWSER_FLAGS = "--window-size=1280,800 --headless=new";
  process.env.EXTENSION_DEV_NO_TELEMETRY = "1";
  process.env.EXTENSION_TEMPLATES_COMMIT = "f7f4e6efb56a7e5ae08d58dbff3972d94af7d021";
  spawnCalls.length = 0;
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }

  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("a person can ask to see the browser (headless input)", () => {
  it("headless: false clears the inherited headless levers for the child only", () => {
    const env = { EXTENSION_HEADLESS: "1", EXTENSION_BROWSER_FLAGS: "--foo --headless=new -headless --bar" };

    expect(headlessLaunch({ headless: false }, env)).toEqual({
      headless: false,
      env: { EXTENSION_HEADLESS: "0", EXTENSION_BROWSER_FLAGS: "--foo --bar" },
    });

    expect(env.EXTENSION_HEADLESS).toBe("1");
  });

  it("headless: true forces it and an omitted input inherits the environment", () => {
    expect(headlessLaunch({ headless: true }, {})).toEqual({
      headless: true,
      env: { EXTENSION_HEADLESS: "1" },
    });

    expect(headlessLaunch({}, { EXTENSION_HEADLESS: "1" })).toEqual({ headless: true });
    expect(headlessLaunch({}, {})).toEqual({ headless: false });
  });

  it("extension_dev and extension_start take the input", () => {
    for (const schema of [dev.schema, start.schema]) {
      const prop = (schema.inputSchema.properties as Record<string, { type?: string }>).headless;
      expect(prop?.type, schema.name).toBe("boolean");
    }
  });

  it("extension_dev with headless: false spawns a visible browser and says so", async () => {
    const projectPath = tmp("mcp-headless-dev-");
    const out = JSON.parse(await dev.handler({ projectPath, headless: false, wait: false }));

    expect(spawnCalls[0]?.env).toEqual({ EXTENSION_HEADLESS: "0", EXTENSION_BROWSER_FLAGS: "--window-size=1280,800" });
    expect(out.status, JSON.stringify(out).slice(0, 600)).toBe("started");
    expect(out.value.headless).toBe(false);
    expect(sessionIsHeadless(projectPath, "chrome")).toBe(false);
    expect(sessionIsHeadless()).toBe(true);
    removeSession(projectPath, "chrome");
  }, 15_000);

  it("a headless extension_dev answer tells the agent the person cannot see the browser", async () => {
    const projectPath = tmp("mcp-headless-dev-");
    const out = JSON.parse(await dev.handler({ projectPath, wait: false }));

    expect(spawnCalls[0]?.env).toBeUndefined();
    expect(out.value.headless).toBe(true);
    expect(out.hint).toMatch(/not visible to the person/);
    expect(out.hint).toMatch(/headless: false/);
    removeSession(projectPath, "chrome");
  }, 15_000);
});

describe("next steps lead with the tool path, not a shell command", () => {
  it("extension_create never hands the person `npm run dev`", async () => {
    scaffoldTarget = path.join(tmp("mcp-next-steps-"), "demo");
    const out = JSON.parse(await create.handler({ projectName: scaffoldTarget, template: "javascript" }));
    const steps: string[] = out.value.nextSteps;

    expect(steps.join("\n")).not.toMatch(/run dev/);
    expect(steps.join("\n")).toMatch(/extension_dev/);
    expect(steps.join("\n")).toMatch(/Want me to open it in Chrome so you can try it\?/);
    expect(out.value.manualAlternative).toMatch(/npm run dev/);
  });

  it("extension_add_feature's last step names extension_dev and no shell command", async () => {
    const projectPath = tmp("mcp-add-feature-");
    fs.mkdirSync(path.join(projectPath, "src"));
    fs.writeFileSync(path.join(projectPath, "src/manifest.json"), JSON.stringify({ manifest_version: 3, name: "x", version: "1.0.0" }));
    const out = JSON.parse(await addFeature.handler({ projectPath, feature: "popup" }));
    const last = (out.value.instructions as string[]).slice(-1)[0] ?? "";

    expect(last).not.toMatch(/npm run dev/);
    expect(last).toMatch(/extension_dev/);
    expect(last).toMatch(/Want me to open it in Chrome so you can try it\?/);
  });

  it("the server instructions tell every harness to open the browser itself", () => {
    expect(SERVER_INSTRUCTIONS).toMatch(/never hand the person a shell command/);
    expect(SERVER_INSTRUCTIONS).toMatch(/headless: false/);
  });
});
