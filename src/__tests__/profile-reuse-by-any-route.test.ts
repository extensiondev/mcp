import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type * as Exec from "../lib/exec";
import type * as WaitModule from "../tools/wait";
import type * as LogsModule from "../tools/logs";

let onSpawn: () => void = () => {};

let spawnCount = 0;

vi.mock("../lib/exec", async (importOriginal) => {
  const actual = await importOriginal<typeof Exec>();

  return {
    ...actual,
    spawnExtensionCli: vi.fn(() => {
      spawnCount += 1;
      onSpawn();
      const child = Object.assign(new EventEmitter(), { pid: 4_100_000 + spawnCount, exitCode: null, signalCode: null });

      return { child, logPath: "/dev/null", readOutput: () => "" };
    }),
  };
});

let readyProfilePath: string | null = null;

vi.mock("../tools/wait", async (importOriginal) => {
  const actual = await importOriginal<typeof WaitModule>();

  return {
    ...actual,
    handler: async () =>
      JSON.stringify({
        ok: true,
        status: "ready",
        value: {
          compiled: true,
          browserAttached: true,
          guestLoaded: true,
          ...(readyProfilePath ? { profilePath: readyProfilePath } : {}),
        },
      }),
  };
});

vi.mock("../tools/logs", async (importOriginal) => {
  const actual = await importOriginal<typeof LogsModule>();

  return {
    ...actual,
    handler: async () => JSON.stringify({ ok: true, status: "ok", value: { count: 0, lines: [] } }),
  };
});

const dev = await import("../tools/dev");
const { removeSession } = await import("../lib/process-manager");
const { sessionProfileReused } = await import("../lib/profile-carryover");

const TEMPLATE_CONFIG = [
  "const profile = (name) => './dist/extension-profile-' + name",
  "",
  "export default {",
  "  browser: {",
  "    chrome: {profile: profile('chrome')},",
  "    firefox: {profile: profile('firefox')}",
  "  }",
  "}",
  "",
].join("\n");

const dirs: string[] = [];

function project(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-profile-reuse-"));
  dirs.push(dir);
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "fixture", devDependencies: { extension: "*" } }));
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src", "manifest.json"), "{}");
  fs.writeFileSync(path.join(dir, "extension.config.js"), TEMPLATE_CONFIG);

  return dir;
}

function seedChromeState(dir: string): void {
  fs.mkdirSync(path.join(dir, "Default", "Local Extension Settings"), { recursive: true });
  fs.writeFileSync(path.join(dir, "Default", "Preferences"), "{}");
  fs.writeFileSync(path.join(dir, "Local State"), "{}");
}

function configProfile(dir: string): string {
  return path.join(dir, "dist", "extension-profile-chrome");
}

function reuseWarning(out: { warnings?: string[] }): string | undefined {
  return (out.warnings ?? []).find((w) => /extension_storage/.test(w));
}

beforeEach(() => {
  onSpawn = () => {};

  readyProfilePath = null;
});

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    removeSession(dir, "chrome");
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("extension_dev says when the browser profile already holds state, by any route", () => {
  it("leads with the reuse when extension.config.js sets a profile that holds an earlier run", async () => {
    const dir = project();
    seedChromeState(configProfile(dir));

    const out = JSON.parse(await dev.handler({ projectPath: dir, wait: false }));

    expect(out.status, JSON.stringify(out).slice(0, 600)).toBe("started");
    expect(out.value.profileReused).toBe(true);
    const warning = reuseWarning(out);
    expect(warning, JSON.stringify(out.warnings)).toBeDefined();
    expect(out.warnings[0]).toBe(warning);
    expect(warning).toMatch(/chrome\.storage/);
    expect(warning).toMatch(/permissions/);
    expect(warning).toMatch(/tabs/);
    expect(sessionProfileReused(dir, "chrome")).toBe(true);
  }, 15_000);

  it("judges held state from before the launch, not from what the browser writes on start", async () => {
    const dir = project();
    fs.mkdirSync(configProfile(dir), { recursive: true });
    onSpawn = () => seedChromeState(configProfile(dir));

    const out = JSON.parse(await dev.handler({ projectPath: dir, wait: false }));

    expect(out.status).toBe("started");
    expect(out.value.profileReused).toBe(false);
    expect(reuseWarning(out)).toBeUndefined();
  }, 15_000);

  it("trusts the folder the engine reports it launched on over the config guess", async () => {
    const dir = project();
    seedChromeState(configProfile(dir));
    const engineFolder = path.join(dir, "elsewhere-profile");

    onSpawn = () => {
      setTimeout(() => seedChromeState(engineFolder), 100);
    };

    readyProfilePath = engineFolder;

    const out = JSON.parse(await dev.handler({ projectPath: dir }));

    expect(out.value.ready.status).toBe("ready");
    expect(out.value.profileReused).toBe(false);
    expect(reuseWarning(out)).toBeUndefined();
    expect(sessionProfileReused(dir, "chrome")).toBe(false);
  }, 15_000);

  it("flags a folder the engine reports that held state before launch though nothing predicted it", async () => {
    const dir = project();
    fs.rmSync(path.join(dir, "extension.config.js"));
    const engineFolder = path.join(dir, "engine-chosen-profile");
    seedChromeState(engineFolder);
    await new Promise((resolve) => setTimeout(resolve, 50));
    readyProfilePath = engineFolder;

    const out = JSON.parse(await dev.handler({ projectPath: dir }));

    expect(out.value.ready.status).toBe("ready");
    expect(out.value.profileReused).toBe(true);
    expect(out.warnings[0]).toBe(reuseWarning(out));
    expect(sessionProfileReused(dir, "chrome")).toBe(true);
  }, 15_000);
});
