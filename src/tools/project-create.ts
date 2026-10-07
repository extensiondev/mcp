// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { API_BASE } from "../lib/common-schema";
import { pollDeviceGrant, requestDeviceCode } from "../lib/device-flow";
import { laneClosedByServer } from "../lib/credential-source";
import { envelope, type ErrorCode } from "../lib/envelope";
import {
  fetchLoginConfig,
  persistTokenResponse,
  resolveApiBase,
  safeApiBase,
} from "../lib/login-flow";
import {
  DEFAULT_CREATE_PROJECTS_PER_APPROVAL,
  MAX_BATCH_PROJECTS,
  PLATFORM_CREATES_PER_HOUR,
} from "../lib/project-batch";
import { createProjectBatch } from "../lib/project-create-batch";
import { buildCreateBody } from "../lib/project-create-body";
import { consoleBase, consoleProjectUrl } from "../lib/registry";
import { platformHoldEnvelope, sawPlatformHold } from "../lib/platform-hold";
import { identityHeaders } from "../lib/session-identity";
import { spendNarration } from "../lib/allowance";
import { answerIsUnknownOutcome, readCreatedProject } from "../lib/create-answer";
import { isProjectRef } from "../lib/credentials";
import {
  firstBuildSentence,
  firstBuildValue,
  readFirstBuild,
  withheldBecause,
} from "../lib/first-build";

const COMMAND = "extension_project_create";

const FIRST_CALL_BUDGET_MS = 8_000;
const RESUME_BUDGET_MS = 22_000;

export const schema = {
  name: "extension_project_create",
  description:
    `Create an extension.dev project for an extension that does not have one yet, without opening the console. Use it right after extension_create and extension_build, once the extension's source is pushed to a GitHub repository, and BEFORE extension_auth: extension_auth can only log in to a project that already exists, and this tool is what brings that project into existence. Ask for nothing but the project slug and the repo; the platform finds the GitHub App installation on the approving account itself, and if there is none it returns a connect link to open. Two-phase, like login: the first call returns a code and a URL where a signed-in member of the workspace approves creating exactly this project; call again with the returned deviceCode to finish. The approval mints a provisioning grant that lives minutes, can only create the one named project, and is never stored on this machine. On success the platform creates the project and its mirror repository, and dispatches the first build when it can: the answer says in \`firstBuild\` whether one was dispatched and, when none was, why (no commits, no build workflow, a spent build allowance, a paused dispatch). Then run extension_auth (action: login) against the new project, and extension_publish to share it. To create several projects in one workspace under one approval, pass \`projects\` instead of \`project\` and \`repo\`: the approval page lists every name, each project is created by its own request, and each one's 7-day token is stored as that project's login, so no extension_auth call is needed afterwards. A list takes a few calls to finish: while projects remain the answer is status 'creating' with the same deviceCode to call again, and the grant is held in this server's memory only. One approval creates at most ${DEFAULT_CREATE_PROJECTS_PER_APPROVAL} projects, the cap the platform states in its login config, because it creates at most ${PLATFORM_CREATES_PER_HOUR} per hour for one approving account; the next ${DEFAULT_CREATE_PROJECTS_PER_APPROVAL} can start in a new call once that limit allows. A longer list is refused before any approval is asked for, never split silently, and so is any list on a platform that does not advertise batch onboarding.`,
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
        description:
          "Directory the build writes the loadable extension into. With more than one browser, `<browser>` in the path becomes each browser's name (Extension.js writes `dist/<browser>`), and when it is left out every browser defaults to `dist/<browser>`.",
      },
      browsers: {
        type: "array",
        items: { type: "string", enum: ["chrome", "edge", "firefox"] },
        default: ["chrome"],
        description:
          "Browsers the platform builds, each enabled with the same install and build command and its own output directory. Pass every browser the extension targets, for example [\"chrome\", \"edge\", \"firefox\"], so the project needs no console visit to go cross-browser.",
      },
      outputDirectories: {
        type: "object",
        description:
          "Per-browser output directory overrides, for example {\"edge\": \"build/manifestv3\"}. A browser named here wins over `outputDirectory`.",
      },
      projects: {
        type: "array",
        items: { type: "object" },
        description: `Create several projects in one workspace under one approval, instead of \`project\` and \`repo\`. 1 to ${DEFAULT_CREATE_PROJECTS_PER_APPROVAL} entries (the platform's cap per approval; never more than ${MAX_BATCH_PROJECTS}), each { project: '<workspace>/<project>', repo: '<owner>/<repo>' }, all in the same workspace, each project named by its exact slug (lowercase letters and digits joined by single dashes, at most 48 characters), none twice and none existing yet. An entry may also carry displayName, description, installCommand, buildCommand, outputDirectory, browsers and outputDirectories for that project alone; the same inputs at the top level are the shared default for every entry that leaves them out. The answer carries one row per project: created and logged in, created with no token (run a batch extension_auth login), refused with the platform's code, or not attempted. A refusal on one project never hides the others.`,
      },
      deviceCode: {
        type: "string",
        description:
          "Resume token from the prior call's `deviceCode`; omit on the first call. A batch returns the same deviceCode until every listed project has an answer.",
      },
      api: API_BASE,
    },
    required: [] as string[],
  },
};

function fail(
  name: string,
  message: string,
  status: string,
  code: ErrorCode,
  hint?: string,
): string {
  return envelope({
    ok: false,
    command: COMMAND,
    status,
    error: { code, name, message },
    ...(hint ? { hint } : {}),
  });
}

/* @invariant The console route travels as the hint, whatever sentence the
   platform sends: under the public hold the server's own refusal drops the
   "create it in the console" line the open-platform refusal carries. Since
   monorepo c32894d1f the platform consults the hold allowlist before the hold
   flag, so a workspace on WWW_MCP_ACTION_ALLOWED_WORKSPACES creates
   headlessly through the hold and this refusal reaches only workspaces that
   are not on it. */
export function laneClosedHint(): string {
  return `The platform closed headless creation for this call; its own message above says which case this is (the public hold, an allowlist this workspace is not on, or a host that is not ready). Create the project in the console at ${consoleBase()} (workspace page, New project), then run extension_auth (action: login) against it; while the public hold is on, the console answers its gate page until the platform opens.`;
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
    ok: true,
    command: COMMAND,
    status: "authorization-pending",
    value: {
      userCode: start.userCode,
      verificationUri: start.verificationUri,
      ...(hasCompleteLink ? { verificationUriComplete: complete } : {}),
      deviceCode: start.deviceCode,
    },
    hint: message,
  });
}

export async function handler(args: {
  project?: string;
  repo?: string;
  projects?: unknown;
  installationId?: string;
  displayName?: string;
  description?: string;
  installCommand?: string;
  buildCommand?: string;
  outputDirectory?: string;
  browsers?: string[];
  outputDirectories?: Record<string, unknown>;
  deviceCode?: string;
  api?: string;
}): Promise<string> {
  if (args.projects !== undefined && args.projects !== null) {
    return createProjectBatch(args);
  }

  const project = String(args.project || "").trim();

  if (!isProjectRef(project)) {
    return fail(
      "BadRequest",
      "project must be in the form '<workspace>/<project>'.",
      "bad-request",
      "E_BAD_REQUEST",
    );
  }

  const repo = String(args.repo || "").trim();

  if (!isProjectRef(repo)) {
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
      const laneClosed = laneClosedByServer(err, "CLI_PROJECT_CREATE_DISABLED");
      const serverMessage =
        typeof err?.serverMessage === "string" ? err.serverMessage.trim() : "";

      return fail(
        "CreateStartError",
        laneClosed
          ? serverMessage ||
              `Headless project creation is not open on this host yet. Create the project in the console instead, then run extension_auth (action: login) against it. (${message})`
          : String(message),
        laneClosed ? "lane-closed" : "create-failed",
        "E_PLATFORM",
        laneClosed ? laneClosedHint() : undefined,
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
      repo?: string;
      installationId?: string;
      displayName?: string;
      description?: string;
      installCommand?: string;
      buildCommand?: string;
      outputDirectory?: string;
      browsers?: string[];
      outputDirectories?: Record<string, unknown>;
    };
    verificationUri: string;
    deviceCode: string;
  },
): Promise<string> {
  if (!poll.ok) {
    if (poll.reason === "pending") {
      return envelope({
        ok: true,
        command: COMMAND,
        status: "authorization-pending",
        value: {
          verificationUri: ctx.verificationUri,
          deviceCode: ctx.deviceCode,
        },
        hint: `Still waiting for approval at ${ctx.verificationUri}. Approve there, then call extension_project_create again with this same deviceCode.`,
      });
    }

    if (poll.reason === "denied") {
      if (poll.code === "CLI_PROJECT_CREATE_DISABLED") {
        return fail("CreateClosed", poll.message || "Headless project creation is not open on this host.", "lane-closed", "E_PLATFORM", laneClosedHint());
      }

      return fail(
        "CreateDenied",
        `Creating the project was denied at extension.dev/device${poll.code ? ` (${poll.code})` : ""}${poll.message ? `: ${poll.message}` : "."}`,
        "create-denied",
        "E_AUTH_DENIED",
      );
    }

    if (poll.reason === "expired") {
      return fail(
        "CreateExpired",
        `${poll.message || "The device code has expired or is unknown."} Run extension_project_create again to restart.`,
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

  /* @invariant THE LOGIN THE PLATFORM MINTED IS KEPT. For a create-intent code
     on a project that already exists the platform approves a plain login and
     mints its 7-day token; dropping it and asking for a second approval cost
     a human a click for nothing. */
  if (String(grant.tokenKind || "") !== "provisioning") {
    let stored: { workspaceSlug: string; projectSlug: string; expiresAt?: number } | null = null;
    let storeFailure: string | null = null;

    if (token) {
      try {
        const creds = persistTokenResponse({ apiBase: ctx.apiBase, project: ctx.project, data: grant as Record<string, unknown> });
        stored = { workspaceSlug: creds.workspaceSlug, projectSlug: creds.projectSlug, ...(creds.expiresAt ? { expiresAt: creds.expiresAt } : {}) };
      } catch (err) {
        storeFailure = err instanceof Error ? err.message : String(err);
      }
    }

    return envelope({
      ok: stored !== null,
      command: COMMAND,
      status: stored ? "project-exists-logged-in" : "project-exists",
      ...(stored
        ? {
            value: {
              ...stored,
              ...(stored.expiresAt ? { expiresAtIso: new Date(stored.expiresAt * 1000).toISOString() } : {}),
              stored: true,
            },
          }
        : {
            error: {
              code: "E_PLATFORM",
              message: `Project ${ctx.project} already exists on this host, so there is nothing to create${storeFailure ? `, and the login the platform minted for it could not be stored (${storeFailure})` : ", and the platform minted no login for it"}.`,
            },
          }),
      hint: stored
        ? `Project ${ctx.project} already exists, so nothing was created; the approval minted a login for it instead, which is now stored on this machine (no second approval is needed). Token-scoped tools can use it; extension_auth (action: status) shows it.`
        : `Run extension_auth (action: login) with project '${ctx.project}' to mint its token.`,
    });
  }

  const [owner = "", repoName = ""] = String(ctx.args.repo || "").split("/");
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
    browsers: ctx.args.browsers,
    outputDirectories: ctx.args.outputDirectories,
  });

  const url = `${ctx.apiBase}/api/cli/projects/create`;
  const unconfirmed = (what: string, code: ErrorCode): string =>
    envelope({
      ok: false,
      command: COMMAND,
      status: "create-unconfirmed",
      error: {
        code,
        name: "CreateUnconfirmed",
        message: `${what}, so whether ${ctx.project} now exists is unknown.`,
      },
      value: { project: ctx.project, consoleUrl: consoleBase() },
      hint: `Do not create it again blind: the grant is spent, and a second create racing the first is two builds claiming one name. Look for ${ctx.project} in the console at ${consoleBase()}. If it is there, sign in with extension_auth (action: login, project: '${ctx.project}'); only if it is not, call extension_project_create again.`,
    });
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
    return unconfirmed(
      `The create request for ${ctx.project} left this machine and no answer came back (${err?.message || err})`,
      "E_NETWORK",
    );
  }

  let text: string;

  try {
    text = await res.text();
  } catch (err: any) {
    return unconfirmed(
      `The platform answered ${res.status} for ${ctx.project} and the answer could not be read (${err?.message || err})`,
      "E_NETWORK",
    );
  }

  let data: Record<string, unknown>;

  try {
    data = JSON.parse(text);
  } catch {
    data = { message: text };
  }

  if (!res.ok) {
    const code = String(data.code || "");

    /* @invariant Held first. Every branch under it points somewhere on the
     * platform, and the platform is what has been shut. */
    if (sawPlatformHold(res, data)) {
      return platformHoldEnvelope({
        command: COMMAND,
        name: "CreateHeld",
        body: data,
        value: { workspace: wantWorkspace, project: wantProject },
      });
    }

    if (code === "CLI_PROJECT_CREATE_DISABLED") {
      return fail(
        "CreateClosed",
        String(data.message || "Headless project creation is not open yet."),
        "lane-closed",
        "E_PLATFORM",
        laneClosedHint(),
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
        hint:
          code === "INSTALLATION_AMBIGUOUS"
            ? "The approving account holds more than one installation of the extension.dev GitHub App, so this lane cannot pick one; create the project in the console this once. Nothing was created."
            : connectUrl
              ? `Open ${connectUrl} to connect the extension.dev GitHub App, then start a new extension_project_create call (this device code is spent). Nothing was created.`
              : "Connect the extension.dev GitHub App to the approving account, then start a new extension_project_create call (this device code is spent). Nothing was created.",
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

    if (answerIsUnknownOutcome(res.status, data)) {
      return unconfirmed(
        `The create request for ${ctx.project} got a ${res.status} with no platform code, which is an answer from in front of the platform while the create may still be running`,
        "E_PLATFORM",
      );
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

  const createdAnswer = readCreatedProject(data);

  if (!createdAnswer.ok) {
    return unconfirmed(
      `The platform answered ${res.status} for ${ctx.project} but ${createdAnswer.why}`,
      "E_PLATFORM",
    );
  }

  const finalWorkspace = createdAnswer.workspaceSlug;
  const finalProject = createdAnswer.projectSlug;
  const renamed =
    finalWorkspace.toLowerCase() !== wantWorkspace.toLowerCase() ||
    finalProject.toLowerCase() !== wantProject.toLowerCase();
  const consoleUrl = consoleProjectUrl(
    { workspace: finalWorkspace, project: finalProject },
    "",
  );
  const firstBuild = readFirstBuild(data);
  const buildsPageUrl = consoleProjectUrl(
    { workspace: finalWorkspace, project: finalProject },
    "builds",
  );

  return envelope({
    ok: true,
    command: COMMAND,
    status: "created",
    value: {
      workspaceSlug: finalWorkspace,
      projectSlug: finalProject,
      projectId: createdAnswer.projectId,
      consoleUrl,
      sourceRepo: ctx.args.repo,
      firstBuild: firstBuildValue(firstBuild),
      allowance: spendNarration({
        what:
          firstBuild.state === "dispatched"
            ? "This project creation, including its first build,"
            : firstBuild.state === "withheld"
              ? "This project creation, with no first build dispatched,"
              : "This project creation, and its first build if the platform dispatched one,",
        body: data,
        api: ctx.apiBase,
      }),
      nextSteps: [
        `extension_auth (action: login, project: '${finalWorkspace}/${finalProject}')`,
        ...(firstBuild.state === "dispatched"
          ? ["extension_publish"]
          : [
              `extension_release_status (include: ['releases'], project: '${finalWorkspace}/${finalProject}') until a build is listed, then extension_publish`,
            ]),
      ],
    },
    hint: `Project ${finalWorkspace}/${finalProject} exists. ${firstBuildSentence(firstBuild, buildsPageUrl)} The provisioning grant stays valid until it expires and is not stored by this tool; the only file written on this machine is its install id (install.json). Next: extension_auth (action: login, project: '${finalWorkspace}/${finalProject}') to mint the project token${
      firstBuild.state === "dispatched"
        ? ", then extension_publish to share it."
        : "; extension_publish has nothing to share until a build exists."
    }`,
    warnings: [
      ...(renamed
        ? [
            `The platform registered this project as ${finalWorkspace}/${finalProject}, not the ${ctx.project} that was asked for. Use the name it has.`,
          ]
        : []),
      ...(firstBuild.state === "dispatched"
        ? []
        : [
            firstBuild.state === "withheld"
              ? `No first build was dispatched for ${finalWorkspace}/${finalProject}: ${withheldBecause(firstBuild.reason)}.`
              : `The platform did not say whether a first build was dispatched for ${finalWorkspace}/${finalProject}.`,
          ]),
    ],
  });
}
