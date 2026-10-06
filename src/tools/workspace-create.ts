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
  resolveApiBase,
  safeApiBase,
} from "../lib/login-flow";
import { consoleBase } from "../lib/registry";
import { platformHoldEnvelope, sawPlatformHold } from "../lib/platform-hold";
import { identityHeaders } from "../lib/session-identity";
import { answerIsUnknownOutcome, readCreatedWorkspace } from "../lib/create-answer";

const COMMAND = "extension_workspace_create";

const FIRST_CALL_BUDGET_MS = 8_000;
const RESUME_BUDGET_MS = 22_000;

const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/i;

export const schema = {
  name: COMMAND,
  description:
    "Create an extension.dev workspace that does not exist yet, without opening the console. Use it before extension_project_create when the project's workspace is not there: project creation can only target an existing workspace, and this tool is what brings one into existence. Two-phase, like login: the first call returns a code and a URL where a signed-in GitHub user approves creating exactly this workspace and becomes its owner; call again with the returned deviceCode to finish. Check `ownerGithubLogin` in the answer: whoever approved the code owns the workspace. The approval mints a grant that lives minutes, can only create the one named workspace, names no project, and is never stored on this machine. Then run extension_project_create against '<workspace>/<project>'.",
  inputSchema: {
    type: "object" as const,
    properties: {
      workspace: {
        type: "string",
        description:
          "Slug of the new workspace, lowercase letters, digits and hyphens, no slash. It must not exist yet; a personal workspace (the GitHub login) already exists for every signed-in user, so this is for a shared or organization-style workspace.",
      },
      displayName: {
        type: "string",
        description: "Human name for the workspace. Defaults to the slug.",
      },
      description: {
        type: "string",
        description: "Short workspace description. Optional.",
      },
      developerUrl: {
        type: "string",
        description: "Public URL for the workspace. Optional.",
      },
      deviceCode: {
        type: "string",
        description:
          "Resume token from the prior call's `deviceCode`; omit on the first call.",
      },
      api: API_BASE,
    },
    required: ["workspace"],
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

function laneClosedHint(): string {
  return `Create the workspace in the console at ${consoleBase()} (workspace switcher, New workspace), then run extension_project_create against it. Headless workspace creation opens with the platform; during the public hold only an allowlisted workspace slug can be created this way.`;
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
    ? `Open ${complete} and approve creating the workspace (code ${start.userCode} is pre-filled), then call ${COMMAND} again with this deviceCode and the same arguments. If the page asks for a code, enter ${start.userCode} at ${start.verificationUri}. The GitHub account that approves becomes the workspace owner.`
    : `Open ${start.verificationUri}, enter code ${start.userCode}, approve creating the workspace, then call ${COMMAND} again with this deviceCode and the same arguments. The GitHub account that approves becomes the workspace owner.`;
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
  workspace: string;
  displayName?: string;
  description?: string;
  developerUrl?: string;
  deviceCode?: string;
  api?: string;
}): Promise<string> {
  const workspace = String(args.workspace || "")
    .trim()
    .toLowerCase();
  if (!SLUG_PATTERN.test(workspace)) {
    return fail(
      "BadRequest",
      "workspace must be a single slug: lowercase letters, digits and hyphens, no slash, at most 64 characters.",
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
        workspace,
        intent: "create-workspace",
      });
    } catch (err: any) {
      const message = err?.message || "Could not start the device flow.";
      const laneClosed = laneClosedByServer(err, "CLI_WORKSPACE_CREATE_DISABLED");
      const serverMessage =
        typeof err?.serverMessage === "string" ? err.serverMessage.trim() : "";
      return fail(
        "CreateStartError",
        laneClosed
          ? serverMessage ||
              `Headless workspace creation is not open on this host yet. Create the workspace in the console instead. (${message})`
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
      workspace,
      deviceCode,
      interval,
      budgetMs,
    });
    if (!early.ok && early.reason === "pending") {
      return pendingEnvelope(start);
    }
    return finishFromPoll(early, {
      apiBase,
      workspace,
      args,
      verificationUri: config.verificationUri,
      deviceCode,
    });
  }

  const poll = await pollDeviceGrant({
    apiBase,
    path: config.deviceTokenUrl,
    workspace,
    deviceCode,
    interval,
    budgetMs,
  });
  return finishFromPoll(poll, {
    apiBase,
    workspace,
    args,
    verificationUri: config.verificationUri,
    deviceCode,
  });
}

async function finishFromPoll(
  poll: Awaited<ReturnType<typeof pollDeviceGrant>>,
  ctx: {
    apiBase: string;
    workspace: string;
    args: { displayName?: string; description?: string; developerUrl?: string };
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
        hint: `Still waiting for approval at ${ctx.verificationUri}. Approve there, then call ${COMMAND} again with this same deviceCode.`,
      });
    }
    if (poll.reason === "denied") {
      return fail(
        "CreateDenied",
        "Creating the workspace was denied at extension.dev/device.",
        "create-denied",
        "E_AUTH_DENIED",
      );
    }
    if (poll.reason === "expired") {
      return fail(
        "CreateExpired",
        `The device code expired. Run ${COMMAND} again to restart.`,
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
  const workspaceSlug = String(grant.workspaceSlug || "")
    .trim()
    .toLowerCase();
  /* @invariant The grant must be the WORKSPACE kind for the WORKSPACE asked.
   * A project token or a project provisioning grant answering this poll
   * means the record was not ours, and sending either to the create endpoint
   * would only earn a refusal; nothing is created and nothing is stored. */
  if (workspaceSlug !== ctx.workspace) {
    return fail(
      "CreateScopeError",
      `The approval was scoped to workspace '${workspaceSlug}', not the requested '${ctx.workspace}'. Nothing was created. Run ${COMMAND} again with the intended workspace.`,
      "create-failed",
      "E_AUTH_FAILED",
    );
  }
  if (String(grant.tokenKind || "") !== "workspace-provisioning") {
    return envelope({
      ok: false,
      command: COMMAND,
      status: "workspace-exists",
      error: {
        code: "E_PLATFORM",
        message: `Workspace '${ctx.workspace}' already exists on this host, so there is nothing to create.`,
      },
      hint: `Run extension_project_create with project '${ctx.workspace}/<project>' instead.`,
    });
  }

  const url = `${ctx.apiBase}/api/cli/workspaces/create`;
  const unconfirmed = (what: string, code: ErrorCode): string =>
    envelope({
      ok: false,
      command: COMMAND,
      status: "create-unconfirmed",
      error: {
        code,
        name: "CreateUnconfirmed",
        message: `${what}, so whether workspace ${ctx.workspace} now exists is unknown.`,
      },
      value: { workspace: ctx.workspace, consoleUrl: consoleBase() },
      hint: `Do not create it again blind: the grant is spent, and the first request may have landed. Look for ${ctx.workspace} in the console at ${consoleBase()}. If it is there, go on to extension_project_create with project '${ctx.workspace}/<project>'; only if it is not, call extension_workspace_create again.`,
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
      body: JSON.stringify({
        displayName: String(ctx.args.displayName || ctx.workspace).trim(),
        description: String(ctx.args.description || "").trim(),
        developerUrl: String(ctx.args.developerUrl || "").trim(),
      }),
    });
  } catch (err: any) {
    return unconfirmed(
      `The create request for workspace ${ctx.workspace} left this machine and no answer came back (${err?.message || err})`,
      "E_NETWORK",
    );
  }

  let text: string;
  try {
    text = await res.text();
  } catch (err: any) {
    return unconfirmed(
      `The platform answered ${res.status} for workspace ${ctx.workspace} and the answer could not be read (${err?.message || err})`,
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
    if (sawPlatformHold(res, data)) {
      return platformHoldEnvelope({
        command: COMMAND,
        name: "CreateHeld",
        body: data,
        value: { workspace: ctx.workspace },
      });
    }
    if (code === "CLI_WORKSPACE_CREATE_DISABLED") {
      return fail(
        "CreateClosed",
        String(data.message || "Headless workspace creation is not open yet."),
        "lane-closed",
        "E_PLATFORM",
        laneClosedHint(),
      );
    }
    if (code === "WORKSPACE_EXISTS" || code === "WORKSPACE_SLUG_RESERVED") {
      return envelope({
        ok: false,
        command: COMMAND,
        status: "workspace-exists",
        error: {
          code: "E_PLATFORM",
          message: String(data.message || `Workspace '${ctx.workspace}' cannot be created.`),
        },
        hint:
          code === "WORKSPACE_EXISTS"
            ? `Run extension_project_create with project '${ctx.workspace}/<project>' instead.`
            : "Pick a different slug and run the tool again.",
      });
    }
    if (answerIsUnknownOutcome(res.status, data)) {
      return unconfirmed(
        `The create request for workspace ${ctx.workspace} got a ${res.status} with no platform code, which is an answer from in front of the platform while the create may still be running`,
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

  const createdAnswer = readCreatedWorkspace(data);
  if (!createdAnswer.ok) {
    return unconfirmed(
      `The platform answered ${res.status} for workspace ${ctx.workspace} but ${createdAnswer.why}`,
      "E_PLATFORM",
    );
  }
  const finalSlug = createdAnswer.slug;
  const owner = String(data.ownerGithubLogin || grant.ownerGithubLogin || "");
  return envelope({
    ok: true,
    command: COMMAND,
    status: "created",
    value: {
      workspaceSlug: finalSlug,
      workspaceId: createdAnswer.id,
      displayName: data.displayName ?? finalSlug,
      ownerGithubLogin: owner || null,
      consoleUrl: `${consoleBase()}/${encodeURIComponent(finalSlug)}`,
      nextSteps: [
        `extension_project_create (project: '${finalSlug}/<project>', repo: '<owner>/<repo>')`,
      ],
    },
    hint: `Workspace ${finalSlug} exists${owner ? `, owned by ${owner}` : ""}. The grant is now spent and nothing was stored on this machine. If ${owner || "the approver"} is not who you meant to own it, stop here: ownership follows the GitHub account that approved the code. Next: extension_project_create with project '${finalSlug}/<project>'.`,
  });
}
