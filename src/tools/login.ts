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
} from "../lib/device-flow";
import {
  fetchLoginConfig,
  persistBatchTokenResponse,
  resolveApiBase,
  safeApiBase,
  tokenTtlNote,
} from "../lib/login-flow";
import { envelope, type ErrorCode } from "../lib/envelope";
import { parseProjectBatch } from "../lib/project-batch";
import { consoleBase } from "../lib/registry";

const FIRST_CALL_BUDGET_MS = 8_000;
const RESUME_BUDGET_MS = 22_000;

const PENDING_TTL_NOTE =
  "Once authorized, the minted token lives at most 7 days (server-enforced); CI must re-mint before expiry (console: project settings -> Access tokens).";

function fail(
  name: string,
  message: string,
  status: string,
  code: ErrorCode,
  extra?: { hint?: string; value?: Record<string, unknown> },
): string {
  return envelope({
    ok: false,
    command: "extension_auth",
    status,
    error: { code, name, message },
    ...(extra?.value ? { value: extra.value } : {}),
    ...(extra?.hint ? { hint: extra.hint } : {}),
  });
}

function success(creds: {
  workspaceSlug: string;
  projectSlug: string;
  expiresAt: number;
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
    hint: `Logged in to ${creds.workspaceSlug}/${creds.projectSlug}. extension_publish can now use the stored token. The token expires ${
      expiresAt ?? "within 7 days"
    }: extension.dev CLI tokens live at most 7 days, so CI must re-mint before then (console: project settings -> Access tokens).`,
    warnings: [tokenTtlNote(creds.workspaceSlug, creds.projectSlug)],
  });
}

function pending(start: {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
}): string {
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
    },
    hint: message,
    warnings: [PENDING_TTL_NOTE],
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

export async function loginToProject(args: {
  project: string;
  deviceCode?: string;
  api?: string;
}): Promise<string> {
  const project = String(args.project || "").trim();
  if (!/^[^/]+\/[^/]+$/.test(project)) {
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
        "Authorization was denied at extension.dev/device.",
        "login-denied",
        "E_AUTH_DENIED",
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
    return resumePending(String(args.deviceCode), config.verificationUri);
  }

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
      "Authorization was denied at extension.dev/device.",
      "login-denied",
      "E_AUTH_DENIED",
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
  return pending({
    deviceCode: start.deviceCode,
    userCode: start.userCode,
    verificationUri: start.verificationUri,
    verificationUriComplete: start.verificationUriComplete,
  });
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

/* @invariant Every branch here reads the platform's `code`, never its
 * sentence. A list refused for a missing project, an approver who left the
 * workspace and a human pressing Deny all reach this function as a failed
 * poll, and the platform tells them apart only by code; the sentences are
 * shown to the reader and decide nothing. */
function batchRefusal(
  poll: Extract<DeviceGrantPollResult, { ok: false }>,
  projects: string[],
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
          missing.length
            ? `Drop or fix ${missing.join(", ")} and run extension_auth (action: login) again with the rest`
            : "Check each name against the console and run extension_auth (action: login) again"
        }; create missing projects with extension_project_create or at ${consoleBase()}.`,
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

/* @invariant ONE APPROVAL, ONE LIST, AND THE TOKENS NEVER LEAVE THIS PROCESS.
 * The list is checked here against the platform's own rules before a device
 * code is spent, the same list is sent on the code request and on every poll
 * so a code can only be redeemed for the names the approver was shown, and
 * what comes back is stored per project and reported as names and expiry
 * dates, never as token strings. The poll is the raw grant poll on purpose:
 * the login poll would persist the first token alone, under the latest-login
 * rule, before the rest of the batch had been checked.
 */
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
          hint: "No device code was issued. If this platform predates batch login it refuses the list form; sign in to each project with its own extension_auth (action: login, project) call.",
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
    return batchRefusal(poll, projects);
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
    warnings: [tokenTtlNote()],
  });
}
