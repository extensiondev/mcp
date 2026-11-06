// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { API_BASE, PROJECT_PATH } from "../lib/common-schema";
import { isProjectRef } from "../lib/credentials";
import { appendWarnings } from "../lib/envelope-warnings";
import { loginForPath, pathIdentity } from "../lib/path-project";
import { DEVICE_WAIT_MAX_SECONDS, deviceWaitDescription } from "../lib/device-wait";
import { envelope } from "../lib/envelope";
import { loginToProject, loginToProjects, loginToWorkspace } from "./login";
import { WORKSPACE_WILDCARD } from "../lib/project-batch";
import { readIdentity } from "./whoami";
import { clearLocalCredentials } from "./logout";

export const schema = {
  name: "extension_auth",
  description:
    "Sign in to an existing extension.dev project (a code for extension.dev/device, then deviceCode and waitSeconds), list stored logins, or clear them. Identity is the stored token, not the working directory; value.server.verdict is confirmed, refused or unavailable. Tokens live 7 days (CI: Access tokens).",
  inputSchema: {
    type: "object" as const,
    properties: {
      action: {
        type: "string",
        enum: ["status", "login", "logout"],
        default: "status",
        description: "status lists logins; login signs in; logout deletes the local login.",
      },
      project: {
        type: "string",
        description: "'<workspace>/<project>' from console.extension.dev (new: extension.dev/new).",
      },
      projectPath: {
        ...PROJECT_PATH,
        description: "login: the directory whose GitHub origin names the project.",
      },
      projects: {
        type: ["array", "string"],
        items: { type: "string" },
        description: "login: 1 to 20 existing projects of one workspace, at most 48 characters each, or \"*\" with workspace.",
      },
      workspace: {
        type: "string",
        description: "login with projects: \"*\": the workspace.",
      },
      deviceCode: {
        type: "string",
        description: "login: resume token.",
      },
      waitSeconds: {
        type: "number",
        minimum: 0,
        maximum: DEVICE_WAIT_MAX_SECONDS,
        description: deviceWaitDescription(),
      },
      api: API_BASE,
    },
    required: [],
  },
};

function listMisuse(message: string): string {
  return envelope({
    ok: false,
    command: "extension_auth",
    status: "bad-request",
    error: { code: "E_BAD_REQUEST", name: "BadRequest", message },
  });
}

function projectAtPath(projectPath: string, api?: string): { project: string; via: string } | null {
  const found = loginForPath(projectPath, api);
  if (found.state === "match") return { project: found.project, via: `its ${found.via}, a stored login` };

  const { owner, repo } = pathIdentity(projectPath);
  const project = `${owner}/${repo}`;

  return owner && repo && isProjectRef(project) ? { project, via: "its GitHub origin" } : null;
}

export async function handler(args: {
  action?: string;
  project?: string;
  projectPath?: string;
  projects?: unknown;
  workspace?: string;
  deviceCode?: string;
  waitSeconds?: unknown;
  api?: string;
}): Promise<string> {
  const action = args.action ?? "status";
  const hasList = args.projects !== undefined && args.projects !== null;
  const hasWorkspace = String(args.workspace ?? "").trim() !== "";
  const wildcard = args.projects === WORKSPACE_WILDCARD;

  if (hasWorkspace && !wildcard) {
    return listMisuse(
      'workspace is a login input that goes with projects: "*" (every project of that workspace). To sign in to some of its projects, name them in projects instead.',
    );
  }

  if (typeof args.projects === "string" && !wildcard) {
    return listMisuse(
      `projects must be an array of '<workspace>/<project>' names, or the string "*" with workspace; got ${JSON.stringify(args.projects)}.`,
    );
  }

  if (hasList && action !== "login") {
    return listMisuse(
      `projects is a login input: action '${action}' does not take a list. Use project to name one login, or call once per project.`,
    );
  }

  if (action === "logout") return clearLocalCredentials(args.project, args.api);

  if (action === "login" && hasList) {
    if (String(args.project ?? "").trim()) {
      return listMisuse(
        "Pass either project (one login) or projects (one approval for several), not both.",
      );
    }

    if (wildcard) {
      return loginToWorkspace({
        workspace: args.workspace,
        deviceCode: args.deviceCode,
        waitSeconds: args.waitSeconds,
        api: args.api,
      });
    }

    return loginToProjects({
      projects: args.projects,
      deviceCode: args.deviceCode,
      waitSeconds: args.waitSeconds,
      api: args.api,
    });
  }

  if (action === "login") {
    const named = String(args.project ?? "").trim();
    const projectPath = String(args.projectPath ?? "").trim();
    const atPath = !named && projectPath ? projectAtPath(projectPath, args.api) : null;

    if (!named && projectPath && !atPath) {
      return listMisuse(
        `projectPath ${projectPath} names no project: no stored login matches its package.json name or GitHub origin, and it has no github.com origin. Pass project as '<workspace>/<project>'.`,
      );
    }

    const out = await loginToProject({
      project: atPath?.project ?? named,
      deviceCode: args.deviceCode,
      waitSeconds: args.waitSeconds,
      api: args.api,
    });

    return atPath ? appendWarnings(out, [`Logging in to ${atPath.project}, the project at projectPath (${atPath.via}).`]) : out;
  }

  return readIdentity(undefined, args.api, args.project);
}
