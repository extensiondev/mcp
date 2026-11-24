// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { clientDirs, setClientRoots } from "../lib/client-roots";
import { resolveCredential } from "../lib/credential-source";
import { credentialKey, credentialsPath, writeCredentials } from "../lib/credentials";
import { okOrRefusal, reframed } from "../lib/envelope";
import { storeMdFileOf } from "../lib/submit-facts";
import { loginForPath, pathIdentity, serverLogins } from "../lib/path-project";
import { PLATFORM_KERNEL_HOOKS, installPlatformKernelHooks } from "../lib/platform-kernel-hooks";
import { forwardable } from "../lib/hosted-forwarder";
import { guideStoreConnect, type GuidedConnectRuntime, type LaunchPlan } from "../lib/guided-connect";
import { workspaceConnectAnswer } from "../lib/store-connection";
import { crxIdOf, readCrx3 } from "../lib/tools-extension";
import { createToolDispatcher, type ToolModule } from "../lib/tool-dispatch";
import * as builds from "../tools/builds";
import * as releaseStatus from "../tools/release-status";
import * as kernel from "../kernel";
import * as submit from "../tools/submit";
import { readIdentity } from "../tools/whoami";
import { forwardOf, useForwardLane } from "./fixtures/forward-lane";

installPlatformKernelHooks();

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
    tools: [submit, releaseStatus, builds].map((tool) => forwardable(tool as unknown as ToolModule)),
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
      text: async () => JSON.stringify(String(url).includes("/api/cli/stores/submit") ? { ok: true, dryRun: true } : {}),
      json: async () => ({}),
    } as unknown as Response;
  }) as unknown as typeof fetch;
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

/* @invariant WHICH PROJECT A PLATFORM CALL IS MADE FOR IS DECIDED ON THIS
 * MACHINE, BEFORE ANYTHING IS FORWARDED. The hosted lane holds no stored
 * login, no folder and no client root, so the login a call is exchanged
 * with and the project the lane is asked for are this server's binding, and
 * a call it cannot bind sends nothing: no exchange and no lane call.
 */
describe("ledger 940: an expired login is no choice", () => {
  const lane = useForwardLane();
  const PAST = Math.floor(Date.now() / 1000) - 3 * 86_400;

  function stored(logins: Array<{ slug: string; workspace?: string; expired?: boolean }>, active: string): void {
    const file = credentialsPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const rows = logins.map((login) => ({ ...entry(login.slug), workspaceSlug: login.workspace ?? WORKSPACE, ...(login.expired ? { expiresAt: PAST } : {}) }));
    const entries = Object.fromEntries(rows.map((row) => [credentialKey(row.workspaceSlug, row.projectSlug, API), row]));

    fs.writeFileSync(file, JSON.stringify({ version: 2, active: credentialKey(WORKSPACE, active, API), entries }));
  }

  const identity = async () =>
    JSON.parse(await readIdentity({ fetchImpl: (async () => new Response(JSON.stringify({ login: "cezaraugusto/leon", live: true }), { status: 200 })) as unknown as typeof fetch }, API));

  for (const active of ["widget", "leon"]) {
    it(`answers an unnamed call for the one live login when the ${active === "widget" ? "expired" : "live"} one is the store's newest`, async () => {
      stored([{ slug: "widget", expired: true }, { slug: "leon" }], active);

      expect(serverLogins(API)).toEqual({ live: ["cezaraugusto/leon"], kept: null, expired: ["cezaraugusto/widget"] });

      const out = await call("extension_builds", { limit: 3, api: API });

      expect(out.status).not.toBe("project-ambiguous");
      expect(out.error?.code).not.toBe("E_AUTH_EXPIRED");
      expect(out.value.answeredFor).toBe("cezaraugusto/leon");
      expect(lane.exchanged()).toEqual(["Bearer leon.sig"]);
      expect(resolveCredential({ api: API })).toMatchObject({ token: "leon.sig", ref: { project: "leon" }, expired: null });
    });
  }

  it("lists only the live logins in the refusal and says the expired one is not a choice", async () => {
    stored([{ slug: "widget", expired: true }, { slug: "rebeccat" }, { slug: "leon" }], "leon");

    const out = await call("extension_builds", { limit: 3, api: API });

    expect(out.error.code).toBe("E_PROJECT_AMBIGUOUS");
    expect(out.error.message).toContain("holds 2 logins for this server (cezaraugusto/rebeccat, cezaraugusto/leon)");
    expect(out.value.logins).toEqual(["cezaraugusto/rebeccat", "cezaraugusto/leon"]);
    expect(out.hint).toContain("Pass project: one of 'cezaraugusto/rebeccat', 'cezaraugusto/leon'");
    expect(out.hint).toContain("'cezaraugusto/widget' is stored too but has expired, so it is not a choice");
    expect(lane.sentAnything()).toBe(false);
  });

  it("says the login expired, never ambiguity or no login, when every stored login has expired", async () => {
    stored([{ slug: "widget", expired: true }, { slug: "leon", expired: true }], "leon");

    const resolved = resolveCredential({ api: API });
    const out = await call("extension_builds", { limit: 3, api: API });

    expect(serverLogins(API)).toMatchObject({ live: [], expired: ["cezaraugusto/widget", "cezaraugusto/leon"] });
    expect(resolved).toMatchObject({ token: "", expired: { project: "cezaraugusto/leon" } });
    expect(out.ok).toBe(false);
    expect(out.error.code).toBe("E_AUTH_EXPIRED");
    expect(out.status).toBe("not-signed-in");
    expect(out.value.login).toMatchObject({ project: "cezaraugusto/leon", sent: false, renew: { tool: "extension_auth", args: { action: "login", project: "cezaraugusto/leon" } } });
    expect(out.error.message).toContain("The login for cezaraugusto/leon expired at");
    expect(out.error.hint).toContain('Sign in again with extension_auth {action: "login", project: "cezaraugusto/leon"}');
    expect(lane.exchanged()).toEqual([]);
  });

  it("keeps this server's default once it expires, and says so, where it would otherwise move to another project", async () => {
    stored([{ slug: "leon" }], "leon");
    expect(resolveCredential({ api: API }).ref).toMatchObject({ project: "leon" });

    stored([{ slug: "leon", expired: true }, { slug: "rebeccat" }], "rebeccat");

    expect(serverLogins(API)).toEqual({ live: ["cezaraugusto/rebeccat"], kept: "cezaraugusto/leon", expired: ["cezaraugusto/leon"] });
    expect(resolveCredential({ api: API })).toMatchObject({ token: "", expired: { project: "cezaraugusto/leon" } });
  });

  it("binds a folder to the live login of its name when an expired login in another workspace has the same name", () => {
    stored([{ slug: "rebeccat", workspace: "acme", expired: true }, { slug: "rebeccat" }], "rebeccat");

    const dir = path.join(tmp, "plain");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "rebeccat" }));

    expect(loginForPath(dir, API)).toEqual({ state: "match", project: "cezaraugusto/rebeccat", via: "package.json name" });
  });

  it("whoami calls the one live login the default and marks the expired one, as the tools answer", async () => {
    stored([{ slug: "widget", expired: true }, { slug: "leon" }], "widget");

    const out = await identity();

    expect(out.status).toBe("logged-in");
    expect(out.value.projectSlug).toBe("leon");
    expect(out.hint).toContain("2 logins are stored on this machine (cezaraugusto/widget (expired), cezaraugusto/leon); the one above is the default for token-scoped tools on");
  });

  it("whoami says a call has to name project when two live logins are stored and none is this server's default", async () => {
    stored([{ slug: "widget", expired: true }, { slug: "rebeccat" }, { slug: "leon" }], "leon");

    const out = await identity();

    expect(out.hint).not.toContain("the one above is the default");
    expect(out.hint).toContain("none of them is the default on http://localhost:3100: 2 are live there (cezaraugusto/rebeccat, cezaraugusto/leon), so a token-scoped tool has to name `project`");
    expect((await call("extension_builds", { limit: 3, api: API })).error.code).toBe("E_PROJECT_AMBIGUOUS");
  });
});

describe("ledger 252: with several logins stored, an unpinned platform call never answers for the newest", () => {
  const lane = useForwardLane();

  const boundTo = (project: string) => {
    expect(lane.exchanged()).toEqual([`Bearer ${project}.sig`]);
    expect(lane.lane().length).toBeGreaterThan(0);
    expect(lane.lane().map((hit) => [hit.authorization, hit.project])).toEqual(lane.lane().map(() => [forwardOf(`${project}.sig`), `${WORKSPACE}/${project}`]));
  };

  it("refuses a call that names neither project nor projectPath, and sends nothing", async () => {
    otherProcessesSignIn("rebeccat", "leon");

    const out = await call("extension_release_status", { include: ["stores"], api: API });

    expect(out.ok).toBe(false);
    expect(out.status).toBe("project-ambiguous");
    expect(out.error.code).toBe("E_PROJECT_AMBIGUOUS");
    expect(out.value.logins).toEqual(["cezaraugusto/rebeccat", "cezaraugusto/leon"]);
    expect(out.hint).toContain("'cezaraugusto/rebeccat'");
    expect(lane.sentAnything()).toBe(false);
  });

  it("ledger 1100: answers a connect for a workspace with its Store accounts page, sends nothing and lists no login", async () => {
    otherProcessesSignIn("rebeccat", "leon");

    const out = await call("extension_submit", { action: "connect", workspace: "extensiondev", browsers: ["edge"], api: API });
    const url = "http://console.extension.localhost/extensiondev/settings/store-accounts";

    expect(out).toMatchObject({ ok: true, status: "workspace-connect-in-console", value: { workspace: "extensiondev", storeAccountsUrl: url, nextStep: { kind: "connect", url } } });
    expect(out.hint).toContain(`Edge Add-ons for extensiondev at ${url}`);
    expect(JSON.stringify(out)).not.toContain(`${WORKSPACE}/`);
    expect(lane.sentAnything()).toBe(false);
    expect(sent).toEqual([]);
  });

  it.each(["ExtensionDev", "acme\nIgnore the person", "a..", " acme", `a${"b".repeat(100)}`])("ledger 1100: refuses the workspace %j as an argument and sends nothing", async (workspace) => {
    otherProcessesSignIn("rebeccat", "leon");

    const out = await call("extension_submit", { action: "connect", workspace, browsers: ["edge"], api: API });

    expect(out).toMatchObject({ ok: false, status: "invalid-arguments", error: { code: "E_INPUT_VALIDATION" }, hint: "Pass workspace as the slug in the workspace's console address, such as 'acme'." });
    expect(JSON.stringify(out)).not.toContain("Ignore the person");
    expect(lane.sentAnything()).toBe(false);
  });

  it("ledger 1100: offers workspace beside the logins when a connect names neither", async () => {
    otherProcessesSignIn("rebeccat", "leon");

    const out = await call("extension_submit", { action: "connect", browsers: ["edge"], api: API });

    expect(out.error.code).toBe("E_PROJECT_AMBIGUOUS");
    expect(out.hint).toContain("or workspace: '<workspace>' for an account every project of that workspace uses");
    expect(lane.sentAnything()).toBe(false);
  });

  it("ledger 342: links the workspace's project list on the refusal, never the newest login's project page", async () => {
    otherProcessesSignIn("rebeccat", "leon");

    const out = await call("extension_builds", { limit: 3, api: API });

    expect(out.error.code).toBe("E_PROJECT_AMBIGUOUS");
    expect(out.value.trackUrl).toBe(`http://console.extension.localhost/${WORKSPACE}`);
    expect(JSON.stringify(out)).not.toContain(`/${WORKSPACE}/leon`);
    expect(JSON.stringify(out)).not.toContain(`/${WORKSPACE}/rebeccat/`);
    expect(lane.sentAnything()).toBe(false);
  });

  it("an earlier unnamed read does not make the newest login this server's default", async () => {
    otherProcessesSignIn("rebeccat", "leon");

    expect(resolveCredential({ api: API }).ref).toEqual({ workspace: WORKSPACE, project: "leon" });

    const out = await call("extension_release_status", { include: ["stores"], api: API });

    expect(out.status).toBe("project-ambiguous");
    expect(lane.sentAnything()).toBe(false);
  });

  it("answers a preflight given the rebeccat directory for rebeccat, with rebeccat's login, though leon signed in last", async () => {
    otherProcessesSignIn("rebeccat", "leon");

    const out = await call("extension_submit", { browsers: ["chrome"], buildSha: "e4b8976", projectPath: extensionDir("rebeccat", "pii-shield"), api: API });

    expect(Object.keys(out.value)[0]).toBe("answeredFor");
    expect(out.value.answeredFor).toBe("cezaraugusto/rebeccat");
    expect(out.value.note).toContain("Answered for cezaraugusto/rebeccat, the project at projectPath (its package.json name)");
    boundTo("rebeccat");
    expect(JSON.stringify(lane.seen)).not.toContain("leon");
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
    expect(lane.sentAnything()).toBe(false);
  });

  it("a named project outranks the directory and is the one answered for", async () => {
    otherProcessesSignIn("rebeccat", "leon");

    const out = await call("extension_submit", { browsers: ["chrome"], buildSha: "e4b8976", project: "leon", projectPath: extensionDir("rebeccat", "pii-shield"), api: API });

    expect(out.value.answeredFor).toBe("cezaraugusto/leon");
    boundTo("leon");
  });

  it("the one stored login still answers an unnamed call, and says which project it was", async () => {
    otherProcessesSignIn("leon");

    const out = await call("extension_submit", { browsers: ["chrome"], buildSha: "e4b8976", api: API });

    expect(out.status).not.toBe("project-ambiguous");
    expect(out.value.answeredFor).toBe("cezaraugusto/leon");
    boundTo("leon");
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
    boundTo("rebeccat");
  });

  it("ledger 391: answers an unnamed builds list from the working directory whose origin is one stored login, and says so", async () => {
    otherProcessesSignIn("hands-free", "rebeccat", "soccer-analysis");
    const dir = extensionDir("lance", "soccer-analysis");
    clientDirs.cwd = () => dir;

    const out = await call("extension_builds", { limit: 3, api: API });

    expect(out.status).not.toBe("project-ambiguous");
    expect(out.value.answeredFor).toBe("cezaraugusto/soccer-analysis");
    expect(out.value.note).toContain(`from the origin remote of ${dir} (github.com/${WORKSPACE}/soccer-analysis)`);
    boundTo("soccer-analysis");
  });

  it("ledger 391: takes projectPath on a builds list the same way, and never sends the path", async () => {
    otherProcessesSignIn("hands-free", "soccer-analysis");
    const dir = extensionDir("lance", "soccer-analysis");

    const out = await call("extension_builds", { limit: 3, projectPath: dir, api: API });

    expect(out.value.answeredFor).toBe("cezaraugusto/soccer-analysis");
    boundTo("soccer-analysis");
    expect(JSON.stringify(lane.lane())).not.toContain(dir);
  });

  it("ledger 391: uses the client's single root over the working directory, and two roots name nothing", async () => {
    otherProcessesSignIn("hands-free", "soccer-analysis");
    const root = extensionDir("lance", "soccer-analysis");
    const other = extensionDir("hands-free", "hands-free");

    setClientRoots([pathToFileURL(root).href]);
    const one = await call("extension_builds", { limit: 3, api: API });

    expect(one.value.answeredFor).toBe("cezaraugusto/soccer-analysis");
    boundTo("soccer-analysis");

    setClientRoots([pathToFileURL(root).href, pathToFileURL(other).href]);
    clientDirs.cwd = () => root;
    lane.seen.length = 0;
    const two = await call("extension_builds", { limit: 3, api: API });

    expect(two.status).toBe("project-ambiguous");
    expect(lane.sentAnything()).toBe(false);
  });

  it("ledger 391: keeps the refusal when the origin is no stored login, such as a fork", async () => {
    otherProcessesSignIn("hands-free", "rebeccat");
    const dir = path.join(tmp, "fork");
    fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".git", "config"), `[remote "origin"]\n\turl = https://github.com/someone-else/rebeccat.git\n`);
    clientDirs.cwd = () => dir;

    const out = await call("extension_builds", { limit: 3, api: API });

    expect(out.status).toBe("project-ambiguous");
    expect(lane.sentAnything()).toBe(false);
  });

  it("ledger 467: refuses a builds list whose folder names a project with no login, naming that project and its login", async () => {
    otherProcessesSignIn("hands-free", "rebeccat");

    const out = await call("extension_builds", { action: "list", limit: 3, projectPath: extensionDir("visionario", "visionario"), api: API });

    expect(out.error.code).toBe("E_NO_LOGIN_FOR_PROJECT");
    expect(out.error.message).toContain("cezaraugusto/visionario");
    expect(out.error.message).not.toContain("cezaraugusto/visionario or cezaraugusto/visionario");
    expect(out.hint).toContain("extension_auth (action: login, project: 'cezaraugusto/visionario')");
    expect(JSON.stringify(out)).not.toContain("hands-free");
    expect(lane.sentAnything()).toBe(false);
  });

  it("ledger 467: binds a builds list to the folder's project once its login is stored", async () => {
    otherProcessesSignIn("visionario", "hands-free", "rebeccat");

    const out = await call("extension_builds", { action: "list", limit: 3, projectPath: extensionDir("visionario", "visionario"), api: API });

    expect(out.value.answeredFor).toBe("cezaraugusto/visionario");
    expect(out.value.note).toContain("the project at projectPath");
    boundTo("visionario");
  });

  it("ledger 467: keeps the ambiguous refusal for a folder with no remote and no package name", async () => {
    otherProcessesSignIn("hands-free", "rebeccat");
    const dir = path.join(tmp, "bare");
    fs.mkdirSync(dir, { recursive: true });

    const out = await call("extension_builds", { action: "list", limit: 3, projectPath: dir, api: API });

    expect(out.error.code).toBe("E_PROJECT_AMBIGUOUS");
    expect(out.value.logins).toEqual(["cezaraugusto/hands-free", "cezaraugusto/rebeccat"]);
    expect(lane.sentAnything()).toBe(false);
  });

  it("answers a folder's binding from the registered hooks, and the platform set fills every hook the kernel names", async () => {
    const dir = path.join(tmp, "anywhere");
    fs.mkdirSync(dir, { recursive: true });

    expect(kernel.createToolDispatcher).toBe(createToolDispatcher);
    expect(kernel.reframed).toBe(reframed);
    expect(kernel.okOrRefusal).toBe(okOrRefusal);

    expect(kernel.storeMdFileOf).toBe(storeMdFileOf);
    expect(kernel.storeMdFileOf({ projectPath: "{projectPath}", storeMdFile: "src/STORE.md" })).toBe("{projectPath}/src/STORE.md");
    expect(kernel.storeMdFileOf({ projectPath: "{projectPath}", storeMdFile: "../STORE.md" })).toBe("{projectPath}/../STORE.md");
    expect(kernel.storeMdFileOf({ projectPath: "{projectPath}" })).toBe("{projectPath}/STORE.md");
    expect(kernel.storeMdFileOf({ projectPath: dir, storeMdFile: "../STORE.md" })).toBe(path.join(tmp, "STORE.md"));

    for (const storeMdFile of ["/etc/STORE.md", "C:\\Users\\x\\STORE.md", "src/notes.md", "", 7 as unknown as string]) {
      expect(kernel.storeMdFileOf({ projectPath: "{projectPath}", storeMdFile })).toBe("{projectPath}/STORE.md");
    }

    const labeled = kernel.localListingOf({ projectPath: "{projectPath}", storeMdFile: "src/STORE.md", storeMd: "# Store\n\n## Listing\n\n- Summary: hello\n", chromeWebStoreMd: null, icons: {} }, "chrome");

    expect("file" in labeled && labeled.file).toBe("{projectPath}/src/STORE.md");
    expect(kernel.localListingOf({ projectPath: "{projectPath}", storeMdFile: "src/STORE.md", storeMd: null, chromeWebStoreMd: null, icons: {} }, "chrome")).toMatchObject({ problem: expect.stringMatching(/^No STORE\.md at \{projectPath\}\/src\/STORE\.md\. /) });

    const parsed: kernel.ParsedFrame = { ok: false, command: "extension_release_status", status: "status-unavailable", error: null };

    expect(JSON.parse(kernel.reframed(parsed)).error.code).toBe("E_UNSPECIFIED");
    expect([...kernel.registeredKernelHooks()].sort()).toEqual(Object.keys(PLATFORM_KERNEL_HOOKS).sort());

    kernel.registerKernelHooks({
      serverLogins: () => ({ live: [], kept: null }),
      loginForPath: () => ({ state: "unmatched", named: ["cezaraugusto/hosted-only"] }),
      unloggedProjectStep: (ref) => ({ hint: `registered step for ${ref}`, value: { registered: true } }),
    });

    try {
      const out = await call("extension_builds", { action: "list", limit: 3, projectPath: dir, api: API });

      expect(out.status).toBe("no-login-for-project");
      expect(out.value.named).toEqual(["cezaraugusto/hosted-only"]);
      expect(out.value.registered).toBe(true);
      expect(out.hint).toBe("registered step for cezaraugusto/hosted-only");
      expect(lane.sentAnything()).toBe(false);
    } finally {
      installPlatformKernelHooks();
    }
  });
});

describe("the guided store connect opens the MCP's own browser with extension.dev tools", () => {
  const STORE_CRX = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "extension-dev-tools-0.1.0.crx"));
  const HANDOFF = `${API}/device/handoff#one-time-secret-code`;
  const PAGE = "http://console.extension.localhost/cezaraugusto/settings/store-accounts?store=edge";
  let launches: LaunchPlan[];
  let asked: string[];

  function runtime(browser: "edge" | "chromium", answer: (url: string) => Response | Promise<Response>): GuidedConnectRuntime {
    return {
      launchBlock: () => "",
      probe: () => ({
        platform: "darwin",
        systemBinary: (name) => (name === browser ? `/Applications/${name}.app/Contents/MacOS/${name}` : null),
        managedBinary: () => null,
        lastUsed: () => 1,
        defaultBrowser: () => null,
      }),
      fetch: (async (url: string) => {
        asked.push(String(url));

        return answer(String(url));
      }) as unknown as typeof fetch,
      stateDir: () => tmp,
      cacheDir: () => path.join(tmp, "cache"),
      headless: () => true,
      launch: (plan) => {
        launches.push(plan);

        return { launched: true, reused: false };
      },
    };
  }

  function varint(value: number): Buffer {
    const out: number[] = [];
    for (let rest = value; rest >= 0x80; rest >>>= 7) out.push((rest & 0x7f) | 0x80);
    out.push(value >>> (7 * out.length));

    return Buffer.from(out);
  }

  function proto(field: number, bytes: Buffer): Buffer {
    return Buffer.concat([varint(field * 8 + 2), varint(bytes.length), bytes]);
  }

  function signedCrx(zip: Buffer): { bytes: Buffer; id: string } {
    const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
    const der = publicKey.export({ type: "spki", format: "der" });
    const id = crxIdOf(der);
    const signedHeader = proto(1, Buffer.from(crypto.createHash("sha256").update(der).digest().subarray(0, 16)));
    const size = Buffer.alloc(4);
    size.writeUInt32LE(signedHeader.length);
    const signature = crypto.sign("sha256", Buffer.concat([Buffer.from("CRX3 SignedData\x00", "binary"), size, signedHeader, zip]), privateKey);
    const header = Buffer.concat([proto(2, Buffer.concat([proto(1, der), proto(2, signature)])), proto(10000, signedHeader)]);
    const prefix = Buffer.alloc(12);
    prefix.write("Cr24", 0, "binary");
    prefix.writeUInt32LE(3, 4);
    prefix.writeUInt32LE(header.length, 8);

    return { bytes: Buffer.concat([prefix, header, zip]), id };
  }

  async function guided(workspace: string, rt: GuidedConnectRuntime, store = "edge") {
    return JSON.parse(await guideStoreConnect(workspaceConnectAnswer("extension_submit", workspace, [store], API), { browsers: [store], api: API }, rt));
  }

  function handing(url: string, bodies: string[] = []): GuidedConnectRuntime {
    return {
      ...runtime("edge", () => new Response("", { status: 404 })),
      fetch: (async (target: string, init?: RequestInit) => {
        if (!String(target).endsWith("/api/cli/console-handoff")) return new Response("", { status: 404 });

        bodies.push(String(init?.body));

        return Response.json({ url });
      }) as unknown as typeof fetch,
    };
  }

  beforeEach(() => {
    launches = [];
    asked = [];
  });

  it("verifies a CRX3 by its signed id and refuses another item, a tampered archive and a non-CRX", () => {
    const crx = signedCrx(Buffer.from("PK zip bytes"));

    expect(readCrx3(crx.bytes, crx.id)).toMatchObject({ ok: true });
    expect(readCrx3(crx.bytes, "omndndgipeomhfdobfbhpfemempnnpjp")).toEqual({ ok: false, reason: `the CRX names item ${crx.id}, not omndndgipeomhfdobfbhpfemempnnpjp` });
    expect(readCrx3(Buffer.concat([crx.bytes.subarray(0, -1), Buffer.from("X")]), crx.id)).toEqual({ ok: false, reason: "the CRX signature of the item does not verify" });
    expect(readCrx3(Buffer.from("PK\x03\x04 not a crx"), crx.id)).toEqual({ ok: false, reason: "the download is not a CRX file" });
    expect(readCrx3(STORE_CRX, "omndndgipeomhfdobfbhpfemempnnpjp")).toMatchObject({ ok: true });
  });

  it("refuses the Chrome Web Store item served for the Edge item and loads the bundled copy, saying so", async () => {
    otherProcessesSignIn("rebeccat");

    const out = await guided("cezaraugusto", runtime("edge", (url) => (url.includes("edge.microsoft.com") ? new Response(STORE_CRX) : new Response("", { status: 404 }))));

    expect(asked[0]).toContain("edge.microsoft.com/extensionwebstorebase/v1/crx");
    expect(out.value.toolsExtension).toMatchObject({ source: "bundled", version: "0.1.2" });
    expect(out.hint).toContain("Edge Add-ons was not used because its download was refused: the CRX names item omndndgipeomhfdobfbhpfemempnnpjp, not pnijfgjkilbnmjiomlajfbmiccjejbpm");
    expect(fs.existsSync(path.join(launches[0]!.extensionDir, "manifest.json"))).toBe(true);
  });

  it("loads the bundled copy when the store serves a version under the minimum, or cannot be reached", async () => {
    otherProcessesSignIn("rebeccat");

    const older = await guided("cezaraugusto", runtime("chromium", (url) => (url.includes("clients2.google.com") ? new Response(STORE_CRX) : new Response("", { status: 404 }))));

    expect(older.value.toolsExtension.note).toBe("The Chrome Web Store serves 0.1.0, older than 0.1.2, so extension.dev tools 0.1.2 is the copy bundled with this MCP.");
    expect(launches[0]!.extensionDir).toContain("bundled-chromium-0.1.2");

    const offline = await guided("cezaraugusto", runtime("chromium", () => Promise.reject(new Error("getaddrinfo ENOTFOUND"))));

    expect(offline.value.toolsExtension.source).toBe("bundled");
    expect(offline.hint).toContain("could not be reached (getaddrinfo ENOTFOUND)");
  });

  it("opens the plain console page on a platform without the handoff door and says the person signs in once", async () => {
    otherProcessesSignIn("rebeccat");

    const out = await guided("cezaraugusto", runtime("edge", () => new Response("", { status: 404 })));

    expect(asked).toContain(`${API}/api/cli/console-handoff`);
    expect(launches[0]!.url).toBe(PAGE);
    expect(out).toMatchObject({ ok: true, status: "workspace-connect-guided", value: { signedIn: false, storeAccountsUrl: PAGE, guidedBrowser: { browser: "edge", profile: path.join(tmp, "guided-browser", "edge", "profile") } } });
    expect(out.hint).toContain("signs in to extension.dev there once");
    expect(out.value.sayToPerson).toContain("sign in to extension.dev once, then follow the extension.dev tools panel");
  });

  it("opens the one-time handoff address signed in, and never puts it in the answer", async () => {
    otherProcessesSignIn("rebeccat");
    let body = "";
    let auth = "";

    const out = await guided("cezaraugusto", {
      ...runtime("edge", () => new Response("", { status: 404 })),
      fetch: (async (url: string, init?: RequestInit) => {
        if (!String(url).endsWith("/api/cli/console-handoff")) return new Response("", { status: 404 });

        body = String(init?.body);
        auth = String((init?.headers as Record<string, string>).authorization);

        return Response.json({ url: HANDOFF });
      }) as unknown as typeof fetch,
    });

    expect(JSON.parse(body)).toEqual({ next: "/cezaraugusto/settings/store-accounts?store=edge" });
    expect(auth).toBe("Bearer rebeccat.sig");
    expect(launches[0]!.url).toBe(HANDOFF);
    expect(JSON.stringify(out)).not.toContain("device/handoff");
    expect(out.value.signedIn).toBe(true);
    expect(JSON.stringify(out)).not.toContain("one-time-secret-code");
    expect(JSON.stringify(out)).not.toContain("auth/handoff");
    expect(out.hint).toContain(`extension_workspace {action:"info", workspace:"cezaraugusto", include:["storeAccounts"]}`);
  });

  it("opens a handoff only on the platform origin it calls or on its console, and sends next in the one shape the door takes", async () => {
    otherProcessesSignIn("rebeccat");
    const bodies: string[] = [];

    for (const foreign of ["https://docs.extension.dev/device/handoff#c", "https://www.extension.dev/device/handoff#c", "https://evil.test/device/handoff#c", "http://inspect.extension.localhost/x#c"]) {
      const out = await guided("cezaraugusto", handing(foreign, bodies));

      expect(launches[launches.length - 1]!.url, foreign).toBe(PAGE);
      expect(out.value.signedIn, foreign).toBe(false);
    }

    await guided("cezaraugusto", handing("http://console.extension.localhost/cezaraugusto/settings/store-accounts#c", bodies));
    expect(launches[launches.length - 1]!.url).toBe("http://console.extension.localhost/cezaraugusto/settings/store-accounts#c");

    await guided("cezaraugusto", handing(HANDOFF, bodies), "safari");
    expect(JSON.parse(bodies[bodies.length - 1]!)).toEqual({ next: "/cezaraugusto/settings/store-accounts" });
    expect(JSON.parse(bodies[0]!)).toEqual({ next: "/cezaraugusto/settings/store-accounts?store=edge" });
  });

  it("opens no browser where none may open, and answers the console page as before", async () => {
    const out = await guided("extensiondev", { ...runtime("edge", () => new Response("")), launchBlock: () => "CI is set in this server's environment" });

    expect(out).toMatchObject({ status: "workspace-connect-in-console", value: { guidedBrowser: { opened: false } } });
    expect(out.hint).toMatch(/^No browser was opened: CI is set in this server's environment\. A workspace owner connects Edge Add-ons/);
    expect(launches).toEqual([]);
    expect(asked).toEqual([]);
  });
});

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const MACHINE_BUILTINS = new Set(["fs", "fs/promises", "node:fs", "node:fs/promises", "child_process", "node:child_process"]);
const MACHINE_MODULES = new Set(
  ["credentials", "credential-source", "session-identity", "session-login", "private-file", "user-cache-dir", "created-projects", "approval-record", "held-batches", "pending-creates", "path-project", "approval-open"].map(
    (name) => `src/lib/${name}.ts`,
  ),
);
const ALLOWED_MACHINE_MODULES = new Set(["src/lib/credentials.ts", "src/lib/credential-source.ts"]);

function planFiles(section: string): string[] {
  return [...section.matchAll(/`((?:lib|tools)\/[^`]+\.ts)`/g)].map((match) => `src/${match[1]}`);
}

function planSection(plan: string, from: string, to: string): string {
  return plan.split(from)[1]?.split(to)[0] ?? "";
}

function typeOnly(elements: ts.NodeArray<ts.ImportSpecifier | ts.ExportSpecifier>): boolean {
  return elements.length > 0 && elements.every((element) => element.isTypeOnly);
}

function runtimeImports(file: string): string[] {
  const source = ts.createSourceFile(file, fs.readFileSync(path.join(REPO, ...file.split("/")), "utf8"), ts.ScriptTarget.Latest, true);
  const found: string[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      const bindings = clause?.namedBindings;
      const elided = clause?.isTypeOnly || (clause && !clause.name && bindings && ts.isNamedImports(bindings) && typeOnly(bindings.elements));
      if (!elided) found.push(node.moduleSpecifier.text);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.exportClause;
      if (!node.isTypeOnly && !(clause && ts.isNamedExports(clause) && typeOnly(clause.elements))) found.push(node.moduleSpecifier.text);
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) {
      found.push(node.arguments[0].text);
    }

    ts.forEachChild(node, visit);
  };

  visit(source);

  return found;
}

function resolveImport(from: string, specifier: string): string {
  if (!specifier.startsWith(".")) return specifier;

  const base = path.posix.normalize(path.posix.join(path.posix.dirname(from), specifier));
  const hit = [base, `${base}.ts`, `${base}/index.ts`].find((candidate) => fs.statSync(path.join(REPO, ...candidate.split("/")), { throwIfNoEntry: false })?.isFile());

  return hit ?? base;
}
