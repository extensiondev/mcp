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

import { resolveCredential } from "../lib/credential-source";
import { credentialKey, credentialsPath, writeCredentials } from "../lib/credentials";
import { loginForPath, pathIdentity } from "../lib/path-project";
import { createToolDispatcher, type ToolModule } from "../lib/tool-dispatch";
import * as releaseStatus from "../tools/release-status";
import * as submit from "../tools/submit";

const API = "http://localhost:3100";
const WORKSPACE = "cezaraugusto";
const FUTURE = Math.floor(Date.now() / 1000) + 3600;
const ENV_KEYS = ["XDG_CONFIG_HOME", "EXTENSION_DEV_API_URL", "EXTENSION_DEV_TOKEN", "EXTENSION_DEV_PROJECT", "EXTENSION_DEV_APPROVAL_GATE"];
const saved: Record<string, string | undefined> = {};
let tmp: string;
let sent: Array<{ url: string; auth: string }>;
let prevFetch: typeof fetch;

function entry(projectSlug: string) {
  return {
    version: 1 as const,
    token: `${projectSlug}.sig`,
    workspaceSlug: WORKSPACE,
    projectSlug,
    expiresAt: FUTURE,
    api: API,
    provider: "extensiondev" as const,
  };
}

function otherProcessesSignIn(...projects: string[]): void {
  const file = credentialsPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const entries = Object.fromEntries(projects.map((slug) => [credentialKey(WORKSPACE, slug, API), entry(slug)]));
  const active = credentialKey(WORKSPACE, projects[projects.length - 1] ?? "", API);
  fs.writeFileSync(file, JSON.stringify({ version: 2, active, entries }));
}

function extensionDir(pkg: string, repo: string): string {
  const dir = path.join(tmp, repo);
  fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: pkg }));
  fs.writeFileSync(path.join(dir, ".git", "config"), `[core]\n\tbare = false\n[remote "origin"]\n\turl = https://github.com/${WORKSPACE}/${repo}.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`);

  return dir;
}

function dispatcher() {
  return createToolDispatcher({
    tools: [submit, releaseStatus] as unknown as ToolModule[],
    options: { features: ["local", "platform"], noShip: false },
  });
}

async function call(name: string, args: Record<string, unknown>) {
  const frame = await dispatcher()({ name, arguments: args });

  return JSON.parse(frame.content[0]?.text ?? "{}");
}

beforeEach(() => {
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "extdev-project-binding-"));
  process.env.XDG_CONFIG_HOME = tmp;
  process.env.EXTENSION_DEV_API_URL = API;
  process.env.EXTENSION_DEV_APPROVAL_GATE = "0";
  delete process.env.EXTENSION_DEV_TOKEN;
  delete process.env.EXTENSION_DEV_PROJECT;
  sent = [];
  prevFetch = global.fetch;
  global.fetch = (async (url: string, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    sent.push({ url: String(url), auth: String(headers.authorization ?? "") });

    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => JSON.stringify(String(url).includes("/api/cli/stores/submit") ? { ok: true, dryRun: true } : {}),
      json: async () => ({}),
    } as unknown as Response;
  }) as unknown as typeof fetch;
});

afterEach(() => {
  global.fetch = prevFetch;

  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("a project directory names its project, by package name or GitHub origin", () => {
  it("reads the package name and the origin owner and repo", () => {
    expect(pathIdentity(extensionDir("rebeccat", "pii-shield"))).toEqual({ owner: WORKSPACE, repo: "pii-shield", pkg: "rebeccat" });
  });

  it("follows a worktree's .git file to the shared config", () => {
    const main = extensionDir("leon", "leon");
    const worktree = path.join(tmp, "leon-wt");
    const gitDir = path.join(main, ".git", "worktrees", "leon-wt");
    fs.mkdirSync(gitDir, { recursive: true });
    fs.writeFileSync(path.join(gitDir, "commondir"), "../..\n");
    fs.mkdirSync(worktree, { recursive: true });
    fs.writeFileSync(path.join(worktree, ".git"), `gitdir: ${gitDir}\n`);

    expect(pathIdentity(worktree)).toEqual({ owner: WORKSPACE, repo: "leon", pkg: "" });
  });

  it("matches the stored login whose project is the package name under the origin owner", () => {
    otherProcessesSignIn("rebeccat", "leon");

    expect(loginForPath(extensionDir("rebeccat", "pii-shield"), API)).toEqual({ state: "match", project: "cezaraugusto/rebeccat", via: "package.json name" });
  });

  it("answers unmatched with both names when no stored login is the directory's project", () => {
    otherProcessesSignIn("leon");

    expect(loginForPath(extensionDir("rebeccat", "pii-shield"), API)).toEqual({
      state: "unmatched",
      named: ["cezaraugusto/rebeccat", "cezaraugusto/pii-shield"],
    });
  });
});

describe("ledger 252: with several logins stored, an unpinned platform call never answers for the newest", () => {
  it("refuses a call that names neither project nor projectPath, and sends nothing", async () => {
    otherProcessesSignIn("rebeccat", "leon");

    const out = await call("extension_release_status", { include: ["stores"], api: API });

    expect(out.ok).toBe(false);
    expect(out.status).toBe("project-ambiguous");
    expect(out.error.code).toBe("E_PROJECT_AMBIGUOUS");
    expect(out.value.logins).toEqual(["cezaraugusto/rebeccat", "cezaraugusto/leon"]);
    expect(out.hint).toContain("'cezaraugusto/rebeccat'");
    expect(sent).toEqual([]);
  });

  it("an earlier unnamed read does not make the newest login this server's default", async () => {
    otherProcessesSignIn("rebeccat", "leon");

    expect(resolveCredential({ api: API }).ref).toEqual({ workspace: WORKSPACE, project: "leon" });

    const out = await call("extension_release_status", { include: ["stores"], api: API });

    expect(out.status).toBe("project-ambiguous");
    expect(sent).toEqual([]);
  });

  it("answers a preflight given the rebeccat directory for rebeccat, with rebeccat's token, though leon signed in last", async () => {
    otherProcessesSignIn("rebeccat", "leon");

    const out = await call("extension_submit", { browsers: ["chrome"], buildSha: "e4b8976", projectPath: extensionDir("rebeccat", "pii-shield"), api: API });

    expect(Object.keys(out.value)[0]).toBe("answeredFor");
    expect(out.value.answeredFor).toBe("cezaraugusto/rebeccat");
    expect(out.value.note).toContain("Answered for cezaraugusto/rebeccat, the project at projectPath (its package.json name)");
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.filter((row) => row.auth).map((row) => row.auth)).toEqual(sent.filter((row) => row.auth).map(() => "Bearer rebeccat.sig"));
    expect(sent.some((row) => row.url.includes("/leon/"))).toBe(false);
  });

  it("refuses a directory whose project has no stored login, naming the default it did not use", async () => {
    writeCredentials(entry("leon"));

    const out = await call("extension_submit", { browsers: ["chrome"], buildSha: "e4b8976", projectPath: extensionDir("rebeccat", "pii-shield"), api: API });

    expect(out.status).toBe("no-login-for-project");
    expect(out.error.code).toBe("E_NO_LOGIN_FOR_PROJECT");
    expect(out.error.message).toContain("cezaraugusto/rebeccat or cezaraugusto/pii-shield");
    expect(out.error.message).toContain("The default login here is cezaraugusto/leon, and it was not used in its place.");
    expect(out.hint).toContain("extension_auth (action: login, project: 'cezaraugusto/rebeccat')");
    expect(out.hint).not.toContain("'cezaraugusto/leon'");
    expect(out.value.logins).toBeUndefined();
    expect(sent).toEqual([]);
  });

  it("a named project outranks the directory and is the one answered for", async () => {
    otherProcessesSignIn("rebeccat", "leon");

    const out = await call("extension_submit", { browsers: ["chrome"], buildSha: "e4b8976", project: "leon", projectPath: extensionDir("rebeccat", "pii-shield"), api: API });

    expect(out.value.answeredFor).toBe("cezaraugusto/leon");
    expect(sent.filter((row) => row.auth).every((row) => row.auth === "Bearer leon.sig")).toBe(true);
  });

  it("the one stored login still answers an unnamed call, and says which project it was", async () => {
    otherProcessesSignIn("leon");

    const out = await call("extension_submit", { browsers: ["chrome"], buildSha: "e4b8976", api: API });

    expect(out.status).not.toBe("project-ambiguous");
    expect(out.value.answeredFor).toBe("cezaraugusto/leon");
  });

  it("a login made through this server stays its default beside a newer login made elsewhere", async () => {
    writeCredentials(entry("rebeccat"));
    const file = credentialsPath();
    const store = JSON.parse(fs.readFileSync(file, "utf8"));
    store.entries[credentialKey(WORKSPACE, "leon", API)] = entry("leon");
    store.active = credentialKey(WORKSPACE, "leon", API);
    fs.writeFileSync(file, JSON.stringify(store));

    const out = await call("extension_submit", { browsers: ["chrome"], buildSha: "e4b8976", api: API });

    expect(out.value.answeredFor).toBe("cezaraugusto/rebeccat");
    expect(sent.filter((row) => row.auth).every((row) => row.auth === "Bearer rebeccat.sig")).toBe(true);
  });
});
