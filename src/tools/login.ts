// extension_login — authenticate to extension.dev and persist a project-scoped
// access token locally so `extension_publish` works without the user exporting
// EXTENSION_DEV_TOKEN by hand.
//
// Two-phase by design, because an MCP tool call must return promptly and the
// device flow waits on a human:
//   - First call (no deviceCode): starts the GitHub device flow, polls briefly,
//     and if the user hasn't authorized yet returns the code + URL plus a
//     `deviceCode` to resume with.
//   - Resume call (deviceCode passed): polls again; on success it writes the
//     credentials, on "pending" it asks to be called again.
// The token is never returned or logged.

import {
  pollForToken,
  startDeviceCode,
  type DeviceCodeStart,
} from "../lib/github-device";
import {
  exchangeAndPersist,
  fetchLoginConfig,
  resolveApiBase,
} from "../lib/login-flow";

export const schema = {
  name: "extension_login",
  description:
    "Authenticate to extension.dev via GitHub device-code and store a project-scoped access token locally so extension_publish can use it. Two-phase: call with `project` to get a code + URL for the user to authorize, then call again with the returned `deviceCode` to finish. Never returns the token. This is the only tool besides extension_publish that talks to the hosted platform.",
  inputSchema: {
    type: "object" as const,
    properties: {
      project: {
        type: "string",
        description:
          "Target project as '<workspace>/<project>' (the token is scoped to it)",
      },
      deviceCode: {
        type: "string",
        description:
          "Resume token from a prior call's `deviceCode`; omit on the first call",
      },
      api: {
        type: "string",
        description:
          "Platform base URL (defaults to https://www.extension.dev or EXTENSION_DEV_API_URL)",
      },
    },
    required: ["project"],
  },
};

// Per-call poll budgets. Kept well under typical MCP client timeouts; the user
// is expected to authorize between calls, not during a single one.
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
  return JSON.stringify({
    ok: true,
    status: "logged-in",
    workspaceSlug: creds.workspaceSlug,
    projectSlug: creds.projectSlug,
    expiresAt: creds.expiresAt
      ? new Date(creds.expiresAt * 1000).toISOString()
      : null,
    message: `Logged in to ${creds.workspaceSlug}/${creds.projectSlug}. extension_publish can now use the stored token.`,
  });
}

function pending(start: {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
}): string {
  return JSON.stringify({
    ok: false,
    status: "authorization_pending",
    userCode: start.userCode,
    verificationUri: start.verificationUri,
    deviceCode: start.deviceCode,
    message: `Open ${start.verificationUri} and enter code ${start.userCode}, then call extension_login again with this deviceCode (and the same project).`,
  });
}

export async function handler(args: {
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

  // Resume phase: we already have a device code from a prior call.
  if (args.deviceCode) {
    const poll = await pollForToken({
      clientId: config.clientId,
      deviceCode: String(args.deviceCode),
      interval: 5,
      budgetMs: RESUME_BUDGET_MS,
    });
    if (!poll.ok) {
      if (poll.reason === "expired") {
        return fail(
          "LoginExpired",
          "The device code expired. Run extension_login again to restart.",
        );
      }
      if (poll.reason === "denied") {
        return fail("LoginDenied", "Authorization was denied on GitHub.");
      }
      return pending({
        deviceCode: String(args.deviceCode),
        userCode: "(see the previous response)",
        verificationUri: "https://github.com/login/device",
      });
    }
    try {
      const creds = await exchangeAndPersist({
        apiBase,
        githubToken: poll.githubToken,
        project,
      });
      return success(creds);
    } catch (err: any) {
      return fail(
        "LoginExchangeError",
        err?.message || "Token exchange failed.",
      );
    }
  }

  // First phase: start the device flow and poll briefly in case the user is
  // quick. Otherwise hand back the code + URL to resume with.
  let start: DeviceCodeStart;
  try {
    start = await startDeviceCode({
      clientId: config.clientId,
      scope: config.scope,
    });
  } catch (err: any) {
    return fail(
      "LoginStartError",
      err?.message || "Could not start device flow.",
    );
  }

  const poll = await pollForToken({
    clientId: config.clientId,
    deviceCode: start.deviceCode,
    interval: start.interval,
    budgetMs: FIRST_CALL_BUDGET_MS,
  });
  if (poll.ok) {
    try {
      const creds = await exchangeAndPersist({
        apiBase,
        githubToken: poll.githubToken,
        project,
      });
      return success(creds);
    } catch (err: any) {
      return fail(
        "LoginExchangeError",
        err?.message || "Token exchange failed.",
      );
    }
  }
  if (!poll.ok && poll.reason === "denied") {
    return fail("LoginDenied", "Authorization was denied on GitHub.");
  }
  return pending(start);
}
