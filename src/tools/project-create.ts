// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { API_BASE } from "../lib/common-schema";
import { pollDeviceGrant, requestDeviceCode } from "../lib/device-flow";
import { envelope, type ErrorCode } from "../lib/envelope";
import {
  fetchLoginConfig,
  resolveApiBase,
  safeApiBase,
} from "../lib/login-flow";
import { consoleProjectUrl } from "../lib/registry";
import { identityHeaders } from "../lib/session-identity";

const COMMAND = "extension_project_create";

const FIRST_CALL_BUDGET_MS = 8_000;
const RESUME_BUDGET_MS = 22_000;

export const schema = {
  name: "extension_project_create",
  description:
    "Create an extension.dev project for an extension that does not have one yet, without opening the console. Use it right after extension_create and extension_build, once the extension's source is pushed to a GitHub repository, and BEFORE extension_auth: extension_auth can only log in to a project that already exists, and this tool is what brings that project into existence. Ask for nothing but the project slug and the repo; the platform finds the GitHub App installation on the approving account itself, and if there is none it returns a connect link to open. Two-phase, like login: the first call returns a code and a URL where the signed-in workspace owner approves creating exactly this project; call again with the returned deviceCode to finish. The approval mints a provisioning grant that lives minutes, can only create the one named project, and is never stored on this machine. On success the platform creates the project, its mirror repository, and dispatches the first build. Then run extension_auth (action: login) against the new project, and extension_publish to share it.",
  inputSchema: {
    type: "object" as const,
    properties: {
      project: {
        type: "string",
        description:
          "Target project as '<workspace>/<project>'. The workspace is the GitHub login of the approving user for personal workspaces; the project slug is the new project's name and must not exist yet.",
      },
      repo: {
        type: "string",
        description:
          "Source GitHub repository as '<owner>/<repo>'. The extension's code must be pushed there, and the owner must be the same GitHub account that approves the device code.",
      },
      installationId: {
        type: "string",
        description:
          "Optional override. Leave it out: the platform finds the extension.dev GitHub App installation on the approving account itself. Pass it only when an operator needs to name one explicitly, and it must still be an installation on that account or the platform refuses it.",
      },
      displayName: {
        type: "string",
        description: "Human name for the project. Defaults to the project slug.",
      },
      description: {
        type: "string",
        description:
          "Short project description. Defaults to a generic sentence naming the repo.",
      },
      installCommand: {
        type: "string",
        default: "npm install",
        description: "Dependency install command the build runs first.",
      },
      buildCommand: {
        type: "string",
        default: "npm run build",
        description: "Build command producing the extension bundle.",
      },
      outputDirectory: {
        type: "string",
        default: "dist/chrome",
        description: "Directory the build writes the loadable extension into.",
      },
      deviceCode: {
        type: "string",
        description:
          "Resume token from the prior call's `deviceCode`; omit on the first call.",
      },
      api: API_BASE,
    },
    required: ["project", "repo"],
  },
};

function fail(
  name: string,
  message: string,
  status: string,
  code: ErrorCode,
): string {
  return envelope({
    ok: false,
    command: COMMAND,
    status,
    error: { code, name, message },
  });
}

function pendingEnvelope(start: {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
}): string {
  const complete = String(start.verificationUriComplete || "").trim();
  const hasCompleteLink =
    complete.length > 0 && complete !== start.verificationUri;
  const message = hasCompleteLink
    ? `Open ${complete} and approve creating the project (code ${start.userCode} is pre-filled), then call extension_project_create again with this deviceCode and the same arguments. If the page asks for a code, enter ${start.userCode} at ${start.verificationUri}.`
    : `Open ${start.verificationUri}, enter code ${start.userCode}, approve creating the project, then call extension_project_create again with this deviceCode and the same arguments.`;
  return envelope({
    ok: false,
    command: COMMAND,
    status: "authorization-pending",
    error: { code: "E_AUTH_PENDING", message },
    value: {
      userCode: start.userCode,
      verificationUri: start.verificationUri,
      ...(hasCompleteLink ? { verificationUriComplete: complete } : {}),
      deviceCode: start.deviceCode,
    },
    hint: message,
  });
}

function buildCreateBody(args: {
  workspace: string;
  projectSlug: string;
  owner: string;
  repoName: string;
  installationId?: string;
  displayName?: string;
  description?: string;
  installCommand?: string;
  buildCommand?: string;
  outputDirectory?: string;
}): Record<string, unknown> {
  const installCommand = String(args.installCommand || "npm install").trim();
  const buildCommand = String(args.buildCommand || "npm run build").trim();
  const outputDirectory = String(
    args.outputDirectory || "dist/chrome",
  ).trim();
  const browser = (enabled: boolean) => ({
    enabled,
    installCommand,
    buildCommand,
    outputDirectory,
  });
  return {
    info: {
      id: "",
      name: args.projectSlug,
      displayName: String(args.displayName || args.projectSlug).trim(),
      description: String(
        args.description ||
          `Browser extension project for ${args.owner}/${args.repoName}.`,
      ).trim(),
    },
    build: {
      chrome: browser(true),
      edge: browser(false),
      firefox: browser(false),
    },
    deployment: {
      branch: "",
      nodeVersion: "",
      runWhatsNew: false,
      runExtensionExecutables: false,
    },
    github: {
      owner: args.owner,
      repo: args.repoName,
      installationId: args.installationId,
      createdAt: new Date().toISOString(),
      pullRequestComments: true,
      commitComments: false,
    },
    workspaceSlug: args.workspace,
    createdFrom: { kind: "repository", ref: `${args.owner}/${args.repoName}` },
  };
}

export async function handler(args: {
  project: string;
  repo: string;
  installationId?: string;
  displayName?: string;
  description?: string;
  installCommand?: string;
  buildCommand?: string;
  outputDirectory?: string;
  deviceCode?: string;
  api?: string;
}): Promise<string> {
  const project = String(args.project || "").trim();
  if (!/^[^/]+\/[^/]+$/.test(project)) {
    return fail(
      "BadRequest",
      "project must be in the form '<workspace>/<project>'.",
      "bad-request",
      "E_BAD_REQUEST",
    );
  }
  const repo = String(args.repo || "").trim();
  if (!/^[^/]+\/[^/]+$/.test(repo)) {
    return fail(
      "BadRequest",
      "repo must be in the form '<owner>/<repo>', a GitHub repository the extension's source is pushed to.",
      "bad-request",
      "E_BAD_REQUEST",
    );
  }
  const installationId = String(args.installationId || "").trim();
  if (installationId && !/^\d+$/.test(installationId)) {
    return fail(
      "BadRequest",
      "installationId is optional, and when given it must be the numeric extension.dev GitHub App installation id. Omit it and the platform resolves it from the approving account.",
      "bad-request",
      "E_BAD_REQUEST",
    );
  }

  const apiCheck = safeApiBase(resolveApiBase(args.api), args.api);
  if (!apiCheck.ok) {
    return fail("ConfigError", apiCheck.message, "bad-request", "E_BAD_REQUEST");
  }
  const apiBase = apiCheck.base;

  let config;
  try {
    config = await fetchLoginConfig(apiBase);
  } catch (err: any) {
    return fail(
      "ConfigError",
      err?.message || "Could not load login config.",
      "create-failed",
      "E_PLATFORM",
    );
  }

  let deviceCode = String(args.deviceCode || "").trim();
  let interval = 5;
  let budgetMs = RESUME_BUDGET_MS;
  if (!deviceCode) {
    let start;
    try {
      start = await requestDeviceCode({
        apiBase,
        path: config.deviceCodeUrl,
        project,
        intent: "create",
      });
    } catch (err: any) {
      const message = err?.message || "Could not start the device flow.";
      const laneClosed = /CLI_PROJECT_CREATE_DISABLED|403/.test(
        String(message),
      );
      return fail(
        "CreateStartError",
        laneClosed
          ? `Headless project creation is not open on this host yet. Create the project in the console instead, then run extension_auth (action: login) against it. (${message})`
          : String(message),
        laneClosed ? "lane-closed" : "create-failed",
        "E_PLATFORM",
      );
    }
    deviceCode = start.deviceCode;
    interval = start.interval;
    budgetMs = FIRST_CALL_BUDGET_MS;
    const early = await pollDeviceGrant({
      apiBase,
      path: config.deviceTokenUrl,
      project,
      deviceCode,
      interval,
      budgetMs,
    });
    if (!early.ok && early.reason === "pending") {
      return pendingEnvelope(start);
    }
    return finishFromPoll(early, {
      apiBase,
      project,
      args,
      verificationUri: config.verificationUri,
      deviceCode,
    });
  }

  const poll = await pollDeviceGrant({
    apiBase,
    path: config.deviceTokenUrl,
    project,
    deviceCode,
    interval,
    budgetMs,
  });
  return finishFromPoll(poll, {
    apiBase,
    project,
    args,
    verificationUri: config.verificationUri,
    deviceCode,
  });
}

async function finishFromPoll(
  poll: Awaited<ReturnType<typeof pollDeviceGrant>>,
  ctx: {
    apiBase: string;
    project: string;
    args: {
      repo: string;
      installationId?: string;
      displayName?: string;
      description?: string;
      installCommand?: string;
      buildCommand?: string;
      outputDirectory?: string;
    };
    verificationUri: string;
    deviceCode: string;
  },
): Promise<string> {
  if (!poll.ok) {
    if (poll.reason === "pending") {
      return envelope({
        ok: false,
        command: COMMAND,
        status: "authorization-pending",
        error: {
          code: "E_AUTH_PENDING",
          message: `Still waiting for approval at ${ctx.verificationUri}. Approve there, then call extension_project_create again with this same deviceCode.`,
        },
        value: {
          verificationUri: ctx.verificationUri,
          deviceCode: ctx.deviceCode,
        },
      });
    }
    if (poll.reason === "denied") {
      return fail(
        "CreateDenied",
        "Creating the project was denied at extension.dev/device.",
        "create-denied",
        "E_AUTH_DENIED",
      );
    }
    if (poll.reason === "expired") {
      return fail(
        "CreateExpired",
        "The device code expired. Run extension_project_create again to restart.",
        "create-expired",
        "E_AUTH_EXPIRED",
      );
    }
    return fail(
      "CreateAuthError",
      poll.message || "Device authorization failed.",
      "create-failed",
      "E_AUTH_FAILED",
    );
  }

  const grant = poll.data;
  const token = String(grant.token || "").trim();
  const workspaceSlug = String(grant.workspaceSlug || "").trim();
  const projectSlug = String(grant.projectSlug || "").trim();
  const [wantWorkspace = "", wantProject = ""] = ctx.project.split("/");
  if (
    workspaceSlug.toLowerCase() !== wantWorkspace.toLowerCase() ||
    projectSlug.toLowerCase() !== wantProject.toLowerCase()
  ) {
    return fail(
      "CreateScopeError",
      `The approval was scoped to ${workspaceSlug}/${projectSlug}, not the requested ${ctx.project}. Nothing was created. Run extension_project_create again with the intended project.`,
      "create-failed",
      "E_AUTH_FAILED",
    );
  }
  if (String(grant.tokenKind || "") !== "provisioning") {
    return envelope({
      ok: false,
      command: COMMAND,
      status: "project-exists",
      error: {
        code: "E_PLATFORM",
        message: `Project ${ctx.project} already exists on this host, so there is nothing to create.`,
      },
      hint: `Run extension_auth (action: login) with project '${ctx.project}' instead; the login lane mints the project token this tool deliberately does not.`,
    });
  }

  const [owner = "", repoName = ""] = ctx.args.repo.split("/");
  const body = buildCreateBody({
    workspace: wantWorkspace,
    projectSlug: wantProject,
    owner,
    repoName,
    installationId: ctx.args.installationId,
    displayName: ctx.args.displayName,
    description: ctx.args.description,
    installCommand: ctx.args.installCommand,
    buildCommand: ctx.args.buildCommand,
    outputDirectory: ctx.args.outputDirectory,
  });

  const url = `${ctx.apiBase}/api/cli/projects/create`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        ...identityHeaders(COMMAND),
      },
      body: JSON.stringify(body),
    });
  } catch (err: any) {
    return fail(
      "CreateNetworkError",
      `Could not reach ${url}: ${err?.message || err}`,
      "create-failed",
      "E_NETWORK",
    );
  }

  const text = await res.text();
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(text);
  } catch {
    data = { message: text };
  }

  if (!res.ok) {
    const code = String(data.code || "");
    if (code === "CLI_PROJECT_CREATE_DISABLED") {
      return fail(
        "CreateClosed",
        String(data.message || "Headless project creation is not open yet."),
        "lane-closed",
        "E_PLATFORM",
      );
    }
    /* @invariant The connect URL is echoed only when the PLATFORM sent one, and
     * it is never constructed here. A tool that builds its own install link is
     * a tool that can be talked into building a link to somebody else's page,
     * and this envelope is read by a model that will hand the link to a human.
     */
    const connectUrl = String(data.connectUrl || "").trim();
    if (
      code === "INSTALLATION_ABSENT" ||
      code === "INSTALLATION_ORG_UNSUPPORTED" ||
      code === "INSTALLATION_AMBIGUOUS"
    ) {
      return envelope({
        ok: false,
        command: COMMAND,
        status: "installation-required",
        error: {
          code: "E_PLATFORM",
          name: "InstallationRequired",
          message: String(
            data.message ||
              "The extension.dev GitHub App is not connected to that account.",
          ),
        },
        ...(connectUrl ? { value: { connectUrl } } : {}),
        hint: connectUrl
          ? `Open ${connectUrl} to connect the extension.dev GitHub App, then call extension_project_create again with the same arguments. Nothing was created.`
          : "Connect the extension.dev GitHub App to the approving account, then call extension_project_create again. Nothing was created.",
      });
    }
    if (code === "PROJECT_EXISTS") {
      return envelope({
        ok: false,
        command: COMMAND,
        status: "project-exists",
        error: {
          code: "E_PLATFORM",
          message: String(data.message || `Project ${ctx.project} already exists.`),
        },
        hint: `Run extension_auth (action: login) with project '${ctx.project}'.`,
      });
    }
    return fail(
      "CreateError",
      `create failed (${res.status}): ${String(
        data.message || (data as { error?: unknown }).error || text || "unknown error",
      ).slice(0, 500)}`,
      "create-failed",
      "E_PLATFORM",
    );
  }

  const finalWorkspace = String(data.workspaceSlug || wantWorkspace);
  const finalProject = String(data.projectSlug || wantProject);
  const consoleUrl = consoleProjectUrl(
    { workspace: finalWorkspace, project: finalProject },
    "",
  );
  return envelope({
    ok: true,
    command: COMMAND,
    status: "created",
    value: {
      workspaceSlug: finalWorkspace,
      projectSlug: finalProject,
      projectId: data.projectId ?? null,
      consoleUrl,
      sourceRepo: ctx.args.repo,
      nextSteps: [
        `extension_auth (action: login, project: '${finalWorkspace}/${finalProject}')`,
        "extension_publish",
      ],
    },
    hint: `Project ${finalWorkspace}/${finalProject} exists and its first build was dispatched. The provisioning grant is now spent and nothing was stored on this machine. Next: extension_auth (action: login, project: '${finalWorkspace}/${finalProject}') to mint the project token, then extension_publish to share it.`,
  });
}
