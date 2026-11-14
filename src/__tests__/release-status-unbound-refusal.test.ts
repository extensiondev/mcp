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
import * as submit from "../tools/submit-local";
import * as submitCheck from "../tools/submit-check-local";

installPlatformKernelHooks();

const API = "http://localhost:3100";
const WORKSPACE = "cezaraugusto";
const FUTURE = Math.floor(Date.now() / 1000) + 3600;
const ENV_KEYS = ["XDG_CONFIG_HOME", "EXTENSION_DEV_API_URL", "EXTENSION_DEV_TOKEN", "EXTENSION_DEV_PROJECT", "EXTENSION_DEV_APPROVAL_GATE"];
const DEFAULT_PAGE = `/${WORKSPACE}/soccer-analysis/`;
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

async function call(name: string, args: Record<string, unknown>) {
  const dispatch = createToolDispatcher({
    tools: [submit, submitCheck, releaseStatus] as unknown as ToolModule[],
    options: { features: ["local", "platform"], noShip: false },
  });
  const frame = await dispatch({ name, arguments: args });

  return JSON.parse(frame.content[0]?.text ?? "{}");
}

function linksNoProject(out: Record<string, any>): void {
  expect(out.ok).toBe(false);
  expect(out.value.trackUrl).toBeUndefined();
  expect(String(out.hint ?? "")).not.toContain("console page");
  expect(JSON.stringify(out)).not.toContain(DEFAULT_PAGE);
  expect(sent).toEqual([]);
}

beforeEach(() => {
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "extdev-release-status-unbound-"));
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

describe("a refusal made before the project was bound links no project (ledger 448)", () => {
  it("links none on an argument refusal the binding cannot settle, such as projects", async () => {
    const out = await call("extension_release_status", { include: ["stores"], projects: ["x"] });

    expect(out.status).toBe("invalid-arguments");
    expect(out.error.message).toContain("projects: unknown argument");
    linksNoProject(out);
  });

  it("links none on a folder no stored login is for, and keeps the refusal's own hint", async () => {
    const out = await call("extension_release_status", { include: ["stores"], projectPath: extensionDir("nobody", "nobody-repo") });

    expect(out.status).toBe("no-login-for-project");
    expect(out.error.message).toContain(`${WORKSPACE}/nobody`);
    expect(out.hint).toContain("extension_auth (action: login, project: 'cezaraugusto/nobody')");
    linksNoProject(out);
  });

  it("still links the bound project on a refusal the binding settled", async () => {
    const out = await call("extension_release_status", { include: ["stores"], store: "opera", projectPath: extensionDir("rebeccat", "pii-shield") });

    expect(out.status).toBe("invalid-arguments");
    expect(out.error.message).toContain("store");
    expect(out.value.trackUrl).toContain(`/${WORKSPACE}/rebeccat/`);
    expect(out.hint).toContain(out.value.trackUrl);
    expect(JSON.stringify(out)).not.toContain("soccer-analysis");
    expect(sent).toEqual([]);
  });

  it("says the folder named no project it could bind when projectPath was given and the logins are ambiguous", async () => {
    const dir = path.join(tmp, "bare");
    fs.mkdirSync(dir, { recursive: true });

    const out = await call("extension_release_status", { include: ["stores"], projectPath: dir });

    expect(out.status).toBe("project-ambiguous");
    expect(out.error.message).toContain("the folder at projectPath names no project this server could bind");
    expect(out.error.message).not.toContain("named neither project nor projectPath");
    expect(JSON.stringify(out)).not.toContain(DEFAULT_PAGE);
    expect(sent).toEqual([]);
  });

  it("extension_submit_check links none on the same unknown folder and on an argument it does not take", async () => {
    const unlogged = await call("extension_submit_check", { action: "status", projectPath: extensionDir("nobody", "nobody-repo") });

    expect(unlogged.command).toBe("extension_submit_check");
    expect(unlogged.status).toBe("no-login-for-project");
    linksNoProject(unlogged);

    const unknown = await call("extension_submit_check", { action: "status", projects: ["x"] });

    expect(unknown.status).toBe("invalid-arguments");
    linksNoProject(unknown);
  });
});
