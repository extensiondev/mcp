import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import snapshot from "../lib/templates-meta.snapshot.json";

import type * as Exec from "../lib/exec";
import type * as TemplatesCache from "../lib/templates-cache";

const spawnCalls: Array<{ args: string[]; env?: Record<string, string> }> = [];
let engineProbe: "answers" | "exits" | "throws" = "answers";

vi.mock("../lib/boot-verdict", async (importOriginal) =>
  (await import("./fixtures/short-boot")).shortBootWindow(await importOriginal()),
);

vi.mock("node:timers/promises", async (importOriginal) =>
  (await import("./fixtures/short-boot")).shortSleeps(await importOriginal()),
);

vi.mock("../lib/exec", async (importOriginal) => {
  const actual = await importOriginal<typeof Exec>();

  return {
    ...actual,
    runExtensionCli: vi.fn(async (args: string[], options?: Parameters<typeof actual.runExtensionCli>[1]) => {
      if (engineProbe === "answers" || !["capabilities", "--version"].includes(args[0])) return actual.runExtensionCli(args, options);
      if (engineProbe === "throws") throw new Error("the probe timed out");

      return { code: 1, stdout: "", stderr: "" };
    }),
    spawnExtensionCli: vi.fn((args: string[], options?: { env?: Record<string, string> }) => {
      spawnCalls.push({ args, env: options?.env });
      const child = Object.assign(new EventEmitter(), { pid: 4_000_000 + spawnCalls.length, exitCode: null, signalCode: null });

      return { child, logPath: "/dev/null", readOutput: () => "" };
    }),
  };
});

const catalogRows = (snapshot as { templates: Array<{ slug: string; surfaces?: string[] }> }).templates;

vi.mock("../lib/templates-cache", async (importOriginal) => {
  const actual = await importOriginal<typeof TemplatesCache>();

  return {
    ...actual,
    listTemplates: async (filters?: { surface?: string }) =>
      catalogRows.filter((t) => !filters?.surface || (t.surfaces ?? []).includes(filters.surface)),
    getTemplateBySlug: async (slug: string) => catalogRows.find((t) => t.slug === slug),
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
const { geckoLaunchEnv, geckoSocketWarning } = await import("../lib/gecko-socket-process");
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

  it("a Gecko launch on Linux runs without the socket process, whose fork the engine adopts as the browser", () => {
    expect(geckoLaunchEnv("gecko-based", "linux", {})).toEqual({ MOZ_DISABLE_SOCKET_PROCESS: "1" });
    expect(geckoLaunchEnv("firefox", "linux", {})).toEqual({ MOZ_DISABLE_SOCKET_PROCESS: "1" });
    expect(geckoLaunchEnv("firefox", "darwin", {})).toBeNull();
    expect(geckoLaunchEnv("chrome", "linux", {})).toBeNull();
    expect(geckoLaunchEnv("firefox", "linux", { MOZ_DISABLE_SOCKET_PROCESS: "0" })).toBeNull();
    expect(geckoLaunchEnv("firefox", "linux", { EXTENSION_KEEP_SOCKET_PROCESS: "1" })).toBeNull();
    expect(geckoLaunchEnv("firefox", "linux", { EXTENSION_KEEP_SOCKET_PROCESS: "true" })).toBeNull();
    expect(geckoLaunchEnv("firefox", "linux", { EXTENSION_KEEP_SOCKET_PROCESS: "0" })).toEqual({ MOZ_DISABLE_SOCKET_PROCESS: "1" });
  });

  it("987: only an engine older than 4.3.0, or one whose version is unknown, gets the variable and the warning", () => {
    for (const older of ["4.1.41", "4.2.0", "4.3.0-canary.1", "not a version", null]) {
      expect(geckoLaunchEnv("firefox", "linux", {}, older), String(older)).toEqual({ MOZ_DISABLE_SOCKET_PROCESS: "1" });
      expect(geckoSocketWarning("firefox", false, "linux", {}, older), String(older)).toMatch(/Move the project to Extension\.js 4\.3\.0 or later and relaunch with replace: true to keep the socket process\.$/);
    }

    for (const fixed of ["4.3.0", "4.3.1", "5.0.0-canary.2"]) {
      expect(geckoLaunchEnv("firefox", "linux", {}, fixed), fixed).toBeNull();
      expect(geckoSocketWarning("firefox", false, "linux", {}, fixed), fixed).toBeNull();
    }

    expect(geckoSocketWarning("firefox", false, "linux", {}, "4.2.0")).toBe(
      "This Linux Firefox runs with MOZ_DISABLE_SOCKET_PROCESS=1 because the Extension.js engine that runs this session is 4.2.0, and an engine older than 4.3.0 can lose the browser at startup without it. Firefox's WebRTC networking runs on the socket process, so RTCPeerConnection in this session likely connects no peers. Move the project to Extension.js 4.3.0 or later and relaunch with replace: true to keep the socket process.",
    );

    expect(geckoSocketWarning("firefox", false, "linux", {}, null)).toContain("because the version of the Extension.js engine that runs this session could not be read, and an engine older than 4.3.0");
    expect(geckoSocketWarning("firefox", false, "linux", { MOZ_DISABLE_SOCKET_PROCESS: "1" }, "4.3.0")).toMatch(/whatever its value, 0 included/);
    expect(geckoLaunchEnv("firefox", "linux", { MOZ_DISABLE_SOCKET_PROCESS: "1" }, "4.2.0")).toBeNull();
    expect(geckoSocketWarning("firefox", false, "linux", { EXTENSION_KEEP_SOCKET_PROCESS: "1" }, "4.2.0")).toBeNull();
  });

  it("warns about WebRTC only when a Linux Firefox launches without its socket process", () => {
    expect(geckoSocketWarning("firefox", false, "linux", {})).toMatch(/This Linux Firefox runs with MOZ_DISABLE_SOCKET_PROCESS=1/);
    expect(geckoSocketWarning("firefox", true, "linux", {})).toBeNull();
    expect(geckoSocketWarning("firefox", false, "darwin", {})).toBeNull();
    expect(geckoSocketWarning("firefox", false, "linux", { EXTENSION_KEEP_SOCKET_PROCESS: "1" })).toBeNull();
    expect(geckoSocketWarning("firefox", false, "linux", { MOZ_DISABLE_SOCKET_PROCESS: "0" })).toMatch(/whatever its value, 0 included.*RTCPeerConnection/);
    expect(geckoSocketWarning("firefox", false, "linux", { MOZ_DISABLE_SOCKET_PROCESS: "0" })).toMatch(/Remove it, set EXTENSION_KEEP_SOCKET_PROCESS=1 in this server's environment, then relaunch with replace: true\.$/);
    expect(geckoLaunchEnv("firefox", "linux", { EXTENSION_KEEP_SOCKET_PROCESS: "1" })).toBeNull();
  });

  it.each([
    ["extension_dev", () => dev],
    ["extension_start", () => start],
  ] as const)("987: %s hands a Linux Gecko launch the socket-process variable by the engine that runs the session", async (_name, tool) => {
    const projectPath = tmp("mcp-gecko-env-");
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    const inherited = { moz: process.env.MOZ_DISABLE_SOCKET_PROCESS, keep: process.env.EXTENSION_KEEP_SOCKET_PROCESS, pin: process.env.EXTENSION_MCP_CLI_VERSION };

    const launch = async (pin: string, more: Record<string, unknown> = {}, probe: typeof engineProbe = "answers") => {
      process.env.EXTENSION_MCP_CLI_VERSION = pin;
      engineProbe = probe;
      spawnCalls.length = 0;

      try {
        const out = JSON.parse(await tool().handler({ projectPath, browser: "firefox", wait: false, ...more }));

        return { env: spawnCalls[0]?.env ?? {}, warnings: ((out.warnings ?? []) as string[]).join(" ") };
      } finally {
        removeSession(projectPath, "firefox");
      }
    };

    delete process.env.MOZ_DISABLE_SOCKET_PROCESS;
    delete process.env.EXTENSION_KEEP_SOCKET_PROCESS;
    Object.defineProperty(process, "platform", { ...platform, value: "linux" });

    try {
      const older = await launch("4.2.0");

      expect(older.env).toMatchObject({ MOZ_DISABLE_SOCKET_PROCESS: "1" });
      expect(older.warnings).toMatch(/engine that runs this session is 4\.2\.0.*WebRTC.*Move the project to Extension\.js 4\.3\.0 or later/);

      for (const [pin, probe] of [["unread-exits", "exits"], ["unread-throws", "throws"]] as const) {
        const unread = await launch(pin, {}, probe);

        expect(unread.env).toMatchObject({ MOZ_DISABLE_SOCKET_PROCESS: "1" });
        expect(unread.warnings).toMatch(/engine that runs this session could not be read.*WebRTC/);
      }

      const fixed = await launch("4.3.0");

      expect(fixed.env).not.toHaveProperty("MOZ_DISABLE_SOCKET_PROCESS");
      expect(fixed.warnings).not.toMatch(/WebRTC|MOZ_DISABLE_SOCKET_PROCESS/);

      const buildOnly = await launch("4.2.0", { noBrowser: true });

      expect(buildOnly.warnings).not.toMatch(/WebRTC/);

      process.env.EXTENSION_KEEP_SOCKET_PROCESS = "1";

      const kept = await launch("4.2.0");

      expect(kept.env).not.toHaveProperty("MOZ_DISABLE_SOCKET_PROCESS");
      expect(kept.warnings).not.toMatch(/WebRTC/);

      delete process.env.EXTENSION_KEEP_SOCKET_PROCESS;
      process.env.MOZ_DISABLE_SOCKET_PROCESS = "0";

      const own = await launch("4.3.0");

      expect(own.env).not.toHaveProperty("MOZ_DISABLE_SOCKET_PROCESS");
      expect(own.warnings).toMatch(/MOZ_DISABLE_SOCKET_PROCESS is set in this server's environment.*Remove it, set EXTENSION_KEEP_SOCKET_PROCESS=1/);
    } finally {
      Object.defineProperty(process, "platform", platform);
      engineProbe = "answers";

      for (const [name, value] of [["MOZ_DISABLE_SOCKET_PROCESS", inherited.moz], ["EXTENSION_KEEP_SOCKET_PROCESS", inherited.keep], ["EXTENSION_MCP_CLI_VERSION", inherited.pin]] as const) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  }, 30_000);

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
    expect(out.value.hiddenBrowserUi).toEqual([
      {
        flag: "--silent-debugger-extension-api",
        hides: "the \"started debugging this browser\" bar Chrome shows above the page while the extension holds chrome.debugger.attach, with its Cancel button",
        showAgain: 'set browser.chrome.excludeBrowserFlags: ["--silent-debugger-extension-api"] in extension.config.js and call extension_dev again with replace: true',
      },
    ]);

    expect(out.hint).toContain("--silent-debugger-extension-api");
    expect(out.hint).toContain("excludeBrowserFlags");
    expect(sessionIsHeadless(projectPath, "chrome")).toBe(false);
    expect(sessionIsHeadless()).toBe(true);
    removeSession(projectPath, "chrome");
  }, 15_000);

  it("a headless extension_dev answer tells the agent the person cannot see the browser", async () => {
    const projectPath = tmp("mcp-headless-dev-");
    const out = JSON.parse(await dev.handler({ projectPath, wait: false }));

    expect(spawnCalls[0]?.env).toBeUndefined();
    expect(out.value.headless).toBe(true);
    expect(out.value).not.toHaveProperty("hiddenBrowserUi");
    expect(out.hint).toMatch(/not visible to the person/);
    expect(out.hint).toMatch(/headless: false/);
    expect(out.hint).not.toContain("--silent-debugger-extension-api");
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
