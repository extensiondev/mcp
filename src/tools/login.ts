// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import {
  requestDeviceCode,
  pollDeviceToken,
} from "../lib/device-flow";
import {
  fetchLoginConfig,
  resolveApiBase,
  tokenTtlNote,
} from "../lib/login-flow";

const FIRST_CALL_BUDGET_MS = 8_000;
const RESUME_BUDGET_MS = 22_000;

function fail(name: string, message: string): string {
  return JSON.stringify({ ok: false, error: { name, message } });
}

function success(creds: {
  workspaceSlug: string;
  projectSlug: string;
  expiresAt: number;
}): string {
  const expiresAt = creds.expiresAt
    ? new Date(creds.expiresAt * 1000).toISOString()
    : null;
  return JSON.stringify({
    ok: true,
    status: "logged-in",
    workspaceSlug: creds.workspaceSlug,
    projectSlug: creds.projectSlug,
    expiresAt,
    tokenTtlNote: tokenTtlNote(creds.workspaceSlug, creds.projectSlug),
    message: `Logged in to ${creds.workspaceSlug}/${creds.projectSlug}. extension_publish can now use the stored token. The token expires ${
      expiresAt ?? "within 7 days"
    }: extension.dev CLI tokens live at most 7 days, so CI must re-mint before then (console: project settings -> Access tokens).`,
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
  return JSON.stringify({
    ok: false,
    status: "authorization_pending",
    userCode: start.userCode,
    verificationUri: start.verificationUri,
    ...(hasCompleteLink ? { verificationUriComplete: complete } : {}),
    deviceCode: start.deviceCode,
    tokenTtlNote:
      "Once authorized, the minted token lives at most 7 days (server-enforced); CI must re-mint before expiry (console: project settings -> Access tokens).",
    message,
  });
}

function resumePending(deviceCode: string, verificationUri: string): string {
  return JSON.stringify({
    ok: false,
    status: "authorization_pending",
    verificationUri,
    deviceCode,
    tokenTtlNote:
      "Once authorized, the minted token lives at most 7 days (server-enforced); CI must re-mint before expiry (console: project settings -> Access tokens).",
    message: `Still waiting for authorization. The one-click link and code from the previous response are still valid: open that link (or enter the code at ${verificationUri}), then call extension_auth (action: login) again with this same deviceCode and the same project.`,
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
      "project must be in the form '<workspace>/<project>'.",
    );
  }

  const apiBase = resolveApiBase(args.api);

  let config;
  try {
    config = await fetchLoginConfig(apiBase);
  } catch (err: any) {
    return fail(
      "LoginConfigError",
      err?.message || "Could not load login config.",
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
      );
    }
    if (poll.reason === "denied") {
      return fail("LoginDenied", "Authorization was denied at extension.dev/device.");
    }
    if (poll.reason === "error") {
      return fail("LoginError", poll.message || "Device login failed.");
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
  if (poll.reason === "denied") {
    return fail("LoginDenied", "Authorization was denied at extension.dev/device.");
  }
  return pending({
    deviceCode: start.deviceCode,
    userCode: start.userCode,
    verificationUri: start.verificationUri,
    verificationUriComplete: start.verificationUriComplete,
  });
}
