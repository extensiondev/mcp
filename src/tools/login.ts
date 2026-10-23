// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import {
  requestDeviceCode,
  pollDeviceGrant,
  pollDeviceToken,
  type DeviceGrantPollResult,
  type DevicePollResult,
} from "../lib/device-flow";
import {
  fetchLoginConfig,
  persistBatchTokenResponse,
  persistWorkspaceTokenResponse,
  resolveApiBase,
  safeApiBase,
  tokenTtlNote,
} from "../lib/login-flow";
import { envelope, type ErrorCode } from "../lib/envelope";
import {
  BATCH_UNSUPPORTED_MESSAGE,
  WILDCARD_UNSUPPORTED_MESSAGE,
  WORKSPACE_WILDCARD,
  parseProjectBatch,
  parseWorkspaceSlug,
} from "../lib/project-batch";
import { consoleBase } from "../lib/registry";
import { isProjectRef } from "../lib/credentials";
import { followProjectMove, followSentence, readProjectMove } from "../lib/project-move";
import { projectPresence, sameSlugElsewhere, type ProjectPresence } from "../lib/project-on-server";

const FIRST_CALL_BUDGET_MS = 8_000;
const RESUME_BUDGET_MS = 22_000;

const PENDING_TTL_NOTE =
  "Once authorized, the minted token lives at most 7 days (server-enforced); CI must re-mint before expiry (console: project settings -> Access tokens).";

function fail(
  name: string,
  message: string,
  status: string,
  code: ErrorCode,
  extra?: { hint?: string; value?: Record<string, unknown>; warnings?: string[] },
): string {
  return envelope({
    ok: false,
    command: "extension_auth",
    status,
    error: { code, name, message },
    ...(extra?.value ? { value: extra.value } : {}),
    ...(extra?.hint ? { hint: extra.hint } : {}),
    ...(extra?.warnings?.length ? { warnings: extra.warnings } : {}),
  });
}

function success(creds: {
  workspaceSlug: string;
  projectSlug: string;
  expiresAt: number;
  api?: string;
}): string {
  const expiresAt = creds.expiresAt
    ? new Date(creds.expiresAt * 1000).toISOString()
    : null;

  return envelope({
    ok: true,
    command: "extension_auth",
    status: "logged-in",
    value: {
      workspaceSlug: creds.workspaceSlug,
      projectSlug: creds.projectSlug,
      expiresAt,
    },
    hint: `Logged in to ${creds.workspaceSlug}/${creds.projectSlug}. ${
      String(process.env.EXTENSION_DEV_TOKEN || "").trim()
        ? `EXTENSION_DEV_TOKEN is set, so an unnamed extension_publish still sends it; pass project: "${creds.workspaceSlug}/${creds.projectSlug}" to use this stored login.`
        : "extension_publish can now use the stored token."
    } The token expires ${
      expiresAt ?? "within 7 days"
    }: extension.dev CLI tokens live at most 7 days, so CI must re-mint before then (console: project settings -> Access tokens).`,
    warnings: [tokenTtlNote(creds.workspaceSlug, creds.projectSlug, creds.api)],
  });
}

function pending(
  start: {
    deviceCode: string;
    userCode: string;
    verificationUri: string;
    verificationUriComplete?: string;
  },
  presence: { warning: string | null; value: Record<string, unknown> | null } = { warning: null, value: null },
): string {
  const complete = String(start.verificationUriComplete || "").trim();
  const hasCompleteLink =
    complete.length > 0 && complete !== start.verificationUri;
  const message = hasCompleteLink
    ? `Open ${complete} and approve (code ${start.userCode} is pre-filled), then call extension_auth (action: login) again with this deviceCode and the same project. If the page asks for a code, enter ${start.userCode} at ${start.verificationUri}.`
    : `Open ${start.verificationUri} and enter code ${start.userCode}, then call extension_auth (action: login) again with this deviceCode and the same project.`;

  return envelope({
    ok: true,
    command: "extension_auth",
    status: "authorization-pending",
    value: {
      userCode: start.userCode,
      verificationUri: start.verificationUri,
      ...(hasCompleteLink ? { verificationUriComplete: complete } : {}),
      deviceCode: start.deviceCode,
      legacyStatus: "authorization_pending",
      ...(presence.value ? { projectCheck: presence.value } : {}),
    },
    hint: message,
    warnings: presence.warning ? [presence.warning, PENDING_TTL_NOTE] : [PENDING_TTL_NOTE],
  });
}

function resumePending(deviceCode: string, verificationUri: string): string {
  const message = `Still waiting for authorization. The one-click link and code from the previous response are still valid: open that link (or enter the code at ${verificationUri}), then call extension_auth (action: login) again with this same deviceCode and the same project.`;

  return envelope({
    ok: true,
    command: "extension_auth",
    status: "authorization-pending",
    value: {
      verificationUri,
      deviceCode,
      legacyStatus: "authorization_pending",
    },
    hint: message,
    warnings: [PENDING_TTL_NOTE],
  });
}

const MISSING_PROJECT_CODES = new Set(["PROJECT_NOT_FOUND", "WORKSPACE_NOT_FOUND"]);

function movedProjectRefusal(
  poll: Extract<DevicePollResult, { ok: false }>,
  ctx: { apiBase: string; project: string },
): string | null {
  if (String(poll.code || "") !== "PROJECT_MOVED") return null;

  const body = poll.body ?? {};
  const workspace = String(body.workspaceSlug ?? "").trim().toLowerCase();
  const project = String(body.projectSlug ?? "").trim().toLowerCase();
  if (!workspace || !project) return null;

  const now = `${workspace}/${project}`;
  const move = readProjectMove(body, ctx.project);
  const followed = move ? followProjectMove({ apiBase: ctx.apiBase, move }) : [];

  return fail(
    "LoginProjectMoved",
    poll.message || `The project ${ctx.project} is now ${now}, so this device authorization was closed.`,
    "project-moved",
    "E_AUTH_FAILED",
    {
      value: {
        project: ctx.project,
        server: ctx.apiBase,
        platformCode: "PROJECT_MOVED",
        projectId: String(body.projectId ?? "") || null,
        movedTo: now,
      },
      hint: `The project ${ctx.project} is now ${now}; every login already minted for it keeps working. Run extension_auth (action: "login", project: "${now}") and pass project: '${now}' from now on.`,
      ...(followed.length && move ? { warnings: [followSentence(move)] } : {}),
    },
  );
}

function elsewhereSentence(project: string, servers: string[]): string {
  return servers.length
    ? ` This machine holds a login for ${project} on ${servers.join(", ")}; if the project lives only there, call again with api: '${servers[0]}'.`
    : "";
}

function missingProjectRefusal(
  poll: Extract<DevicePollResult, { ok: false }>,
  ctx: { apiBase: string; project: string },
): string | null {
  const code = String(poll.code || "");
  if (!MISSING_PROJECT_CODES.has(code)) return null;

  const atApproval = poll.reason === "denied" || poll.body?.refusedAt === "approval";
  const elsewhere = sameSlugElsewhere(ctx.apiBase, ctx.project);
  const message =
    poll.message || `${ctx.project} does not exist on ${ctx.apiBase}, so this device authorization was closed.`;

  return fail(
    atApproval ? "LoginApprovalRefused" : "LoginProjectNotFound",
    message,
    atApproval ? "approval-refused" : "project-not-found",
    atApproval ? "E_AUTH_DENIED" : "E_AUTH_FAILED",
    {
      value: {
        project: ctx.project,
        server: ctx.apiBase,
        platformCode: code,
        reason: "project-not-found",
        loginsForThisSlugElsewhere: elsewhere,
      },
      hint: `${ctx.project} does not exist on ${ctx.apiBase}, the server this call targets, so no login can be approved for it there.${elsewhereSentence(ctx.project, elsewhere)} To create it on ${ctx.apiBase}, run extension_project_create with project: '${ctx.project}' and api: '${ctx.apiBase}', then log in again.`,
    },
  );
}

function pollRefusal(
  poll: Extract<DevicePollResult, { ok: false }>,
  ctx: { apiBase: string; project: string },
): string | null {
  const moved = movedProjectRefusal(poll, ctx);
  if (moved) return moved;

  const missing = missingProjectRefusal(poll, ctx);
  if (missing) return missing;

  if (poll.reason === "expired") {
    return fail(
      "LoginExpired",
      "The device code expired. Run extension_auth (action: login) again to restart.",
      "login-expired",
      "E_AUTH_EXPIRED",
    );
  }

  if (poll.reason === "denied") {
    return fail(
      "LoginDenied",
      poll.message
        ? `Authorization was refused at ${ctx.apiBase}/device: ${poll.message}`
        : "Authorization was denied at extension.dev/device.",
      "login-denied",
      "E_AUTH_DENIED",
      poll.code ? { value: { platformCode: poll.code } } : undefined,
    );
  }

  if (poll.reason === "error") {
    return fail(
      "LoginError",
      poll.message || "Device login failed.",
      "login-failed",
      "E_AUTH_FAILED",
    );
  }

  return null;
}

function presenceWarning(presence: ProjectPresence, ctx: { apiBase: string; project: string }): {
  warning: string | null;
  value: Record<string, unknown> | null;
} {
  if (presence !== "not-public") return { warning: null, value: null };

  const elsewhere = sameSlugElsewhere(ctx.apiBase, ctx.project);

  return {
    value: { server: ctx.apiBase, publicProject: false, loginsForThisSlugElsewhere: elsewhere },
    warning: `${ctx.project} is not a public project on ${ctx.apiBase}, and the platform does not say whether a private project exists before someone approves (ruling 2026-08-02), so this code may be for a project that is not there.${elsewhereSentence(ctx.project, elsewhere)} If the approval page says the project does not exist, press "Cancel this request" there and call again with this deviceCode: the answer will name the refusal. To create the project on ${ctx.apiBase}, run extension_project_create with api: '${ctx.apiBase}'.`,
  };
}

export async function loginToProject(args: {
  project: string;
  deviceCode?: string;
  api?: string;
}): Promise<string> {
  const project = String(args.project || "").trim();

  if (!isProjectRef(project)) {
    return fail(
      "BadRequest",
      "project must be in the form '<workspace>/<project>'. The slug pair is the console address bar: an existing project's page is console.extension.dev/<workspace>/<project>. If the project does not exist yet, create it at extension.dev/new, then log in with the slugs the console shows.",
      "bad-request",
      "E_BAD_REQUEST",
    );
  }

  const apiCheck = safeApiBase(resolveApiBase(args.api), args.api);

  if (!apiCheck.ok) {
    return fail(
      "LoginConfigError",
      apiCheck.message,
      "login-failed",
      "E_AUTH_FAILED",
    );
  }

  const apiBase = apiCheck.base;

  let config;

  try {
    config = await fetchLoginConfig(apiBase);
  } catch (err: any) {
    return fail(
      "LoginConfigError",
      err?.message || "Could not load login config.",
      "login-failed",
      "E_AUTH_FAILED",
    );
  }

  if (args.deviceCode) {
    const poll = await pollDeviceToken({
      apiBase,
      path: config.deviceTokenUrl,
      project,
      deviceCode: String(args.deviceCode),
      interval: 5,
      budgetMs: RESUME_BUDGET_MS,
    });
    if (poll.ok) return success(poll.creds);

    const refused = pollRefusal(poll, { apiBase, project });
    if (refused) return refused;

    return resumePending(String(args.deviceCode), config.verificationUri);
  }

  const presence = await projectPresence(apiBase, project);
  let start;

  try {
    start = await requestDeviceCode({
      apiBase,
      path: config.deviceCodeUrl,
      project,
    });
  } catch (err: any) {
    return fail(
      "LoginStartError",
      err?.message || "Could not start the device flow.",
      "login-failed",
      "E_AUTH_FAILED",
    );
  }

  const poll = await pollDeviceToken({
    apiBase,
    path: config.deviceTokenUrl,
    project,
    deviceCode: start.deviceCode,
    interval: start.interval,
    budgetMs: FIRST_CALL_BUDGET_MS,
  });
  if (poll.ok) return success(poll.creds);

  const refused = pollRefusal(poll, { apiBase, project });
  if (refused) return refused;

  return pending(
    {
      deviceCode: start.deviceCode,
      userCode: start.userCode,
      verificationUri: start.verificationUri,
      verificationUriComplete: start.verificationUriComplete,
    },
    presenceWarning(presence, { apiBase, project }),
  );
}

const BATCH_FINAL_POLL_NOTE =
  "The platform records one token per project before it answers, so the call that completes a batch login can take up to a minute. Let it finish: the device code is spent the moment minting starts, and a call abandoned midway cannot be resumed.";

function batchPending(args: {
  deviceCode: string;
  projects: string[];
  verificationUri: string;
  userCode?: string;
  verificationUriComplete?: string;
}): string {
  const complete = String(args.verificationUriComplete || "").trim();
  const hasCompleteLink =
    complete.length > 0 && complete !== args.verificationUri;
  const again =
    "then call extension_auth (action: login) again with this deviceCode and the same projects";
  const hint = !args.userCode
    ? `Still waiting for authorization. The link and code from the previous response are still valid: approve at ${args.verificationUri}, ${again}.`
    : hasCompleteLink
      ? `Open ${complete} and approve (code ${args.userCode} is pre-filled). The page lists all ${args.projects.length} projects this one approval signs in to; ${again}. If the page asks for a code, enter ${args.userCode} at ${args.verificationUri}.`
      : `Open ${args.verificationUri} and enter code ${args.userCode}. The page lists all ${args.projects.length} projects this one approval signs in to; ${again}.`;

  return envelope({
    ok: true,
    command: "extension_auth",
    status: "authorization-pending",
    value: {
      ...(args.userCode ? { userCode: args.userCode } : {}),
      verificationUri: args.verificationUri,
      ...(args.userCode && hasCompleteLink
        ? { verificationUriComplete: complete }
        : {}),
      deviceCode: args.deviceCode,
      projects: args.projects,
      legacyStatus: "authorization_pending",
    },
    hint,
    warnings: [PENDING_TTL_NOTE, BATCH_FINAL_POLL_NOTE],
  });
}

function batchRefusal(
  poll: Extract<DeviceGrantPollResult, { ok: false }>,
  projects: string[] | typeof WORKSPACE_WILDCARD,
  apiBase: string,
): string {
  if (poll.reason === "expired") {
    return fail(
      "LoginExpired",
      "The device code expired or was already spent. Run extension_auth (action: login) again with the same projects to restart.",
      "login-expired",
      "E_AUTH_EXPIRED",
    );
  }

  const code = String(poll.code || "");

  if (code === "PROJECT_NOT_FOUND") {
    const missing = Array.isArray(poll.body?.missingProjects)
      ? (poll.body?.missingProjects as unknown[]).map(String)
      : [];

    return fail(
      "LoginProjectNotFound",
      poll.message ||
        "At least one listed project does not exist, so no token was minted for any of them.",
      "login-failed",
      "E_AUTH_FAILED",
      {
        value: { code, missingProjects: missing, projects },
        hint: `A batch login is all or nothing and covers only projects that already exist. ${
          missing.length && projects !== WORKSPACE_WILDCARD
            ? `Drop or fix ${missing.join(", ")} and run extension_auth (action: login) again with the rest`
            : "Check each name against the console and run extension_auth (action: login) again"
        }; create missing projects with extension_project_create (same api) or at ${consoleBase(apiBase)}.`,
      },
    );
  }

  if (code === "MEMBERSHIP_REVOKED") {
    return fail(
      "LoginMembershipRevoked",
      poll.message ||
        "The member who approved this login is no longer in the workspace, so no token was minted.",
      "login-failed",
      "E_AUTH_FAILED",
      { value: { code, projects } },
    );
  }

  if (poll.reason === "denied") {
    return fail(
      "LoginDenied",
      "Authorization was denied at extension.dev/device.",
      "login-denied",
      "E_AUTH_DENIED",
    );
  }

  return fail(
    "LoginError",
    poll.message || "Device login failed.",
    "login-failed",
    "E_AUTH_FAILED",
    {
      value: { ...(code ? { code } : {}), projects },
      hint: "No token from this batch was stored. Run extension_auth (action: login) again with the same projects; a batch that was refused or failed midway is closed on the platform and needs a fresh approval.",
    },
  );
}

export async function loginToProjects(args: {
  projects: unknown;
  deviceCode?: string;
  api?: string;
}): Promise<string> {
  const parsed = parseProjectBatch(args.projects);

  if (!parsed.ok) {
    return fail("BadRequest", parsed.message, "bad-request", "E_BAD_REQUEST");
  }

  const projects = parsed.batch.refs;

  const apiCheck = safeApiBase(resolveApiBase(args.api), args.api);

  if (!apiCheck.ok) {
    return fail(
      "LoginConfigError",
      apiCheck.message,
      "login-failed",
      "E_AUTH_FAILED",
    );
  }

  const apiBase = apiCheck.base;

  let config;

  try {
    config = await fetchLoginConfig(apiBase);
  } catch (err: any) {
    return fail(
      "LoginConfigError",
      err?.message || "Could not load login config.",
      "login-failed",
      "E_AUTH_FAILED",
    );
  }

  if (!config.batch) {
    return fail(
      "LoginBatchUnsupported",
      BATCH_UNSUPPORTED_MESSAGE,
      "batch-unsupported",
      "E_PLATFORM",
      {
        value: { projects },
        hint: "Sign in to each project with its own extension_auth (action: login, project) call.",
      },
    );
  }

  if (projects.length > config.batch.loginProjectsPerApproval) {
    return fail(
      "BadRequest",
      `projects names ${projects.length} projects, and one approval signs in to at most ${config.batch.loginProjectsPerApproval} on this platform.`,
      "bad-request",
      "E_BAD_REQUEST",
      {
        hint: `Split the list into calls of ${config.batch.loginProjectsPerApproval} or fewer; each call is its own approval. No device code was spent.`,
      },
    );
  }

  let deviceCode = String(args.deviceCode || "").trim();
  let interval = 5;
  let budgetMs = RESUME_BUDGET_MS;
  let start: Awaited<ReturnType<typeof requestDeviceCode>> | null = null;

  if (!deviceCode) {
    try {
      start = await requestDeviceCode({
        apiBase,
        path: config.deviceCodeUrl,
        projects,
      });
    } catch (err: any) {
      return fail(
        "LoginStartError",
        err?.message || "Could not start the device flow.",
        "login-failed",
        "E_AUTH_FAILED",
        {
          hint: "No device code was issued. Sign in to each project with its own extension_auth (action: login, project) call, or fix what the platform refused and try the list again.",
        },
      );
    }

    deviceCode = start.deviceCode;
    interval = start.interval;
    budgetMs = FIRST_CALL_BUDGET_MS;
  }

  const poll = await pollDeviceGrant({
    apiBase,
    path: config.deviceTokenUrl,
    projects,
    deviceCode,
    interval,
    budgetMs,
  });

  if (!poll.ok) {
    if (poll.reason === "pending") {
      return batchPending({
        deviceCode,
        projects,
        verificationUri: start?.verificationUri ?? config.verificationUri,
        userCode: start?.userCode,
        verificationUriComplete: start?.verificationUriComplete,
      });
    }

    return batchRefusal(poll, projects, apiBase);
  }

  let stored;

  try {
    stored = persistBatchTokenResponse({ apiBase, projects, data: poll.data });
  } catch (err: any) {
    return fail(
      "LoginError",
      err?.message ? String(err.message) : String(err),
      "login-failed",
      "E_AUTH_FAILED",
    );
  }

  const logins = stored.map((creds) => ({
    project: `${creds.workspaceSlug}/${creds.projectSlug}`,
    workspaceSlug: creds.workspaceSlug,
    projectSlug: creds.projectSlug,
    expiresAt: creds.expiresAt
      ? new Date(creds.expiresAt * 1000).toISOString()
      : null,
  }));

  return envelope({
    ok: true,
    command: "extension_auth",
    status: "logged-in",
    value: { workspaceSlug: parsed.batch.workspace, logins },
    hint: `Logged in to ${logins.length} project${logins.length === 1 ? "" : "s"} in ${parsed.batch.workspace}: ${logins.map((login) => login.projectSlug).join(", ")}. Each has its own stored token; token-scoped tools take \`project\` to pick one, and extension_auth (action: status) lists them. The default login was left as it was unless none existed. Every token expires within 7 days, so one batch login renews them together.`,
    warnings: [tokenTtlNote(undefined, undefined, apiBase)],
  });
}

function workspacePending(args: {
  deviceCode: string;
  workspace: string;
  verificationUri: string;
  userCode?: string;
  verificationUriComplete?: string;
}): string {
  const complete = String(args.verificationUriComplete || "").trim();
  const hasCompleteLink =
    complete.length > 0 && complete !== args.verificationUri;
  const again = `then call extension_auth (action: "login", workspace: "${args.workspace}", projects: "*") again with this deviceCode`;
  const shown = `The page lists every project ${args.workspace} has right now, and approving signs in to each of them (at most 20)`;
  const hint = !args.userCode
    ? `Still waiting for authorization. The link and code from the previous response are still valid: approve at ${args.verificationUri}, ${again}.`
    : hasCompleteLink
      ? `Open ${complete} and approve (code ${args.userCode} is pre-filled). ${shown}; ${again}. If the page asks for a code, enter ${args.userCode} at ${args.verificationUri}.`
      : `Open ${args.verificationUri} and enter code ${args.userCode}. ${shown}; ${again}.`;

  return envelope({
    ok: true,
    command: "extension_auth",
    status: "authorization-pending",
    value: {
      ...(args.userCode ? { userCode: args.userCode } : {}),
      verificationUri: args.verificationUri,
      ...(args.userCode && hasCompleteLink
        ? { verificationUriComplete: complete }
        : {}),
      deviceCode: args.deviceCode,
      workspace: args.workspace,
      projects: WORKSPACE_WILDCARD,
      legacyStatus: "authorization_pending",
    },
    hint,
    warnings: [PENDING_TTL_NOTE, BATCH_FINAL_POLL_NOTE],
  });
}

export async function loginToWorkspace(args: {
  workspace: unknown;
  deviceCode?: string;
  api?: string;
}): Promise<string> {
  const parsed = parseWorkspaceSlug(args.workspace);

  if (!parsed.ok) {
    return fail("BadRequest", parsed.message, "bad-request", "E_BAD_REQUEST");
  }

  const workspace = parsed.workspace;
  const apiCheck = safeApiBase(resolveApiBase(args.api), args.api);

  if (!apiCheck.ok) {
    return fail("LoginConfigError", apiCheck.message, "login-failed", "E_AUTH_FAILED");
  }

  const apiBase = apiCheck.base;

  let config;

  try {
    config = await fetchLoginConfig(apiBase);
  } catch (err: any) {
    return fail(
      "LoginConfigError",
      err?.message || "Could not load login config.",
      "login-failed",
      "E_AUTH_FAILED",
    );
  }

  if (!config.batch?.workspaceWildcard) {
    return fail(
      "LoginWildcardUnsupported",
      WILDCARD_UNSUPPORTED_MESSAGE,
      "batch-unsupported",
      "E_PLATFORM",
      {
        value: { workspace, projects: WORKSPACE_WILDCARD },
        hint: config.batch
          ? `Name the projects instead: extension_auth (action: "login", projects: ["${workspace}/<project>", ...]), up to ${config.batch.loginProjectsPerApproval} per approval.`
          : "Sign in to each project with its own extension_auth (action: login, project) call.",
      },
    );
  }

  let deviceCode = String(args.deviceCode || "").trim();
  let interval = 5;
  let budgetMs = RESUME_BUDGET_MS;
  let start: Awaited<ReturnType<typeof requestDeviceCode>> | null = null;

  if (!deviceCode) {
    try {
      start = await requestDeviceCode({
        apiBase,
        path: config.deviceCodeUrl,
        projects: WORKSPACE_WILDCARD,
        workspace,
      });
    } catch (err: any) {
      return fail(
        "LoginStartError",
        err?.message || "Could not start the device flow.",
        "login-failed",
        "E_AUTH_FAILED",
        { hint: "No device code was issued. Fix what the platform refused and try again, or name the projects in a list." },
      );
    }

    deviceCode = start.deviceCode;
    interval = start.interval;
    budgetMs = FIRST_CALL_BUDGET_MS;
  }

  const poll = await pollDeviceGrant({
    apiBase,
    path: config.deviceTokenUrl,
    projects: WORKSPACE_WILDCARD,
    workspace,
    deviceCode,
    interval,
    budgetMs,
  });

  if (!poll.ok) {
    if (poll.reason === "pending") {
      return workspacePending({
        deviceCode,
        workspace,
        verificationUri: start?.verificationUri ?? config.verificationUri,
        userCode: start?.userCode,
        verificationUriComplete: start?.verificationUriComplete,
      });
    }

    return batchRefusal(poll, WORKSPACE_WILDCARD, apiBase);
  }

  let stored;

  try {
    stored = persistWorkspaceTokenResponse({ apiBase, workspace, data: poll.data });
  } catch (err: any) {
    return fail(
      "LoginError",
      err?.message ? String(err.message) : String(err),
      "login-failed",
      "E_AUTH_FAILED",
    );
  }

  const logins = stored.map((creds) => ({
    project: `${creds.workspaceSlug}/${creds.projectSlug}`,
    workspaceSlug: creds.workspaceSlug,
    projectSlug: creds.projectSlug,
    expiresAt: creds.expiresAt
      ? new Date(creds.expiresAt * 1000).toISOString()
      : null,
  }));

  return envelope({
    ok: true,
    command: "extension_auth",
    status: "logged-in",
    value: { workspaceSlug: workspace, projects: WORKSPACE_WILDCARD, logins },
    hint: `Logged in to all ${logins.length} project${logins.length === 1 ? "" : "s"} of ${workspace} the approver saw: ${logins.map((login) => login.projectSlug).join(", ")}. Each has its own stored token; token-scoped tools take \`project\` to pick one, and extension_workspace reads the workspace with any of them. A project created later is not covered: run this login again to add it. Every token expires within 7 days.`,
    warnings: [tokenTtlNote(undefined, undefined, apiBase)],
  });
}
