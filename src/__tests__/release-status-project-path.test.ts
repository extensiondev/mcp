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

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { clientDirs, setClientRoots } from "../lib/client-roots";
import { credentialKey, credentialsPath } from "../lib/credentials";
import { installPlatformKernelHooks } from "../lib/platform-kernel-hooks";
import { createToolDispatcher, type ToolModule } from "../lib/tool-dispatch";
import * as releaseStatus from "../tools/release-status";
import * as submit from "../tools/submit";

installPlatformKernelHooks();

const API = "http://localhost:3100";
const WORKSPACE = "cezaraugusto";
const FUTURE = Math.floor(Date.now() / 1000) + 3600;
const ENV_KEYS = ["XDG_CONFIG_HOME", "EXTENSION_DEV_API_URL", "EXTENSION_DEV_TOKEN", "EXTENSION_DEV_PROJECT", "EXTENSION_DEV_APPROVAL_GATE"];
const saved: Record<string, string | undefined> = {};
let tmp: string;
let sent: Array<{ url: string; auth: string }>;
let prevFetch: typeof fetch;

function signIn(...projects: string[]): void {
  const file = credentialsPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const entries = Object.fromEntries(
    projects.map((slug) => [
      credentialKey(WORKSPACE, slug, API),
      { version: 1, token: `${slug}.sig`, workspaceSlug: WORKSPACE, projectSlug: slug, expiresAt: FUTURE, api: API, provider: "extensiondev" },
    ]),
  );
  fs.writeFileSync(file, JSON.stringify({ version: 2, active: credentialKey(WORKSPACE, projects[projects.length - 1] ?? "", API), entries }));
}

function extensionDir(pkg: string, repo: string): string {
  const dir = path.join(tmp, repo);
  fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: pkg }));
  fs.writeFileSync(path.join(dir, ".git", "config"), `[remote "origin"]\n\turl = https://github.com/${WORKSPACE}/${repo}.git\n`);

  return dir;
}

async function call(args: Record<string, unknown>) {
  const dispatch = createToolDispatcher({
    tools: [submit, releaseStatus] as unknown as ToolModule[],
    options: { features: ["local", "platform"], noShip: false },
  });
  const frame = await dispatch({ name: "extension_release_status", arguments: args });

  return JSON.parse(frame.content[0]?.text ?? "{}");
}

beforeEach(() => {
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "extdev-release-status-path-"));
  process.env.XDG_CONFIG_HOME = tmp;
  process.env.EXTENSION_DEV_API_URL = API;
  process.env.EXTENSION_DEV_APPROVAL_GATE = "0";
  delete process.env.EXTENSION_DEV_TOKEN;
  delete process.env.EXTENSION_DEV_PROJECT;
  sent = [];
  setClientRoots(null);
  clientDirs.cwd = () => tmp;
  prevFetch = global.fetch;
  global.fetch = (async (url: string, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    sent.push({ url: String(url), auth: String(headers.authorization ?? "") });

    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => "{}",
      json: async () => ({}),
    } as unknown as Response;
  }) as unknown as typeof fetch;

  signIn("rebeccat", "soccer-analysis");
});

afterEach(() => {
  global.fetch = prevFetch;
  setClientRoots(null);
  clientDirs.cwd = () => process.cwd();

  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("extension_release_status takes projectPath and a refusal names no project it never resolved (ledger 443)", () => {
  it("reads the project the directory names, not the stored login's default", async () => {
    const out = await call({ include: ["stores"], projectPath: extensionDir("rebeccat", "pii-shield") });

    expect(out.status).not.toBe("invalid-arguments");
    expect(out.value.answeredFor).toBe("cezaraugusto/rebeccat");
    expect(sent.some((row) => row.auth)).toBe(true);
    expect(sent.filter((row) => row.auth).every((row) => row.auth === "Bearer rebeccat.sig")).toBe(true);
    expect(JSON.stringify(out)).not.toContain("soccer-analysis");
  });

  it("answers an argument refusal with no trackUrl and no hint for the default login's project", async () => {
    const out = await call({ include: ["stores"], folder: extensionDir("rebeccat", "pii-shield") });

    expect(out.status).toBe("invalid-arguments");
    expect(out.error.message).toContain("folder: unknown argument");
    expect(out.value.trackUrl).toBeUndefined();
    expect(JSON.stringify(out)).not.toContain("soccer-analysis");
    expect(sent).toEqual([]);
  });
});
