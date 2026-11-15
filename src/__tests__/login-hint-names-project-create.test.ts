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

import { listArtifacts } from "../lib/artifacts-api";
import { uploadPreview } from "../lib/preview-upload";
import { handler as previewWeb } from "../tools/preview-web";
import { handler as publish } from "../tools/publish";
import { handler as shares } from "../tools/shares";
import { forwardable } from "../lib/hosted-forwarder";
import * as buildsTool from "../tools/builds";
import * as publishTool from "../tools/publish";
import * as releaseStatusTool from "../tools/release-status";
import * as sharesTool from "../tools/shares";

import type { ToolModule } from "../lib/tool-dispatch";

const fetchCalls: string[] = [];
let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-login-hint-"));
  vi.stubEnv("XDG_CONFIG_HOME", fs.mkdtempSync(path.join(os.tmpdir(), "mcp-login-hint-xdg-")));
  vi.stubEnv("HOME", dir);
  vi.stubEnv("EXTENSION_DEV_TOKEN", "");
  vi.stubEnv("EXTENSION_DEV_PROJECT", "");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: unknown) => {
      fetchCalls.push(String(url));

      throw new Error("login-hint tests never reach the network");
    }),
  );
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  fetchCalls.length = 0;
  fs.rmSync(dir, { recursive: true, force: true });
});

function distDir(): string {
  const dist = path.join(dir, "dist", "chrome");
  fs.mkdirSync(dist, { recursive: true });
  fs.writeFileSync(path.join(dist, "manifest.json"), JSON.stringify({ manifest_version: 3, name: "P", version: "1.0.0" }));

  return dist;
}

const namesProjectCreate = (text: unknown) => {
  expect(String(text)).toContain("extension_project_create");
  expect(String(text)).toMatch(/GitHub repository/);
};

describe("a missing login names extension_project_create, since an extension with no project cannot log in at all", () => {
  it.each([
    ["extension_publish", publishTool, {}],
    ["extension_shares", sharesTool, { action: "list" }],
    ["extension_release_status", releaseStatusTool, { include: ["stores"] }],
    ["extension_builds", buildsTool, { action: "list" }],
  ] as const)("%s, a tool the hosted lane answers, is answered here and nothing is sent", async (tool, module, args) => {
    const result = JSON.parse(await (forwardable(module as unknown as ToolModule).handler as (args: Record<string, unknown>) => Promise<string>)(args));

    expect(result).toMatchObject({ ok: false, command: tool, status: "auth-required", error: { code: "E_AUTH_REQUIRED" } });
    namesProjectCreate(`${result.error.message} ${result.hint}`);
    expect(fetchCalls).toEqual([]);
  });

  it("names the project a call asked for when no login is stored for it, and sends nothing", async () => {
    const result = JSON.parse(await (forwardable(sharesTool as unknown as ToolModule).handler as (args: Record<string, unknown>) => Promise<string>)({ action: "revoke", artifactId: `gen_${"a".repeat(64)}`, project: "acme/beta" }));

    expect(result.status).toBe("auth-required");
    expect(result.error.message).toContain("No stored login for acme/beta");
    expect(result.error.message).toContain('extension_auth (action: login, project: "acme/beta")');
    expect(fetchCalls).toEqual([]);
  });


  it("extension_preview_web share:true", async () => {
    const result = JSON.parse(await previewWeb({ projectPath: dir, distPath: distDir(), share: true }));

    expect(result.ok).toBe(false);
    namesProjectCreate(JSON.stringify(result));
  });

  it("the shares listing call", async () => {
    const outcome = await listArtifacts({});

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) namesProjectCreate(outcome.error.message);
  });

  it("the preview upload", async () => {
    const outcome = await uploadPreview({ distDir: distDir(), manifest: { name: "P" }, browser: "chrome" });

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) namesProjectCreate(outcome.error.message);

    expect(fetchCalls).toEqual([]);
  });
});
