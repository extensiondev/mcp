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

import { rememberCreatedProject } from "../lib/created-projects";
import { credentialKey, credentialsPath } from "../lib/credentials";
import { saveHeldBatch } from "../lib/held-batches";
import { forgetPendingCreate, pendingCreate, pendingCreatesPath, rememberPendingCreate } from "../lib/pending-creates";
import { createToolDispatcher, type ToolModule } from "../lib/tool-dispatch";
import * as shares from "../tools/shares";
import * as submit from "../tools/submit";

const API = "http://localhost:3100";
const WORKSPACE = "cezaraugusto";
const FUTURE = Math.floor(Date.now() / 1000) + 3600;
const ENV_KEYS = ["XDG_CONFIG_HOME", "EXTENSION_DEV_API_URL", "EXTENSION_DEV_TOKEN", "EXTENSION_DEV_PROJECT", "EXTENSION_DEV_APPROVAL_GATE"];
const saved: Record<string, string | undefined> = {};
let tmp: string;
let sent: string[];
let prevFetch: typeof fetch;

function entry(projectSlug: string) {
  return { version: 1 as const, token: `${projectSlug}.sig`, workspaceSlug: WORKSPACE, projectSlug, expiresAt: FUTURE, api: API, provider: "extensiondev" as const };
}

function signedIn(...projects: string[]): void {
  const file = credentialsPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const entries = Object.fromEntries(projects.map((slug) => [credentialKey(WORKSPACE, slug, API), entry(slug)]));
  const active = credentialKey(WORKSPACE, projects[projects.length - 1] ?? "", API);
  fs.writeFileSync(file, JSON.stringify({ version: 2, active, entries }));
}

function extensionDir(pkg: string, repo: string, storeMd?: string): string {
  const dir = path.join(tmp, repo);
  fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: pkg }));
  fs.writeFileSync(path.join(dir, ".git", "config"), `[core]\n\tbare = false\n[remote "origin"]\n\turl = https://github.com/${WORKSPACE}/${repo}.git\n`);
  if (storeMd !== undefined) fs.writeFileSync(path.join(dir, "STORE.md"), storeMd);

  return dir;
}

async function call(name: string, args: Record<string, unknown>) {
  const dispatch = createToolDispatcher({ tools: [submit, shares] as unknown as ToolModule[], options: { features: ["local", "platform"], noShip: false } });
  const frame = await dispatch({ name, arguments: args });

  return JSON.parse(frame.content[0]?.text ?? "{}");
}

const preflightArgs = (projectPath: string) => ({ action: "preflight", browsers: ["chrome"], projectPath, api: API });

beforeEach(() => {
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "extdev-no-login-"));
  process.env.XDG_CONFIG_HOME = tmp;
  process.env.EXTENSION_DEV_API_URL = API;
  process.env.EXTENSION_DEV_APPROVAL_GATE = "0";
  delete process.env.EXTENSION_DEV_TOKEN;
  delete process.env.EXTENSION_DEV_PROJECT;
  sent = [];
  prevFetch = global.fetch;
  global.fetch = (async (url: string) => {
    sent.push(String(url));

    return { ok: true, status: 200, headers: { get: () => null }, text: async () => "{}", json: async () => ({}) } as unknown as Response;
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

describe("ledger 287: a directory whose project has no login is not ambiguous", () => {
  it("answers no-login-for-project and names the create, then the login, never another project's login", async () => {
    signedIn("rebeccat", "leon");

    const out = await call("extension_submit", preflightArgs(extensionDir("hands-free", "hands-free")));

    expect(out.ok).toBe(false);
    expect(out.status).toBe("no-login-for-project");
    expect(out.error.code).toBe("E_NO_LOGIN_FOR_PROJECT");
    expect(out.error.message).toContain("is the project cezaraugusto/hands-free, and no login stored on this machine is for it");
    expect(out.hint).toContain("extension_project_create (project: 'cezaraugusto/hands-free', repo: 'cezaraugusto/hands-free')");
    expect(out.hint).toContain("extension_auth (action: login, project: 'cezaraugusto/hands-free')");
    expect(out.hint).not.toContain("rebeccat");
    expect(out.hint).not.toContain("'cezaraugusto/leon'");
    expect(out.value.logins).toBeUndefined();
    expect(sent).toEqual([]);
  });

  it("names a create waiting for approval on this machine, with its code and deadline", async () => {
    signedIn("leon");
    const expiresAt = new Date(Date.now() + 600_000).toISOString();
    rememberPendingCreate(API, "cezaraugusto/hands-free", { userCode: "WXYZ-9876", verificationUri: "https://extension.dev/device", verificationUriComplete: "https://extension.dev/device?code=WXYZ-9876", expiresAt });

    const out = await call("extension_submit", preflightArgs(extensionDir("hands-free", "hands-free")));

    expect(out.status).toBe("no-login-for-project");
    expect(out.hint).toContain("A create of cezaraugusto/hands-free is waiting for approval on this machine");
    expect(out.hint).toContain("https://extension.dev/device?code=WXYZ-9876");
    expect(out.hint).toContain(`code WXYZ-9876; it expires at ${expiresAt.slice(11, 16)} UTC`);
    expect(out.hint).toContain("call extension_project_create again with the deviceCode its first call answered");
    expect(out.hint).toContain("extension_auth (action: login, project: 'cezaraugusto/hands-free')");
    expect(out.value.pendingCreate).toEqual({ project: "cezaraugusto/hands-free", userCode: "WXYZ-9876", verificationUri: "https://extension.dev/device?code=WXYZ-9876", expiresAt });
    expect(sent).toEqual([]);
  });

  it("names a held provisioning grant and its deadline when the create is in progress", async () => {
    signedIn("leon");
    saveHeldBatch(API, "dev-code-1", { workspace: WORKSPACE, refs: ["cezaraugusto/hands-free"], grant: "grant.sig", grantExpiresAt: FUTURE, rows: [] });

    const out = await call("extension_submit", preflightArgs(extensionDir("hands-free", "hands-free")));

    expect(out.status).toBe("no-login-for-project");
    expect(out.hint).toContain(`holds a provisioning grant on this machine until ${new Date(FUTURE * 1000).toISOString()}`);
    expect(out.hint).toContain("call it again with the same deviceCode and arguments");
    expect(out.value.createGrantHeldUntil).toBe(new Date(FUTURE * 1000).toISOString());
  });

  it("skips a held grant another server holds for the same ref", async () => {
    signedIn("leon");
    saveHeldBatch("https://www.extension.dev", "dev-code-2", { workspace: WORKSPACE, refs: ["cezaraugusto/hands-free"], grant: "grant.sig", grantExpiresAt: FUTURE, rows: [] });

    const out = await call("extension_submit", preflightArgs(extensionDir("hands-free", "hands-free")));

    expect(out.value.createGrantHeldUntil).toBeUndefined();
    expect(out.hint).toContain("extension_project_create (project: 'cezaraugusto/hands-free'");
  });

  it("sends straight to the login when this machine created the project", async () => {
    signedIn("leon");
    rememberCreatedProject(API, "cezaraugusto/hands-free");

    const out = await call("extension_submit", preflightArgs(extensionDir("hands-free", "hands-free")));

    expect(out.status).toBe("no-login-for-project");
    expect(out.hint).toContain("cezaraugusto/hands-free exists on this server (this machine created it)");
    expect(out.hint).not.toContain("extension_project_create");
    expect(out.value.createdHere).toBe(true);
  });

  it("answers the same with no login stored at all, instead of a generic sign-in", async () => {
    const out = await call("extension_submit", preflightArgs(extensionDir("hands-free", "hands-free")));

    expect(out.status).toBe("no-login-for-project");
    expect(out.error.code).toBe("E_NO_LOGIN_FOR_PROJECT");
    expect(out.value.defaultLogin).toBeUndefined();
    expect(out.error.message).not.toContain("default login");
    expect(sent).toEqual([]);
  });

  it("answers the local half of a preflight without a login and marks the store half unknown", async () => {
    signedIn("leon");
    const dir = extensionDir("hands-free", "hands-free", "# Hands-free\n\n## Listing\n\n- Name: Hands-free\n- Summary: Browse by voice.\n- Category: productivity\n");

    const out = await call("extension_submit", preflightArgs(dir));

    expect(out.status).toBe("no-login-for-project");
    expect(out.value.local.chrome.storeMd.file).toBe(path.join(dir, "STORE.md"));
    expect(out.value.local.chrome.storeMd.found).toEqual(expect.arrayContaining(["title", "shortDescription"]));
    expect(out.value.local.chrome.storeMd.notFound).toEqual(expect.arrayContaining([{ line: "- Description:", section: expect.any(String) }]));
    expect(out.value.local.chrome.icon.missing).toEqual(expect.any(String));
    expect(out.value.stores.chrome.readiness).toBe("unknown");
    expect(out.hint).toContain("The local half of the preflight is in value.local");
    expect(sent).toEqual([]);
  });

  it("says when the directory has no STORE.md, and carries no local half for a submit", async () => {
    signedIn("leon");
    const dir = extensionDir("hands-free", "hands-free");

    const read = await call("extension_submit", preflightArgs(dir));
    const sendIt = await call("extension_submit", { browsers: ["chrome"], buildSha: "e4b8976", projectPath: dir, api: API });

    expect(read.value.local.chrome.storeMd.missing).toContain("No STORE.md");
    expect(sendIt.status).toBe("no-login-for-project");
    expect(sendIt.value.local).toBeUndefined();
    expect(sendIt.hint).not.toContain("value.local");
  });

  it("gives extension_shares the same answer through the shared binding", async () => {
    signedIn("rebeccat", "leon");

    const out = await call("extension_shares", { action: "list", projectPath: extensionDir("hands-free", "hands-free"), api: API });

    expect(out.status).toBe("no-login-for-project");
    expect(out.error.code).toBe("E_NO_LOGIN_FOR_PROJECT");
    expect(out.hint).not.toContain("'cezaraugusto/leon'");
    expect(sent).toEqual([]);
  });

  it("keeps the genuine ambiguity answer for a call that names no directory", async () => {
    signedIn("rebeccat", "leon");

    const out = await call("extension_submit", { action: "preflight", browsers: ["chrome"], api: API });

    expect(out.status).toBe("project-ambiguous");
    expect(out.error.code).toBe("E_PROJECT_AMBIGUOUS");
    expect(out.value.logins).toEqual(["cezaraugusto/rebeccat", "cezaraugusto/leon"]);
  });
});

describe("the pending create record", () => {
  it("is kept per server, read back, forgotten, and dropped once its code expired", () => {
    const record = { userCode: "AAAA-1111", verificationUri: "https://extension.dev/device", expiresAt: new Date(Date.now() + 60_000).toISOString() };

    expect(rememberPendingCreate(API, "Cezaraugusto/Hands-Free", record)).toBe(true);
    expect(pendingCreate(API, "cezaraugusto/hands-free")).toEqual(record);
    expect(pendingCreate("https://www.extension.dev", "cezaraugusto/hands-free")).toBeNull();
    expect((fs.statSync(pendingCreatesPath()).mode & 0o077) === 0 || process.platform === "win32").toBe(true);

    forgetPendingCreate(API, "cezaraugusto/hands-free");

    expect(pendingCreate(API, "cezaraugusto/hands-free")).toBeNull();
    expect(fs.existsSync(pendingCreatesPath())).toBe(false);

    rememberPendingCreate(API, "cezaraugusto/hands-free", { ...record, expiresAt: new Date(Date.now() - 1000).toISOString() });

    expect(pendingCreate(API, "cezaraugusto/hands-free")).toBeNull();
  });
});
