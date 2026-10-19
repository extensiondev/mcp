// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { answerDeadline, RESUME_POLL_MS } from "../lib/call-budget";
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
import {
  CREATE_IN_PROGRESS_CODE,
  grantExpiresAt,
  heldCreateGrant,
  heldUntilSentence,
  holdCreateGrant,
  releaseCreateGrant,
  type HeldCreateGrant,
} from "../lib/held-create-grant";
import { createProjectBatch } from "../lib/project-create-batch";
import { buildCreateBody, DEFAULT_BUILD_COMMAND } from "../lib/project-create-body";
import { consoleBase, consoleProjectUrl } from "../lib/registry";
import { laneClosedFacts, laneClosedHint, platformHoldEnvelope, sawPlatformHold } from "../lib/platform-hold";
import { identityHeaders } from "../lib/session-identity";
import { spendNarration } from "../lib/allowance";
import { answerIsUnknownOutcome, readCreatedProject } from "../lib/create-answer";
import { CREATE_CEILING_SENTENCE, CREATE_STUCK_AFTER_SECONDS, creatingAge, creatingForWords } from "../lib/create-ceiling";
import { findProjectByStoredLogin, type ProjectFoundByRead } from "../lib/created-project-read";
import { isProjectRef } from "../lib/credentials";
import {
  firstBuildSentence,
  firstBuildValue,
  readFirstBuild,
  withheldBecause,
} from "../lib/first-build";

const COMMAND = "extension_project_create";

const FIRST_CALL_BUDGET_MS = 8_000;

const CREATE_STUCK_MINUTES = CREATE_STUCK_AFTER_SECONDS / 60;

export const schema = {
  name: "extension_project_create",
  description:
    `Create an extension.dev project for an extension that does not have one yet, without opening the console. Use it right after extension_create and extension_build, once the extension's source is pushed to a GitHub repository, and BEFORE extension_auth: extension_auth can only log in to a project that already exists, and this tool is what brings that project into existence. Ask for nothing but the project slug and the repo; the platform finds the GitHub App installation on the approving account itself, and if there is none it returns a connect link to open. Two-phase, like login: the first call returns a code and a URL where a signed-in member of the workspace approves creating exactly this project; call again with the returned deviceCode to finish. The approval mints a provisioning grant that lives minutes, can only create the one named project, and is kept on this machine only while a create's outcome is unknown: then it sits in a file only this user can read, beside the stored logins, so calling again with the same deviceCode and arguments reads that outcome (created, still creating, or refused) with no second approval. On success the platform creates the project, answers its console page in trackUrl, and dispatches the first build when it can: the answer says in \`firstBuild\` whether one was dispatched and, when none was, why (no commits, no build workflow, a spent build allowance, a paused dispatch). Every build runs the stored build command for each enabled browser exactly as stored, then reads that browser's outputDirectory, so the default command is \`${DEFAULT_BUILD_COMMAND}\` (the browser's name in place of \`<browser>\`) into \`dist/<browser>\`. Then run extension_auth (action: login) against the new project, and extension_publish to share it. To create several projects in one workspace under one approval, pass \`projects\` instead of \`project\` and \`repo\`: the approval page lists every name, each project is created by its own request, and each one's 7-day token is stored as that project's login, so no extension_auth call is needed afterwards. A list takes a few calls to finish: while projects remain the answer is status 'creating' with the same deviceCode to call again, and each call answers within about 45 seconds. Until it expires the list's grant is kept in a file only this user can read, beside the stored logins, so a restarted server resumes the list with no second approval. One approval creates at most ${DEFAULT_CREATE_PROJECTS_PER_APPROVAL} projects, the cap the platform states in its login config, because it creates at most ${PLATFORM_CREATES_PER_HOUR} per hour for one approving account; the next ${DEFAULT_CREATE_PROJECTS_PER_APPROVAL} can start in a new call once that limit allows. A longer list is refused before any approval is asked for, never split silently, and so is any list on a platform that does not advertise batch onboarding.`,
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
        default: DEFAULT_BUILD_COMMAND,
        description:
          "Build command the platform runs for each enabled browser, as it is: the platform does not add --browser to a command stored through this tool (only its import and clone paths derive one), and `extension build` with no flag targets chromium and writes `dist/chromium`, which no browser's outputDirectory reads. The default therefore names the browser; `<browser>` in a command of your own becomes each enabled browser's name.",
      },
      outputDirectory: {
        type: "string",
        default: "dist/chrome",
        description:
          "Directory the build writes the loadable extension into. With more than one browser, `<browser>` in the path becomes each browser's name (Extension.js writes `dist/<browser>` for the browser its --browser flag names; `extension build` with no flag targets chromium and writes `dist/chromium`, so a buildCommand that leaves the flag out never fills `dist/chrome`), and when it is left out every browser defaults to `dist/<browser>`.",
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

function closedLane(name: string, message: string, api: string, workspace: string): string {
  const facts = laneClosedFacts({ api, message });

  return envelope({
    ok: false,
    command: COMMAND,
    status: "lane-closed",
    error: { code: "E_PLATFORM", name, message },
    value: { workspace, ...facts },
    hint: laneClosedHint({ api, message, subject: "project" }),
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

  const callStartedAt = Date.now();
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
  const resumeDeviceCode = String(args.deviceCode || "").trim();
  const held = heldCreateGrant(apiBase, resumeDeviceCode, project);

  if (held) {
    return createWithGrant({
      apiBase,
      project,
      args,
      deviceCode: resumeDeviceCode,
      callStartedAt,
      held,
      resumed: true,
    });
  }

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
  let budgetMs = RESUME_POLL_MS;

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

      if (laneClosed) {
        return closedLane(
          "CreateStartError",
          serverMessage || `Headless project creation is not open on ${apiBase} yet. (${message})`,
          apiBase,
          project.split("/")[0] ?? "",
        );
      }

      return fail("CreateStartError", String(message), "create-failed", "E_PLATFORM");
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
      callStartedAt,
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
    callStartedAt,
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
    callStartedAt: number;
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
        return closedLane("CreateClosed", poll.message || `Headless project creation is not open on ${ctx.apiBase}.`, ctx.apiBase, ctx.project.split("/")[0] ?? "");
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

  return createWithGrant({
    apiBase: ctx.apiBase,
    project: ctx.project,
    args: ctx.args,
    deviceCode: ctx.deviceCode,
    callStartedAt: ctx.callStartedAt,
    held: { grant: token, grantExpiresAt: grantExpiresAt(grant as Record<string, unknown>) },
    resumed: false,
  });
}

type CreateArgs = {
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

async function createWithGrant(ctx: {
  apiBase: string;
  project: string;
  args: CreateArgs;
  deviceCode: string;
  callStartedAt: number;
  held: HeldCreateGrant;
  resumed: boolean;
}): Promise<string> {
  const [wantWorkspace = ""] = ctx.project.split("/");
  const kept =
    ctx.resumed ||
    holdCreateGrant(ctx.apiBase, ctx.deviceCode, { workspace: wantWorkspace, ref: ctx.project }, ctx.held);
  let keepGrant = false;
  const answer = await sendCreate(ctx, kept, () => {
    keepGrant = kept;
  });

  if (!keepGrant) releaseCreateGrant(ctx.apiBase, ctx.deviceCode);

  return answer;
}

async function sendCreate(
  ctx: {
    apiBase: string;
    project: string;
    args: CreateArgs;
    deviceCode: string;
    callStartedAt: number;
    held: HeldCreateGrant;
    resumed: boolean;
  },
  kept: boolean,
  keepGrant: () => void,
): Promise<string> {
  const token = ctx.held.grant;
  const [wantWorkspace = "", wantProject = ""] = ctx.project.split("/");
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

  const unconfirmed = (what: string, code: ErrorCode): string => {
    keepGrant();

    return envelope({
      ok: false,
      command: COMMAND,
      status: "create-unconfirmed",
      error: {
        code,
        name: "CreateUnconfirmed",
        message: `${what}, so whether ${ctx.project} now exists is unknown.`,
      },
      value: {
        project: ctx.project,
        consoleUrl: consoleBase(ctx.apiBase),
        ...(kept ? { deviceCode: ctx.deviceCode } : {}),
      },
      hint: kept
        ? `The platform may still be finishing ${ctx.project}. Call extension_project_create again with this same deviceCode and the same arguments to learn the outcome; that call resumes without a second approval, and a new call would need one. The grant is held on this machine, readable only by this user, until ${heldUntilSentence(ctx.held)}, and with it the platform answers with this create's outcome (created, still creating, or refused) and never creates ${ctx.project} twice. ${CREATE_CEILING_SENTENCE}`
        : `Do not create it again blind: the grant could not be kept on this machine, and a second create racing the first is two builds claiming one name. Look for ${ctx.project} in the console at ${consoleBase(ctx.apiBase)}. If it is there, sign in with extension_auth (action: login, project: '${ctx.project}'); only if it is not, call extension_project_create again.`,
    });
  };

  let res: Response;
  const deadline = answerDeadline(ctx.callStartedAt);

  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        ...identityHeaders(COMMAND),
      },
      body: JSON.stringify(body),
      signal: deadline.signal,
    });
  } catch (err: any) {
    deadline.release();

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
  } finally {
    deadline.release();
  }

  let data: Record<string, unknown>;

  try {
    data = JSON.parse(text);
  } catch {
    data = { message: text };
  }

  if (String(data.code || "") === CREATE_IN_PROGRESS_CODE) {
    const found = await findProjectByStoredLogin({ apiBase: ctx.apiBase, project: ctx.project, command: COMMAND });

    if (found) return createdByRead(found, ctx.args.repo, ctx.apiBase);

    keepGrant();
    const waitSeconds = Number(data.retryAfterSeconds) > 0 ? Number(data.retryAfterSeconds) : 10;
    const age = creatingAge({ apiBase: ctx.apiBase, deviceCode: ctx.deviceCode, kept, data });

    if (age.stuck) {
      const projectUrl = consoleProjectUrl({ workspace: wantWorkspace, project: wantProject }, "", ctx.apiBase);

      return envelope({
        ok: false,
        command: COMMAND,
        status: "create-stuck",
        error: {
          code: "E_CREATE_STUCK",
          name: "CreateStuck",
          message: `The platform has reported ${ctx.project} as still creating for ${creatingForWords(age.seconds)} (since ${age.startedAtIso}), past the ${CREATE_STUCK_MINUTES}-minute ceiling, so this create looks stuck. ${ctx.project} may already exist: the platform took the request and only its outcome is missing.`,
        },
        value: {
          project: ctx.project,
          retryAfterSeconds: waitSeconds,
          creatingForSeconds: age.seconds,
          startedAt: age.startedAtIso,
          consoleUrl: projectUrl,
          ...(kept ? { deviceCode: ctx.deviceCode } : {}),
          nextSteps: [`extension_auth (action: login, project: '${ctx.project}')`, projectUrl],
        },
        hint: `Run extension_auth (action: login, project: '${ctx.project}'): it succeeds when the project exists, and then the project is ready. Or open ${projectUrl} to see whether it is there. To keep waiting instead, call extension_project_create again with this same deviceCode in about ${waitSeconds} s${kept ? `; the grant stays held until ${heldUntilSentence(ctx.held)}` : ""}.`,
      });
    }

    return envelope({
      ok: true,
      command: COMMAND,
      status: "creating",
      value: {
        project: ctx.project,
        retryAfterSeconds: waitSeconds,
        creatingForSeconds: age.seconds,
        startedAt: age.startedAtIso,
        ...(kept ? { deviceCode: ctx.deviceCode } : {}),
      },
      hint: kept
        ? `The platform has been creating ${ctx.project} for ${creatingForWords(age.seconds)} (since ${age.startedAtIso}) from the earlier request with this grant, and started nothing new. Call extension_project_create again with this same deviceCode and the same arguments in about ${waitSeconds} s to read the outcome; no new approval is needed while the grant lasts (until ${heldUntilSentence(ctx.held)}).`
        : `The platform is still creating ${ctx.project} from an earlier request with this grant, and started nothing new. The grant could not be kept on this machine, so look for ${ctx.project} in the console at ${consoleBase(ctx.apiBase)} in a minute.`,
    });
  }

  if (!res.ok) {
    const code = String(data.code || "");

    if (sawPlatformHold(res, data)) {
      return platformHoldEnvelope({
        command: COMMAND,
        name: "CreateHeld",
        body: data,
        api: ctx.apiBase,
        value: { workspace: wantWorkspace, project: wantProject },
      });
    }

    if (code === "CLI_PROJECT_CREATE_DISABLED") {
      return closedLane(
        "CreateClosed",
        String(data.message || `Headless project creation is not open on ${ctx.apiBase} yet.`),
        ctx.apiBase,
        wantWorkspace,
      );
    }

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
    ctx.apiBase,
  );
  const firstBuild = readFirstBuild(data);
  const buildsPageUrl = consoleProjectUrl(
    { workspace: finalWorkspace, project: finalProject },
    "builds",
    ctx.apiBase,
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
    hint: `Project ${finalWorkspace}/${finalProject} exists.${data.replayed === true ? " The platform read this back from its record of the earlier create request with this grant; nothing was created twice." : ""} ${firstBuildSentence(firstBuild, buildsPageUrl)} The provisioning grant stays valid until it expires and is no longer kept on this machine; the only other file this tool leaves is its install id (install.json). Next: extension_auth (action: login, project: '${finalWorkspace}/${finalProject}') to mint the project token${
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

function createdByRead(found: ProjectFoundByRead, repo: string | undefined, apiBase: string): string {
  const ref = `${found.workspaceSlug}/${found.projectSlug}`;
  const consoleUrl = consoleProjectUrl({ workspace: found.workspaceSlug, project: found.projectSlug }, "", apiBase);

  return envelope({
    ok: true,
    command: COMMAND,
    status: "created",
    value: {
      workspaceSlug: found.workspaceSlug,
      projectSlug: found.projectSlug,
      projectId: found.projectId,
      consoleUrl,
      sourceRepo: repo,
      confirmedBy: "project-read",
      firstBuild: firstBuildValue({ state: "unsaid" }),
      nextSteps: [
        `extension_auth (action: login, project: '${ref}')`,
        `extension_release_status (include: ['releases'], project: '${ref}') until a build is listed, then extension_publish`,
      ],
    },
    hint: `Project ${ref} exists: the platform still answers this grant's request as creating, but a read with the stored login for ${found.readWith} finds the project, so the create landed and nothing was sent again. The provisioning grant is no longer kept on this machine. Next: extension_auth (action: login, project: '${ref}') to mint the project token.`,
    warnings: [`The platform did not say whether a first build was dispatched for ${ref}; its Builds page in the console shows it.`],
  });
}
