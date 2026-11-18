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
import { fileURLToPath, pathToFileURL } from "node:url";

import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { clientDirs, setClientRoots } from "../lib/client-roots";
import { resolveCredential } from "../lib/credential-source";
import { credentialKey, credentialsPath, writeCredentials } from "../lib/credentials";
import { okOrRefusal, reframed } from "../lib/envelope";
import { storeMdFileOf } from "../lib/submit-facts";
import { loginForPath, pathIdentity } from "../lib/path-project";
import { PLATFORM_KERNEL_HOOKS, installPlatformKernelHooks } from "../lib/platform-kernel-hooks";
import { forwardable } from "../lib/hosted-forwarder";
import { createToolDispatcher, type ToolModule } from "../lib/tool-dispatch";
import * as builds from "../tools/builds";
import * as releaseStatus from "../tools/release-status";
import * as kernel from "../kernel";
import * as submit from "../tools/submit";
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
