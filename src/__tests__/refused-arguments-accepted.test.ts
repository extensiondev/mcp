// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { writeCredentials } from "../lib/credentials";
import { envelope } from "../lib/envelope";
import { readStoreSettingsChange } from "../lib/store-settings";
import { logsPath } from "../lib/session-paths";
import { normalizeArgAliases, validateToolInput } from "../lib/validate-input";
import { handler as logs, schema as logsSchema } from "../tools/logs";
import { handler as submit } from "../tools/submit-local";
import { API, PROJECT_ROUTE, useProjectRoutes } from "./fixtures/project-routes";
import { logEvent, logFile } from "./fixtures/engine-answers";
import { writeModernContract } from "./fixtures/ready-contract";

import type * as LoginModule from "../tools/login";

const logins: string[] = [];

vi.mock("../tools/login", async (importOriginal) => {
  const actual = await importOriginal<typeof LoginModule>();

  return {
    ...actual,
    loginToProject: async (args: { project: string }) => {
      logins.push(args.project);

      return envelope({ ok: true, command: "extension_auth", status: "login-pending", value: { project: args.project } });
    },
  };
});

const { handler: auth, schema: authSchema } = await import("../tools/auth");

let dir: string;
let xdg: string;

function projectDir(origin: string | null, name = "widget"): string {
  const root = path.join(dir, `p-${Math.random().toString(16).slice(2, 8)}`);
  fs.mkdirSync(path.join(root, ".git"), { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name }));
  fs.writeFileSync(path.join(root, ".git", "config"), origin ? `[remote "origin"]\n\turl = ${origin}\n` : "[core]\n\tbare = false\n");

  return root;
}

describe("extension_auth login takes projectPath and resolves the project from it", () => {
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-461-auth-"));
    xdg = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-461-xdg-"));
    vi.stubEnv("XDG_CONFIG_HOME", xdg);
    vi.stubEnv("EXTENSION_DEV_TOKEN", "");
    vi.stubEnv("EXTENSION_DEV_PROJECT", "");
    logins.length = 0;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(xdg, { recursive: true, force: true });
  });

  it("accepts projectPath in its schema", () => {
    expect(validateToolInput(authSchema.inputSchema, { action: "login", projectPath: "/x" })).toEqual([]);
  });

  it("logs in to the GitHub origin's project when no login is stored, and says so", async () => {
    const out = JSON.parse(await auth({ action: "login", projectPath: projectDir("git@github.com:acme/widget.git"), api: API }));

    expect(logins).toEqual(["acme/widget"]);
    expect(out.warnings.join(" ")).toContain("Logging in to acme/widget, the project at projectPath (its GitHub origin)");
  });

  it("prefers the stored login the directory names", async () => {
    writeCredentials({ version: 1, token: "claims.sig", workspaceSlug: "acme", projectSlug: "widget", expiresAt: Math.floor(Date.now() / 1000) + 3600, api: API });

    const out = JSON.parse(await auth({ action: "login", projectPath: projectDir("https://github.com/someone/elsewhere"), api: API }));

    expect(logins).toEqual(["acme/widget"]);
    expect(out.warnings.join(" ")).toContain("a stored login");
  });

  it("keeps a named project over projectPath", async () => {
    await auth({ action: "login", project: "acme/other", projectPath: projectDir("git@github.com:acme/widget.git"), api: API });

    expect(logins).toEqual(["acme/other"]);
  });

  it("refuses a directory that names no project, before any login starts", async () => {
    const out = JSON.parse(await auth({ action: "login", projectPath: projectDir(null), api: API }));

    expect(out.status).toBe("bad-request");
    expect(out.error.message).toContain("Pass project as '<workspace>/<project>'");
    expect(logins).toEqual([]);
  });
});

describe("extension_logs match answers only matching lines with the counts", () => {
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-461-logs-"));
    writeModernContract(dir, "chrome", { pid: process.pid, runId: "run-1" });

    const file = logsPath(dir, "chrome");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      logFile("run-1", [
        logEvent("background", "info", ["Extension enabled"], { seq: 1 }),
        logEvent("background", "info", ["tab opened"], { seq: 2 }),
        logEvent("content", "warn", ["re-ENABLED after reload", { id: 7 }], { seq: 3 }),
      ]),
    );
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("keeps the substring's lines, case-insensitive, with matched of total", async () => {
    const out = JSON.parse(await logs({ projectPath: dir, browser: "chrome", match: "nabl" }));

    expect(out.value.matched).toBe(2);
    expect(out.value.total).toBe(3);
    expect(out.value.events.map((event: { seq: number }) => event.seq)).toEqual([1, 3]);
  });

  it("takes a regex", async () => {
    const out = JSON.parse(await logs({ projectPath: dir, browser: "chrome", match: "^tab\\s" }));

    expect(out.value.events.map((event: { seq: number }) => event.seq)).toEqual([2]);
  });

  it("answers empty with the total when nothing matches", async () => {
    const out = JSON.parse(await logs({ projectPath: dir, browser: "chrome", match: "nothing-like-this" }));

    expect(out.status).toBe("empty");
    expect(out.value.total).toBe(3);
  });

  it("folds grep onto match and no longer refuses it", () => {
    const args = normalizeArgAliases(logsSchema.inputSchema, { projectPath: dir, grep: "nabl" });

    expect(args).toEqual({ projectPath: dir, match: "nabl" });
    expect(validateToolInput(logsSchema.inputSchema, args)).toEqual([]);
  });
});

describe("configure-store reads an unambiguous storeId as the store's listing id", () => {
  const platform = useProjectRoutes("mcp-461-store-");

  it("writes Safari storeId as appStoreId with a warning, not a refusal", async () => {
    if (process.platform === "win32") return;

    platform.login();
    platform.routes[`PUT ${PROJECT_ROUTE}/stores/config`] = () => ({ body: { ok: true, store: "safari", changes: ['safari.storeId: "" -> "6831748859"'] } });

    const out = JSON.parse(await submit({ action: "configure-store", store: "safari", storeSettings: { storeId: "6831748859" }, api: API }));
    const [put] = platform.sent("PUT", `${PROJECT_ROUTE}/stores/config`);

    expect(out.status).toBe("store-configured");
    expect(put.body).toEqual({ safari: { storeId: "6831748859" } });
    expect(out.value.storeSettings).toEqual({ appStoreId: "6831748859" });
    expect(out.warnings.join(" ")).toContain("storeSettings.storeId was read as appStoreId");
  });

  it("maps each store's storeId to its own id key", () => {
    expect(readStoreSettingsChange("edge", { storeId: "12345678-1234-1234-1234-123456789abc" })).toMatchObject({ requested: { edgeProductId: "12345678-1234-1234-1234-123456789abc" } });
    expect(readStoreSettingsChange("firefox", { storeId: "widget@example.com" })).toMatchObject({ requested: { firefoxAddonGuid: "widget@example.com" } });
  });

  it("still refuses a storeId whose meaning is ambiguous", () => {
    const bundleLike = readStoreSettingsChange("safari", { storeId: "com.acme.widget" });
    const conflicting = readStoreSettingsChange("safari", { storeId: "6831748859", appStoreId: "6831748860" });

    expect("problem" in bundleLike && bundleLike.problem).toMatch(/"storeId", which is a raw platform field/);
    expect("problem" in conflicting && conflicting.problem).toMatch(/"storeId", which is a raw platform field/);
  });
});
