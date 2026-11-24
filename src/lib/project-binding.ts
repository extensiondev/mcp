// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { approvalLogin } from "./approval-scope";
import { envToken, requestCredential } from "./credential-scope";
import { resolveCredential } from "./credential-source";
import { pinnedProject, readCredentials } from "./credentials";
import { composedRefusal } from "./composed-refusal";
import { isEnvelope, reframed } from "./envelope";
import { kernelHook } from "./kernel-hooks";
import { noLoginForProjectRefusal } from "./no-login-for-project";
import { clientProjectDir } from "./client-roots";
import { workspaceConnectAnswer } from "./store-connection";
import { inputValidationError } from "./validate-input";
import { runsOnPlatform, type ServerOptions } from "./tool-policy";

type Args = Record<string, unknown>;

const UNBOUND = new Set(["extension_auth", "extension_workspace_create", "extension_project_create"]);
const WORKSPACE_READS = new Set(["info", "projects", "usage"]);
const WORKSPACE_SLUG = /^[a-z0-9][a-z0-9-]{0,99}$/;

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function takesProject(name: string, args: Args, inputSchema: Record<string, unknown>): boolean {
  if (!runsOnPlatform(name) || UNBOUND.has(name)) return false;

  const properties = inputSchema.properties;
  if (!properties || typeof properties !== "object" || !("project" in properties)) return false;
  if (name === "extension_preview_web" && args.share !== true) return false;
  if (name === "extension_workspace" && WORKSPACE_READS.has(text(args.action) || "info")) return false;

  return true;
}

function isConnect(name: string, args: Args): boolean {
  return (name === "extension_submit" || name === "extension_submit_check") && text(args.action) === "connect";
}

function takesPath(inputSchema: Record<string, unknown>): boolean {
  const properties = inputSchema.properties;

  return Boolean(properties && typeof properties === "object" && "projectPath" in properties);
}

function refOf(entry: { workspaceSlug: string; projectSlug: string }): string {
  return `${entry.workspaceSlug}/${entry.projectSlug}`.toLowerCase();
}

function namedRef(named: string, workspace: string, api?: string): string {
  if (!named.includes("/") && workspace) return `${workspace}/${named}`.toLowerCase();

  const stored = readCredentials({ project: named, api });

  return stored ? refOf(stored) : named.toLowerCase();
}

function resolvedRef(api?: string): string | null {
  const ref = resolveCredential({ api }).ref;

  return ref ? `${ref.workspace}/${ref.project}`.toLowerCase() : null;
}

function quoted(list: string[]): string {
  return list.map((entry) => `'${entry}'`).join(", ");
}

function refusal(name: string, status: string, message: string, hint: string, value: Args): string {
  return composedRefusal({
    ok: false,
    command: name,
    status,
    value,
    error: { code: "E_PROJECT_AMBIGUOUS", name: "ProjectAmbiguous", message },
    hint,
  });
}

export type CallProject = { args: Args; answeredFor: string | null; note?: string } | { refused: string };

/* @invariant A PLATFORM CALL KNOWS WHICH PROJECT IT ANSWERS FOR BEFORE IT IS
 * SENT. A named project, a pin, the connection's own token,
 * EXTENSION_DEV_TOKEN and the login an approval was minted under each settle
 * it. Otherwise a project directory settles it (path-project.ts), and with
 * neither, the one stored login on the server, or the one this server chose
 * by signing in through it. With several logins, the client's one directory
 * (projectPath, its single root, or the working directory) settles it only
 * when its GitHub origin is exactly one stored login's '<workspace>/<project>'
 * (ledger 391), and the answer says so. Several stored logins and no way to tell them
 * apart is a refusal that lists them, never the newest one. A directory
 * whose project no stored login is for is a no-login-for-project refusal
 * that names the create or the login to finish, never another project's
 * login (ledger 287). The project an answer was made for leads its value as
 * answeredFor.
 */
export function bindCallProject(
  name: string,
  args: Args,
  inputSchema: Record<string, unknown>,
  options: ServerOptions,
): CallProject {
  if (!takesProject(name, args, inputSchema)) return { args, answeredFor: null };

  const api = text(args.api) || undefined;
  const named = text(args.project);
  const held = approvalLogin();

  if (held) return { args, answeredFor: refOf(held) };
  if (named) return { args, answeredFor: namedRef(named, text(args.workspace), api) };

  if (isConnect(name, args) && args.workspace !== undefined && args.workspace !== "") {
    const workspace = typeof args.workspace === "string" ? args.workspace : "";

    if (!WORKSPACE_SLUG.test(workspace)) {
      return {
        refused: inputValidationError(
          name,
          [{ path: "workspace", message: "a workspace slug is lowercase letters, digits and dashes, at most 100" }],
          undefined,
          "Pass workspace as the slug in the workspace's console address, such as 'acme'.",
        ),
      };
    }

    const stores = Array.isArray(args.browsers) ? args.browsers.map(text).filter(Boolean) : [];

    return { refused: workspaceConnectAnswer(name, workspace, stores, api) };
  }

  const sessionProject = name === "extension_submit" ? kernelHook("connectSessionProject")(args.connectSession) : null;
  if (sessionProject) return { args: { ...args, project: sessionProject }, answeredFor: sessionProject };
  if (options.project || pinnedProject() || requestCredential() || envToken()) return { args, answeredFor: resolvedRef(api) };

  const logins = kernelHook("serverLogins")(api);
  const projectPath = takesPath(inputSchema) ? text(args.projectPath) : "";
  const fallback = logins.kept ?? (logins.live.length === 1 ? (logins.live[0] ?? null) : null);

  if (projectPath) {
    const found = kernelHook("loginForPath")(projectPath, api);

    if (found.state === "match") {
      const other = fallback && fallback !== found.project ? fallback : null;
      const said = other || logins.live.length > 1;

      return {
        args: { ...args, project: found.project },
        answeredFor: found.project,
        ...(said
          ? { note: `Answered for ${found.project}, the project at projectPath (its ${found.via})${other ? `, not ${other}, this server's default login` : ""}.` }
          : {}),
      };
    }

    if (found.state === "unmatched") {
      return {
        refused: noLoginForProjectRefusal({ name, callArgs: args, projectPath, named: found.named, defaultLogin: fallback, api }),
      };
    }
  }

  if (!fallback && logins.live.length > 1) {
    const dir = text(args.projectPath) || clientProjectDir();
    const origin = dir ? kernelHook("loginForOrigin")(dir, api) : null;

    if (dir && origin) {
      return {
        args: { ...args, project: origin.project },
        answeredFor: origin.project,
        note: `Answered for ${origin.project}, from the origin remote of ${dir} (github.com/${origin.owner}/${origin.repo}); ${logins.live.length} logins are stored, so pass project to answer for another.`,
      };
    }

    const expired = logins.expired ?? [];
    const expiredSaid = expired.length
      ? ` ${quoted(expired)} ${expired.length === 1 ? "is stored too but has expired, so it is not a choice" : "are stored too but have expired, so they are not choices"}; extension_auth_login (action: login, project: "${expired[0]}") signs in again.`
      : "";
    const unbound = text(args.projectPath) ? "the folder at projectPath names no project this server could bind" : "the call named neither project nor projectPath";

    return {
      refused: refusal(
        name,
        "project-ambiguous",
        `This machine holds ${logins.live.length} logins for this server (${logins.live.join(", ")}) and ${unbound}, so it was not sent: the newest login could be another agent's project.`,
        isConnect(name, args)
          ? `Pass project: one of ${quoted(logins.live)}, or workspace: '<workspace>' for an account every project of that workspace uses.${expiredSaid}`
          : `Pass project: one of ${quoted(logins.live)}${takesPath(inputSchema) ? ", or projectPath for the extension's directory" : ""}.${expiredSaid}`,
        { logins: logins.live },
      ),
    };
  }

  return { args, answeredFor: fallback };
}

export function stampAnsweredFor(answer: string, answeredFor: string | null): string {
  if (!answeredFor) return answer;

  let parsed: unknown;

  try {
    parsed = JSON.parse(answer);
  } catch {
    return answer;
  }

  if (!isEnvelope(parsed)) return answer;

  const value = parsed.value && typeof parsed.value === "object" && !Array.isArray(parsed.value) ? (parsed.value as Args) : null;
  if (parsed.value !== null && parsed.value !== undefined && !value) return answer;
  if (value && typeof value.answeredFor === "string") return answer;

  const frame = parsed as typeof parsed & { hint?: string };

  return reframed({
    ok: frame.ok,
    command: frame.command,
    status: frame.status,
    value: { answeredFor, ...(value ?? {}) },
    error: frame.error ?? undefined,
    warnings: frame.warnings,
    ...(frame.truncated !== undefined ? { truncated: frame.truncated } : {}),
    ...(frame.hint ? { hint: frame.hint } : {}),
  });
}
