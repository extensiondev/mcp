// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import path from "node:path";

import { wwwImportPath } from "@extension.dev/urls/paths";

import { linksOf, madeSentence, recordedOutcome } from "../lib/act-outcome";
import { createRequestDeadline, readBackOnce, RESUME_POLL_MS } from "../lib/call-budget";
import { API_BASE } from "../lib/common-schema";
import { pollDeviceGrant, type DeviceCodeStart } from "../lib/device-flow";
import { laneClosedByServer } from "../lib/credential-source";
import { envelope, type ErrorCode } from "../lib/envelope";
import { fetchLoginConfig, resolveApiBase, safeApiBase } from "../lib/login-flow";
import {
  DEFAULT_CREATE_PROJECTS_PER_APPROVAL,
  MAX_BATCH_PROJECTS,
  PLATFORM_CREATES_PER_HOUR,
} from "../lib/project-batch";
import {
  CREATE_IN_PROGRESS_CODE,
  grantExpiresAt,
  heldUntilSentence,
  type HeldCreateGrant,
} from "../lib/held-create-grant-words";
import { createProjectBatch, type BatchCreateLocal } from "../lib/project-create-batch";
import { buildCreateBody, DEFAULT_BUILD_COMMAND, type CreateBodySource } from "../lib/project-create-body";
import {
  projectCreateUrl,
  SOURCE_UPLOAD_CONSUMED_CODE,
  uploadProjectSource,
  type SourceUploadOutcome,
} from "../lib/project-source-upload";
import { megabytes, SOURCE_SKIPPED_EXTENSIONS, SOURCE_SKIPPED_FOLDERS } from "../lib/source-archive-words";
import { consoleBase, consoleProjectUrl } from "../lib/registry";
import { mcpOrigins } from "../lib/origins";
import { laneClosedFacts, laneClosedHint, platformHoldEnvelope, sawPlatformHold, type CreatePrefill } from "../lib/platform-hold";
import { firstBuildSpendNarration, type BuildAllowance } from "../lib/build-allowance";
import { answerIsUnknownOutcome, readCreatedProject } from "../lib/create-answer";
import { CREATE_CEILING_SENTENCE, CREATE_STUCK_AFTER_SECONDS, creatingAgeAt, creatingForWords } from "../lib/create-ceiling-words";
import { isProjectRef, type StoredCredentials } from "../lib/credentials";
import { wantsCreateLogin, type CreateLogin, type CreateLoginRead } from "../lib/create-login";
import {
  codeExpiresAt,
  codeExpiryFromStart,
  deviceWait,
  deviceWaitDescription,
  DEVICE_WAIT_MAX_SECONDS,
  expiredSentence,
  firstCallWaitWarning,
  forgetCodeExpiry,
  rememberCodeExpiry,
  resumeWaitSentence,
  waitRanOutSentence,
  waitValue,
  type DeviceWait,
} from "../lib/device-wait";
import {
  firstBuildSentence,
  firstBuildValue,
  readFirstBuild,
  reseedBuildSentence,
  withheldBecause,
} from "../lib/first-build";
import { PROJECT_CREATE_LOCAL } from "./project-create-local";

import type { SourceArchive } from "../lib/source-archive";
import type { ProjectFoundByRead } from "../lib/created-project-read";
import type { PendingCreate } from "../lib/pending-creates";

export type UploadSourceRead =
  | { kind: "not-folder" }
  | { kind: "no-manifest" }
  | { kind: "archive"; archive: SourceArchive };

export interface ProjectCreateLocal extends BatchCreateLocal {
  cwd(): string;
  uploadRoot(projectPath: string): string;
  readUploadSource(root: string): UploadSourceRead;
  pendingCreate(apiBase: string, project: string): PendingCreate | null;
  rememberPendingCreate(apiBase: string, project: string, record: PendingCreate): boolean;
  forgetPendingCreate(apiBase: string, project: string): void;
  heldCreateGrant(apiBase: string, deviceCode: string, ref: string): HeldCreateGrant | null;
  holdCreateGrant(apiBase: string, deviceCode: string, target: { workspace: string; ref: string }, held: HeldCreateGrant): boolean;
  releaseCreateGrant(apiBase: string, deviceCode: string): void;
  firstSeenCreating(apiBase: string, deviceCode: string, now: number, kept: boolean): number;
  rememberCreatedProject(apiBase: string, project: string): boolean;
  persistTokenResponse(args: { apiBase: string; project: string; data: Record<string, unknown> }): StoredCredentials;
  findProjectByStoredLogin(args: { apiBase: string; project: string; command: string }): Promise<ProjectFoundByRead | null>;
  readWorkspaceBuildAllowance(args: { apiBase: string; workspace: string; command: string }): Promise<BuildAllowance | null>;
  readCreateLogin(args: { data: Record<string, unknown>; apiBase: string; project: string; login: boolean }): CreateLoginRead;
}

const COMMAND = "extension_project_create";

const FIRST_CALL_BUDGET_MS = 8_000;

const CREATE_STUCK_MINUTES = CREATE_STUCK_AFTER_SECONDS / 60;

export const schema = {
  name: "extension_project_create",
  description:
    `Create an extension.dev project from a folder (projectPath, uploaded, no push; again: re-seed and rebuild) or a GitHub repo, BEFORE extension_auth. First call: a URL a signed-in workspace member approves; resume with deviceCode and waitSeconds, the login is stored too. The first build spends one build of the workspace's monthly allowance, build command exactly as stored. projects: up to ${DEFAULT_CREATE_PROJECTS_PER_APPROVAL} per approval, at most ${PLATFORM_CREATES_PER_HOUR} per hour, never split silently.`,
  inputSchema: {
    type: "object" as const,
    properties: {
      project: {
        type: "string",
        description: "New '<workspace>/<project>'.",
      },
      projectPath: {
        type: "string",
        description: `Folder holding manifest.json, uploaded as it is (absolute or relative to the server cwd; default: the cwd when it holds manifest.json or extension.config.*). ${SOURCE_SKIPPED_FOLDERS.join(", ")}, ${SOURCE_SKIPPED_EXTENSIONS.join(", ")}, .env*, *.pem and .gitignore entries stay out; 4 MB zipped at most. On a project whose source was uploaded, this re-seeds it from the new archive and rebuilds it (no token comes back); extension_builds rebuild rebuilds its stored tree without a new upload.`,
      },
      repo: {
        type: "string",
        description: "GitHub '<owner>/<repo>' the source is pushed to; instead of projectPath.",
      },
      installationId: {
        type: "string",
        description: "Omit; the platform finds it or answers a connect link.",
      },
      displayName: {
        type: "string",
        description: "Human name; rename later with extension_workspace configure-project.",
      },
      description: {
        type: "string",
        description: "Short description.",
      },
      installCommand: {
        type: "string",
        default: "npm install",
        description: "Install command.",
      },
      buildCommand: {
        type: "string",
        default: DEFAULT_BUILD_COMMAND,
        description: "Run as it is per browser (does not add --browser); `<browser>` substituted.",
      },
      outputDirectory: {
        type: "string",
        default: "dist/chrome",
        description: "Build output; `<browser>` substituted.",
      },
      browsers: {
        type: "array",
        items: { type: "string", enum: ["chrome", "edge", "firefox"] },
        default: ["chrome"],
        description: "Browsers to build.",
      },
      outputDirectories: {
        type: "object",
        description: "Per-browser outputDirectory overrides.",
      },
      projects: {
        type: "array",
        items: { type: "object" },
        description: `Instead of project and repo: 1 to ${DEFAULT_CREATE_PROJECTS_PER_APPROVAL} (max ${MAX_BATCH_PROJECTS}) { project, repo } of one workspace.`,
      },
      deviceCode: {
        type: "string",
        description: "Resume token; reuse re-reads the outcome.",
      },
      waitSeconds: {
        type: "number",
        minimum: 0,
        maximum: DEVICE_WAIT_MAX_SECONDS,
        description: deviceWaitDescription(),
      },
      login: {
        type: "boolean",
        default: true,
        description: "Store the minted login.",
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

function closedLane(name: string, message: string, api: string, prefill: CreatePrefill): string {
  const workspace = prefill.project.split("/")[0] ?? "";
  const facts = laneClosedFacts({ api, message, prefill });

  return envelope({
    ok: false,
    command: COMMAND,
    status: "lane-closed",
    error: { code: "E_PLATFORM", name, message },
    value: { workspace, ...facts },
    hint: laneClosedHint({ api, message, subject: "project", prefill }),
  });
}

type CreateSource =
  | { kind: "github"; repo: string }
  | { kind: "upload"; root: string; defaulted: boolean; zip: Buffer; bytes: number; files: number; leftOut: { secrets: string[] } };

function sourceRequired(apiBase: string, local: ProjectCreateLocal): string {
  const cwd = local.cwd();

  return envelope({
    ok: false,
    command: COMMAND,
    status: "bad-request",
    error: {
      code: "E_BAD_REQUEST",
      name: "BadRequest",
      message: `Name the source: projectPath, the folder holding the extension's manifest.json (uploaded as it is, no push needed), or repo '<owner>/<repo>', a GitHub repository the source is pushed to. Neither was given and the server's cwd (${cwd}) holds no manifest.json or extension.config.*.`,
    },
    value: { needs: "source", createUrl: `${mcpOrigins(apiBase).www}${wwwImportPath()}` },
    hint: `Call extension_project_create again with projectPath, the folder extension_create answered as projectPath (absolute, or relative to ${cwd}); the platform builds the upload on its own lane and nothing has to be pushed. A GitHub repository the approving account can read works too, with repo '<owner>/<repo>'; the console's create form at ${mcpOrigins(apiBase).www}${wwwImportPath()} takes a repository only.`,
  });
}

function prepareUpload(root: string, defaulted: boolean, local: ProjectCreateLocal): { ok: true; source: CreateSource } | { ok: false; answer: string } {
  const read = local.readUploadSource(root);

  if (read.kind === "not-folder") {
    return {
      ok: false,
      answer: fail(
        "BadRequest",
        `projectPath ${root} is not a folder on this machine, so there is nothing to upload. Pass the folder extension_create made (absolute, or relative to the server's cwd ${local.cwd()}), or repo '<owner>/<repo>'.`,
        "bad-request",
        "E_BAD_REQUEST",
      ),
    };
  }

  if (read.kind === "no-manifest") {
    return {
      ok: false,
      answer: fail(
        "BadRequest",
        `${root} holds no manifest.json (neither ${path.join(root, "manifest.json")} nor ${path.join(root, "src", "manifest.json")} exists), so it is not an extension's source folder and nothing was uploaded. Pass projectPath as the folder extension_create made, or repo '<owner>/<repo>'.`,
        "bad-request",
        "E_BAD_REQUEST",
      ),
    };
  }

  const archive = read.archive;

  if (!archive.ok) {
    if (archive.reason === "unreadable") {
      return {
        ok: false,
        answer: fail("SourceReadError", `The folder ${root} could not be read for upload (${archive.message}), so nothing was sent.`, "bad-request", "E_BAD_REQUEST"),
      };
    }

    const named = archive.biggest.map((entry) => `${entry.path} (${megabytes(entry.bytes)})`).join(", ");

    return {
      ok: false,
      answer: envelope({
        ok: false,
        command: COMMAND,
        status: "source-too-large",
        error: {
          code: "E_BAD_REQUEST",
          name: "SourceTooLarge",
          message: `The source at ${root} zips to ${archive.atLeast ? "more than " : ""}${megabytes(archive.bytes)}, over the ${megabytes(archive.maxBytes)} the platform takes in one upload, so nothing was sent. The biggest entries are ${named}.`,
        },
        value: { projectPath: root, bytes: archive.bytes, maxBytes: archive.maxBytes, files: archive.files, biggest: archive.biggest },
        hint: `Leave those out (add them to .gitignore or move them out of the folder; ${SOURCE_SKIPPED_FOLDERS.join(", ")} and ${SOURCE_SKIPPED_EXTENSIONS.join(", ")} files are already left out), then call extension_project_create again. Or push the folder to a GitHub repository and pass repo '<owner>/<repo>' instead.`,
      }),
    };
  }

  return { ok: true, source: { kind: "upload", root, defaulted, zip: archive.zip, bytes: archive.bytes, files: archive.files, leftOut: archive.leftOut } };
}

/* @invariant THE CODE'S DEADLINE IS PART OF THE ASK. The device code lives
 * fifteen minutes from the first call and the grant it carries dies with it,
 * so an approval given in the last minute reads as expired on the next
 * resume. On 2026-10-21 the person approved sixteen minutes in and the create
 * answered E_AUTH_EXPIRED with no project; nothing had told either side when
 * the code would die. Every pending answer names the deadline and says to
 * resume right after approving.
 */
function deadlineSentence(expiresAt: string): string {
  return `The code expires at ${expiresAt.slice(11, 16)} UTC and the approval dies with it. ${resumeWaitSentence("extension_project_create", expiresAt, " and the same arguments")}`;
}

function pendingEnvelope(start: {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  expiresIn: number;
}, pendingFor: { apiBase: string; project: string }, waitSeconds: unknown, local: ProjectCreateLocal): string {
  const complete = String(start.verificationUriComplete || "").trim();
  const hasCompleteLink =
    complete.length > 0 && complete !== start.verificationUri;
  const expiresAt = codeExpiryFromStart(start.expiresIn);
  rememberCodeExpiry(start.deviceCode, expiresAt);
  local.rememberPendingCreate(pendingFor.apiBase, pendingFor.project, {
    userCode: start.userCode,
    verificationUri: start.verificationUri,
    ...(hasCompleteLink ? { verificationUriComplete: complete } : {}),
    expiresAt,
  });

  const message = hasCompleteLink
    ? `Open ${complete} and approve creating the project (code ${start.userCode} is pre-filled). If the page asks for a code, enter ${start.userCode} at ${start.verificationUri}. ${deadlineSentence(expiresAt)}`
    : `Open ${start.verificationUri}, enter code ${start.userCode} and approve creating the project. ${deadlineSentence(expiresAt)}`;
  const asked = deviceWait({ waitSeconds, fallbackMs: 0 });

  return envelope({
    ok: true,
    command: COMMAND,
    status: "authorization-pending",
    value: {
      userCode: start.userCode,
      verificationUri: start.verificationUri,
      ...(hasCompleteLink ? { verificationUriComplete: complete } : {}),
      deviceCode: start.deviceCode,
      expiresAt,
      expiresInSeconds: start.expiresIn,
    },
    hint: message,
    ...(asked.waiting ? { warnings: [firstCallWaitWarning("extension_project_create", asked.bound)] } : {}),
  });
}

export type ProjectCreateArgs = {
  project?: string;
  repo?: string;
  projectPath?: string;
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
  waitSeconds?: unknown;
  login?: unknown;
  api?: string;
};

export async function handler(args: ProjectCreateArgs): Promise<string> {
  return createProject(args, PROJECT_CREATE_LOCAL);
}

export async function createProject(args: ProjectCreateArgs, local: ProjectCreateLocal): Promise<string> {
  if (args.projects !== undefined && args.projects !== null) {
    return createProjectBatch(args, local);
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
  const repo = String(args.repo || "").trim();
  const projectPathArg = String(args.projectPath || "").trim();

  if (repo && projectPathArg) {
    return fail(
      "BadRequest",
      "Pass repo or projectPath, not both: projectPath uploads the folder as it is, repo names a GitHub repository the platform reads instead.",
      "bad-request",
      "E_BAD_REQUEST",
    );
  }

  if (repo && !isProjectRef(repo)) {
    return fail(
      "BadRequest",
      "repo must be in the form '<owner>/<repo>', a GitHub repository the extension's source is pushed to; or pass projectPath to upload the folder instead.",
      "bad-request",
      "E_BAD_REQUEST",
    );
  }

  let source: CreateSource | null = repo ? { kind: "github", repo } : null;

  if (!source) {
    const root = local.uploadRoot(projectPathArg);

    if (root) {
      const upload = prepareUpload(root, !projectPathArg, local);
      if (!upload.ok) return upload.answer;

      source = upload.source;
    }
  }

  const refusal = source ? null : sourceRequired(apiBase, local);
  const resumeDeviceCode = String(args.deviceCode || "").trim();
  const held = local.heldCreateGrant(apiBase, resumeDeviceCode, project);

  if (held) {
    if (refusal || !source) return refusal ?? sourceRequired(apiBase, local);

    return createWithGrant({
      apiBase,
      project,
      args,
      source,
      deviceCode: resumeDeviceCode,
      callStartedAt,
      held,
      resumed: true,
      callBlocks: deviceWait({ waitSeconds: args.waitSeconds, fallbackMs: RESUME_POLL_MS }).waiting,
    }, local);
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
  const expiresAt = deviceCode
    ? (local.pendingCreate(apiBase, project)?.expiresAt ?? codeExpiresAt(deviceCode))
    : null;
  const wait = deviceWait({ waitSeconds: args.waitSeconds, expiresAt, fallbackMs: RESUME_POLL_MS });
  budgetMs = wait.budgetMs;

  if (!deviceCode) {
    let start: DeviceCodeStart;

    try {
      start = await local.requestDeviceCode({
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
          { project, repo: args.repo },
        );
      }

      return fail("CreateStartError", String(message), "create-failed", "E_PLATFORM");
    }

    if (refusal || !source) return refusal ?? sourceRequired(apiBase, local);

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
      return pendingEnvelope(start, { apiBase, project }, args.waitSeconds, local);
    }

    return finishFromPoll(early, {
      apiBase,
      project,
      args,
      source,
      verificationUri: config.verificationUri,
      deviceCode,
      callStartedAt,
      wait: deviceWait({ waitSeconds: undefined, fallbackMs: FIRST_CALL_BUDGET_MS }),
      expiresAt: codeExpiryFromStart(start.expiresIn),
    }, local);
  }

  if (refusal || !source) return refusal ?? sourceRequired(apiBase, local);

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
    source,
    verificationUri: config.verificationUri,
    deviceCode,
    callStartedAt,
    wait,
    expiresAt,
  }, local);
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
      login?: unknown;
    };
    source: CreateSource;
    verificationUri: string;
    deviceCode: string;
    callStartedAt: number;
    wait: DeviceWait;
    expiresAt: string | null;
  },
  local: ProjectCreateLocal,
): Promise<string> {
  if (poll.ok || poll.reason !== "pending") {
    local.forgetPendingCreate(ctx.apiBase, ctx.project);
    forgetCodeExpiry(ctx.deviceCode);
  }

  if (!poll.ok) {
    if (poll.reason === "pending") {
      const ranOut = waitRanOutSentence({ tool: "extension_project_create", wait: ctx.wait, expiresAt: ctx.expiresAt, extra: " and the same arguments" });

      return envelope({
        ok: true,
        command: COMMAND,
        status: "authorization-pending",
        value: {
          verificationUri: ctx.verificationUri,
          deviceCode: ctx.deviceCode,
          ...waitValue(ctx.wait, ctx.expiresAt),
        },
        hint: ctx.wait.waiting
          ? `${ranOut} The approval page is still ${ctx.verificationUri}.`
          : `Still waiting for approval at ${ctx.verificationUri}; the code lives fifteen minutes from the first call and the approval dies with it. ${resumeWaitSentence("extension_project_create", ctx.expiresAt, " and the same arguments")}`,
      });
    }

    if (poll.reason === "denied") {
      if (poll.code === "CLI_PROJECT_CREATE_DISABLED") {
        return closedLane("CreateClosed", poll.message || `Headless project creation is not open on ${ctx.apiBase}.`, ctx.apiBase, { project: ctx.project, repo: ctx.args.repo });
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
        expiredSentence(
          "extension_project_create",
          `${poll.message || "The device code has expired or is unknown."} The code lives fifteen minutes from the first call and an approval given after that is dropped, so no project was created.`,
          " (without the old deviceCode) and the same arguments",
        ),
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
        const creds = local.persistTokenResponse({ apiBase: ctx.apiBase, project: ctx.project, data: grant as Record<string, unknown> });
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
    source: ctx.source,
    deviceCode: ctx.deviceCode,
    callStartedAt: ctx.callStartedAt,
    held: { grant: token, grantExpiresAt: grantExpiresAt(grant as Record<string, unknown>) },
    resumed: false,
    callBlocks: ctx.wait.waiting,
  }, local);
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
  login?: unknown;
};

async function createWithGrant(ctx: {
  apiBase: string;
  project: string;
  args: CreateArgs;
  source: CreateSource;
  deviceCode: string;
  callStartedAt: number;
  held: HeldCreateGrant;
  resumed: boolean;
  callBlocks: boolean;
}, local: ProjectCreateLocal): Promise<string> {
  const [wantWorkspace = ""] = ctx.project.split("/");
  const kept =
    ctx.resumed ||
    local.holdCreateGrant(ctx.apiBase, ctx.deviceCode, { workspace: wantWorkspace, ref: ctx.project }, ctx.held);
  let keepGrant = false;
  const answer = await sendCreate(ctx, kept, () => {
    keepGrant = kept;
  }, local);

  if (!keepGrant) local.releaseCreateGrant(ctx.apiBase, ctx.deviceCode);

  return answer;
}

async function sendCreate(
  ctx: {
    apiBase: string;
    project: string;
    args: CreateArgs;
    source: CreateSource;
    deviceCode: string;
    callStartedAt: number;
    held: HeldCreateGrant;
    resumed: boolean;
    callBlocks: boolean;
  },
  kept: boolean,
  keepGrant: () => void,
  local: ProjectCreateLocal,
): Promise<string> {
  const token = ctx.held.grant;
  const [wantWorkspace = "", wantProject = ""] = ctx.project.split("/");
  const url = projectCreateUrl(ctx.apiBase);

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

  const allowanceBefore = await local.readWorkspaceBuildAllowance({ apiBase: ctx.apiBase, workspace: wantWorkspace, command: COMMAND });
  let bodySource: CreateBodySource;
  let uploaded: { bytes: number; files: number } | null = null;

  if (ctx.source.kind === "github") {
    const [owner = "", repoName = ""] = ctx.source.repo.split("/");
    bodySource = { kind: "github", owner, repoName, installationId: ctx.args.installationId };
  } else {
    const upload = await uploadProjectSource({ apiBase: ctx.apiBase, token, zip: ctx.source.zip, identity: local.identityHeaders(COMMAND) });

    if (!upload.ok) {
      return uploadFailed(upload, { ...ctx, wantWorkspace, wantProject, kept, keepGrant });
    }

    uploaded = { bytes: upload.receipt.bytes || ctx.source.bytes, files: upload.receipt.files || ctx.source.files };
    bodySource = { kind: "upload", uploadId: upload.receipt.uploadId };
  }

  const body = buildCreateBody({
    workspace: wantWorkspace,
    projectSlug: wantProject,
    source: bodySource,
    displayName: ctx.args.displayName,
    description: ctx.args.description,
    installCommand: ctx.args.installCommand,
    buildCommand: ctx.args.buildCommand,
    outputDirectory: ctx.args.outputDirectory,
    browsers: ctx.args.browsers,
    outputDirectories: ctx.args.outputDirectories,
  });
  let res: Response;
  const deadline = createRequestDeadline(ctx.callStartedAt, ctx.callBlocks);
  const send = (signal: AbortSignal) =>
    fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...local.identityHeaders(COMMAND) },
      body: JSON.stringify(body),
      signal,
    });

  try {
    res = await send(deadline.signal);
  } catch (err: any) {
    deadline.release();
    const readBack = ctx.callBlocks ? await readBackOnce(send) : null;

    if (!readBack) {
      return unconfirmed(
        `The create request for ${ctx.project} left this machine and no answer came back (${err?.message || err})`,
        "E_NETWORK",
      );
    }

    res = readBack;
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

  if (String(data.code || "") === SOURCE_UPLOAD_CONSUMED_CODE) {
    const found = await local.findProjectByStoredLogin({ apiBase: ctx.apiBase, project: ctx.project, command: COMMAND });

    if (found) return createdByRead(found, ctx.source, ctx.apiBase, local);

    return unconfirmed(
      `The platform answered that the uploaded source was already consumed by an earlier create request with this grant (${String(data.message || SOURCE_UPLOAD_CONSUMED_CODE)}), so that create landed or is still running`,
      "E_PLATFORM",
    );
  }

  if (String(data.code || "") === CREATE_IN_PROGRESS_CODE) {
    const found = await local.findProjectByStoredLogin({ apiBase: ctx.apiBase, project: ctx.project, command: COMMAND });

    if (found) return createdByRead(found, ctx.source, ctx.apiBase, local);

    keepGrant();
    const waitSeconds = Number(data.retryAfterSeconds) > 0 ? Number(data.retryAfterSeconds) : 10;
    const now = Date.now();
    const age = creatingAgeAt(data, now, local.firstSeenCreating(ctx.apiBase, ctx.deviceCode, now, kept));

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
        { project: ctx.project, repo: ctx.args.repo },
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
      local.rememberCreatedProject(ctx.apiBase, ctx.project);

      return envelope({
        ok: false,
        command: COMMAND,
        status: "project-exists",
        error: {
          code: "E_PLATFORM",
          message: String(data.message || `Project ${ctx.project} already exists.`),
        },
        hint:
          ctx.source.kind === "upload"
            ? `Project ${ctx.project} exists and was not re-seeded from this upload: the platform re-seeds from a new archive only a project whose source was uploaded. Run extension_auth (action: login) with project '${ctx.project}'; extension_builds (action: rebuild, project: '${ctx.project}') builds it again from the source it holds.`
            : `Run extension_auth (action: login) with project '${ctx.project}'. extension_builds (action: rebuild, project: '${ctx.project}') builds its head again without a push.`,
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
  const reseeded = data.reseeded === true;
  const fileCounts = data.files && typeof data.files === "object" && !Array.isArray(data.files) ? (data.files as Record<string, unknown>) : {};
  const reseedFiles = { written: Number(fileCounts.written) || 0, removed: Number(fileCounts.removed) || 0 };
  const buildWord = reseeded ? "build" : "first build";
  local.rememberCreatedProject(ctx.apiBase, `${finalWorkspace}/${finalProject}`);
  const buildsPageUrl = consoleProjectUrl(
    { workspace: finalWorkspace, project: finalProject },
    "builds",
    ctx.apiBase,
  );
  const links = linksOf([
    { kind: "project", url: consoleUrl, made: !reseeded },
    ...(firstBuild.state === "dispatched" ? [{ kind: "build" as const, url: firstBuild.buildUrl || buildsPageUrl, made: reseeded }] : []),
  ]);
  const login = local.readCreateLogin({
    data,
    apiBase: ctx.apiBase,
    project: `${finalWorkspace}/${finalProject}`,
    login: wantsCreateLogin(ctx.args.login),
  });
  const ref = `${finalWorkspace}/${finalProject}`;
  const signedIn = login.login.stored || login.login.held === true;
  const followBuild = reseeded
    ? firstBuild.state === "dispatched"
      ? "follows the build of the new archive"
      : "names the build the project has"
    : "follows the first build of the upload";
  const buildStep =
    ctx.source.kind === "upload"
      ? `extension_builds (action: list, project: '${ref}') to follow the ${buildWord}, then extension_publish`
      : firstBuild.state === "dispatched"
        ? "extension_publish"
        : `extension_release_status (include: ['releases'], project: '${ref}') until a build is listed, then extension_publish`;
  const buildNext =
    ctx.source.kind === "upload"
      ? `extension_builds (action: list, project: '${ref}') ${followBuild}; extension_publish shares it once it is listed.`
      : firstBuild.state === "dispatched"
        ? "extension_publish to share it."
        : "extension_release_status until a build is listed; extension_publish has nothing to share until a build exists.";
  const uploadWords = ctx.source.kind === "upload" ? `the upload of ${ctx.source.root} (${uploaded?.files ?? ctx.source.files} files, ${megabytes(uploaded?.bytes ?? ctx.source.bytes)} zipped), nothing was pushed` : "";
  const opening = reseeded
    ? `Project ${ref} was re-seeded from ${uploadWords}: the platform wrote ${reseedFiles.written} files and removed ${reseedFiles.removed} the new archive no longer holds, and created nothing, since the project already existed.`
    : `Project ${ref} exists${uploadWords ? `, created from ${uploadWords}` : ""}.${data.replayed === true ? " The platform read this back from its record of the earlier create request with this grant; nothing was created twice." : ""}`;
  const act = reseeded ? "This re-seed" : "This project creation";

  return envelope({
    ok: true,
    command: COMMAND,
    status: reseeded ? "reseeded" : "created",
    value: {
      workspaceSlug: finalWorkspace,
      projectSlug: finalProject,
      projectId: createdAnswer.projectId,
      consoleUrl,
      source: ctx.source.kind,
      ...(ctx.source.kind === "github"
        ? { sourceRepo: ctx.source.repo }
        : { projectPath: ctx.source.root, uploaded: uploaded ?? { bytes: ctx.source.bytes, files: ctx.source.files }, leftOut: ctx.source.leftOut }),
      ...(reseeded ? { reseeded: true, files: reseedFiles } : {}),
      outcome: recordedOutcome(reseeded ? "reseeded" : data.replayed === true ? "created-earlier" : "created"),
      links,
      login: login.login,
      firstBuild: { ...firstBuildValue(firstBuild), ...(firstBuild.state === "dispatched" ? { spent: 1 } : {}) },
      allowance: firstBuildSpendNarration({
        what:
          firstBuild.state === "dispatched"
            ? `${act}, including its ${buildWord},`
            : firstBuild.state === "withheld"
              ? `${act}, with no ${buildWord} dispatched,`
              : `${act}, and its ${buildWord} if the platform dispatched one,`,
        body: data,
        api: ctx.apiBase,
        dispatched: firstBuild.state === "dispatched",
        before: allowanceBefore,
      }),
      nextSteps: [
        ...(signedIn ? [] : [`extension_auth (action: login, project: '${ref}')`]),
        buildStep,
      ],
    },
    hint: `${opening} ${reseeded ? reseedBuildSentence(firstBuild, ref, buildsPageUrl) : firstBuildSentence(firstBuild, buildsPageUrl)} ${login.sentence} The provisioning grant is spent and not kept on this machine; the other files this tool leaves are its install id (install.json) and a note that ${ref} exists on this server (created-projects.json), so extension_auth does not doubt it. Next: ${
      signedIn ? "" : `extension_auth (action: login, project: '${ref}') to mint the project token, then `
    }${buildNext} ${madeSentence(links)}`,
    warnings: [
      ...(ctx.source.kind === "upload" && ctx.source.defaulted
        ? [`projectPath was not given, so the server's cwd ${ctx.source.root} was uploaded because it holds the extension's manifest.`]
        : []),
      ...(renamed
        ? [
            `The platform registered this project as ${finalWorkspace}/${finalProject}, not the ${ctx.project} that was asked for. Use the name it has.`,
          ]
        : []),
      ...(firstBuild.state === "dispatched" || (reseeded && firstBuild.state === "withheld" && firstBuild.reason === "already_dispatched")
        ? []
        : [
            firstBuild.state === "withheld"
              ? `No ${buildWord} was dispatched for ${finalWorkspace}/${finalProject}: ${withheldBecause(firstBuild.reason)}.`
              : `The platform did not say whether a ${buildWord} was dispatched for ${finalWorkspace}/${finalProject}.`,
          ]),
    ],
  });
}

function uploadFailed(
  upload: Exclude<SourceUploadOutcome, { ok: true }>,
  ctx: {
    apiBase: string;
    project: string;
    deviceCode: string;
    held: HeldCreateGrant;
    wantWorkspace: string;
    wantProject: string;
    kept: boolean;
    keepGrant: () => void;
  },
): string {
  if (upload.kind === "refused") {
    if (sawPlatformHold(upload.res, upload.body)) {
      return platformHoldEnvelope({
        command: COMMAND,
        name: "CreateHeld",
        body: upload.body,
        api: ctx.apiBase,
        value: { workspace: ctx.wantWorkspace, project: ctx.wantProject },
      });
    }

    if (upload.code === "CLI_PROJECT_CREATE_DISABLED") {
      return closedLane("CreateClosed", upload.message, ctx.apiBase, { project: ctx.project });
    }
  }

  ctx.keepGrant();
  const resume = ctx.kept
    ? `then call extension_project_create again with this same deviceCode and the same arguments; the grant stays held on this machine until ${heldUntilSentence(ctx.held)}, so no second approval is needed`
    : "then call extension_project_create again; the grant could not be kept on this machine, so that call asks for a new approval";

  if (upload.kind === "refused") {
    const fixable = upload.status === 400 || upload.status === 413;

    return envelope({
      ok: false,
      command: COMMAND,
      status: fixable ? "source-refused" : "create-failed",
      error: {
        code: fixable ? "E_BAD_REQUEST" : "E_PLATFORM",
        name: fixable ? "SourceRefused" : "SourceUploadError",
        message: `The platform refused the source upload for ${ctx.project} (${upload.status}${upload.code ? ` ${upload.code}` : ""}): ${upload.message} Nothing was created.`,
      },
      value: { project: ctx.project, status: upload.status, ...(upload.code ? { code: upload.code } : {}), ...(ctx.kept ? { deviceCode: ctx.deviceCode } : {}) },
      hint: fixable
        ? `Fix the folder the message names (leave the entry out, or add it to .gitignore), ${resume}.`
        : `Nothing left this machine but the upload, and the platform kept no project. Try once more, ${resume}.`,
    });
  }

  return envelope({
    ok: false,
    command: COMMAND,
    status: "upload-failed",
    error: {
      code: upload.kind === "network" ? "E_NETWORK" : "E_PLATFORM",
      name: "SourceUploadError",
      message: `The source upload for ${ctx.project} ${upload.kind === "network" ? `did not complete (${upload.message})` : `answered ${upload.status} but could not be read (${upload.message})`}, so no create was sent and nothing was created.`,
    },
    value: { project: ctx.project, ...(ctx.kept ? { deviceCode: ctx.deviceCode } : {}) },
    hint: `Nothing was created, so a retry is safe: ${resume}.`,
  });
}

function createdByRead(found: ProjectFoundByRead, source: CreateSource, apiBase: string, local: ProjectCreateLocal): string {
  const ref = `${found.workspaceSlug}/${found.projectSlug}`;
  local.rememberCreatedProject(apiBase, ref);
  const consoleUrl = consoleProjectUrl({ workspace: found.workspaceSlug, project: found.projectSlug }, "", apiBase);
  const links = linksOf([{ kind: "project", url: consoleUrl, made: true }]);
  const login: CreateLogin = { stored: false, project: ref, reason: "confirmed-by-read" };

  return envelope({
    ok: true,
    command: COMMAND,
    status: "created",
    value: {
      workspaceSlug: found.workspaceSlug,
      projectSlug: found.projectSlug,
      projectId: found.projectId,
      consoleUrl,
      source: source.kind,
      ...(source.kind === "github" ? { sourceRepo: source.repo } : { projectPath: source.root }),
      confirmedBy: "project-read",
      outcome: recordedOutcome("created"),
      links,
      login,
      firstBuild: firstBuildValue({ state: "unsaid" }),
      nextSteps: [
        `extension_auth (action: login, project: '${ref}')`,
        `extension_release_status (include: ['releases'], project: '${ref}') until a build is listed, then extension_publish`,
      ],
    },
    hint: `Project ${ref} exists: the platform still answers this grant's request as creating, but a read with the stored login for ${found.readWith} finds the project, so the create landed and nothing was sent again. No token came with that read, so one more approval is needed: extension_auth (action: login, project: '${ref}') to mint the project token. The provisioning grant is no longer kept on this machine. ${madeSentence(links)}`,
    warnings: [`The platform did not say whether a first build was dispatched for ${ref}; its Builds page in the console shows it.`],
  });
}
