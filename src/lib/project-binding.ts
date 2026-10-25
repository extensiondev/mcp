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
import { envelope, isEnvelope } from "./envelope";
import { loginForPath, serverLogins } from "./path-project";
import { TOOL_POLICY, type ServerOptions } from "./tool-policy";

type Args = Record<string, unknown>;

const UNBOUND = new Set(["extension_auth", "extension_workspace_create", "extension_project_create"]);
const WORKSPACE_READS = new Set(["info", "projects", "usage"]);
const PATH_NAMES_PROJECT = new Set(["extension_submit", "extension_shares", "extension_preview_web"]);

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function takesProject(name: string, args: Args, inputSchema: Record<string, unknown>): boolean {
  if (TOOL_POLICY[name]?.group !== "platform" || UNBOUND.has(name)) return false;

  const properties = inputSchema.properties;
  if (!properties || typeof properties !== "object" || !("project" in properties)) return false;
  if (name === "extension_preview_web" && args.share !== true) return false;
  if (name === "extension_workspace" && WORKSPACE_READS.has(text(args.action) || "info")) return false;

  return true;
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
  return envelope({
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
 * by signing in through it. Several stored logins and no way to tell them
 * apart is a refusal that lists them, never the newest one. The project an
 * answer was made for leads its value as answeredFor.
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
  if (args.projects !== undefined && args.projects !== null) return { args, answeredFor: null };
  if (options.project || pinnedProject() || requestCredential() || envToken()) return { args, answeredFor: resolvedRef(api) };

  const logins = serverLogins(api);
  const projectPath = PATH_NAMES_PROJECT.has(name) ? text(args.projectPath) : "";
  const fallback = logins.kept ?? (logins.live.length === 1 ? (logins.live[0] ?? null) : null);

  if (projectPath) {
    const found = loginForPath(projectPath, api);

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

    if (found.state === "unmatched" && logins.live.length > 0) {
      const defaultSaid = fallback ? ` The default login here is ${fallback}, and it was not used in its place.` : "";

      return {
        refused: refusal(
          name,
          "project-mismatch",
          `projectPath ${projectPath} is the project ${found.named.join(" or ")}, and no login stored on this machine is for it, so nothing was read or sent.${defaultSaid}`,
          `Sign in to it with extension_auth (action: login, project: '${found.named[0]}'), or pass project naming the login to use: ${quoted(logins.live)}.`,
          { projectPath, named: found.named, logins: logins.live, ...(fallback ? { defaultLogin: fallback } : {}) },
        ),
      };
    }
  }

  if (!fallback && logins.live.length > 1) {
    return {
      refused: refusal(
        name,
        "project-ambiguous",
        `This machine holds ${logins.live.length} logins for this server (${logins.live.join(", ")}) and the call named neither project nor projectPath, so it was not sent: the newest login could be another agent's project.`,
        `Pass project: one of ${quoted(logins.live)}${PATH_NAMES_PROJECT.has(name) ? ", or projectPath for the extension's directory" : ""}.`,
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

  return envelope({
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
