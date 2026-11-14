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
import { loginForPath, pathIdentity } from "../lib/path-project";
import { PLATFORM_KERNEL_HOOKS, installPlatformKernelHooks } from "../lib/platform-kernel-hooks";
import { createToolDispatcher, type ToolModule } from "../lib/tool-dispatch";
import * as builds from "../tools/builds";
import * as releaseStatus from "../tools/release-status";
import * as kernel from "../kernel";
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
    tools: [submit, releaseStatus, builds] as unknown as ToolModule[],
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
