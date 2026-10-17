// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { UserlandProjectPage } from "@extension.dev/urls/userland";

import { API_BASE } from "../lib/common-schema";
import { resolveCredential } from "../lib/credential-source";
import { envelope, type ErrorCode } from "../lib/envelope";
import { PROJECT_TOKEN_INPUT, noStoredLoginHint } from "../lib/credentials";
import { resolveApiBase, safeApiBase } from "../lib/login-flow";
import { platformHoldEnvelope, sawPlatformHold } from "../lib/platform-hold";
import {
  approvalGateEnabled,
  evaluateApproval,
  platformRequiresApproval,
  requestApprovalAfterRefusal,
} from "../lib/approval-gate";
import { spendNarration } from "../lib/allowance";
import {
  notarizationNotes,
  partialPromoteWarnings,
  readPromoteOutcome,
} from "../lib/promote-outcome";
import {
  consoleProjectUrl,
  fetchRegistryJson,
  parseChannels,
  registryFileUrl,
  userlandProjectUrl,
  channelsShapeProblem,
} from "../lib/registry";
import { cut, rollback, type ReleaseActArgs } from "./release-acts";
import { channelLinkFields, readVisibility } from "../lib/channel-link";

export const schema = {
  name: "extension_release_promote",
  description:
    "Promote a built extension to a release channel (stable, preview, beta, …) on extension.dev, headless. This WRITES: action:'promote' (the default) points channel at buildId, action:'cut' opens a release pull request in the project's source repository that bumps the manifest version (level patch, minor or major, or an exact version; optionally armed to release to channel when merged, with releaseNotes in its body), and action:'rollback' returns channel to the build it served before. A promote needs a token minted by a workspace owner and a workspace owner's approval of that exact promote, every time; cut and rollback need a workspace owner's approval of the exact act too. For all three the first call runs the platform's checks and either refuses with the reason and the next step, asking nobody, or answers approval-required with the approval URL and the platform's own description of the act; once approved, the same call with approvalId runs it once. It is auth-gated by your stored login (extension_auth) or a release token in EXTENSION_DEV_TOKEN, minted and revoked under project settings, Access tokens. Tokens live at most 7 days, so CI must re-mint before expiry. The project comes from the token; with several logins stored, `project` picks which one. Call extension_release_status to find a valid buildId. The status is 'promoted' only when the platform says every asked browser's release was dispatched and the channel pointer moved; 'promoted-partially' lists in its warnings what did not happen (a browser whose dispatch failed, a channel pointer that was not moved) and must not be repeated whole; 'promote-unconfirmed' means the platform's answer did not carry the result, so read extension_release_status before promoting again. On a public project a promote answers value.channelUrl, the channel's link, which always resolves to its current build. Send testers the channel link so they always get the newest build; the build page link pins one build. A private project gets value.channelUrlWithheld instead.",
  inputSchema: {
    type: "object" as const,
    properties: {
      action: {
        type: "string",
        enum: ["promote", "cut", "rollback"],
        default: "promote",
        description:
          "promote (the default) points channel at buildId; cut opens a release pull request that bumps the manifest version; rollback returns channel to the build it served before.",
      },
      project: PROJECT_TOKEN_INPUT,
      buildId: {
        type: "string",
        description: "Build commit SHA to promote (a 7-char short SHA is fine)",
      },
      channel: {
        type: "string",
        description:
          "Target release channel, e.g. stable, preview, beta. With cut, the channel the pull request releases to when merged (optional); with rollback, the channel to roll back.",
      },
      level: {
        type: "string",
        enum: ["patch", "minor", "major"],
        description: "With cut, how far to bump the manifest version (default patch). A version, when passed, decides the bump instead.",
      },
      sourceChannel: {
        type: "string",
        description: "Channel to promote from (optional; inferred otherwise)",
      },
      browsers: {
        type: "array",
        items: { type: "string" },
        description:
          "Browsers to release. Optional: when omitted the platform reads the build's browsers from its index, and falls back to chrome alone when that index cannot be read, so pass them to be sure.",
      },
      version: {
        type: "string",
        description: "Version label for the release (optional). With cut, the exact manifest version to bump to, above the current one.",
      },
      releaseNotes: {
        type: "string",
        description: "Release notes markdown (optional). With cut, the notes written into the pull request body.",
      },
      approvalId: {
        type: "string",
        description:
          "The approval handle returned by a prior approval-required response. Promoting changes what a public channel serves and is not reversible in place, so every promote needs a workspace owner's approval: call once without this to get an approval id and URL, have a human approve at extension.dev, then call again with the same id.",
      },
      api: API_BASE,
    },
    required: [],
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
    command: "extension_release_promote",
    status,
    error: { code, name, message },
  });
}

function promoteRefusalHint(platformCode: string): string | undefined {
  if (platformCode === "APPROVER_NOT_OWNER") {
    return "A promote needs a workspace owner's approval, and whoever approved this one is not an owner of the workspace now, so it was not used and nothing was promoted. Call again without approvalId to request a fresh approval, then have a workspace owner approve it.";
  }

  if (platformCode !== "BUILD_ENV_MISMATCH" && platformCode !== "UNSTAMPED_BUILD_BLOCKED") {
    return undefined;
  }

  return "Each channel serves builds made for one environment: stable takes production builds and the other channels take staging builds. No tool here starts a production build, so rebuild this commit with environment production in the console (Builds, Rebuild), wait for it to pass, then promote it again. To ship this build as it is, promote it to a preview channel instead.";
}

export async function handler(args: ReleaseActArgs & {
  buildId?: string;
  channel?: string;
  sourceChannel?: string;
  browsers?: string[];
  version?: string;
  releaseNotes?: string;
  approvalId?: string;
  api?: string;
  project?: string;
}): Promise<string> {
  if (args.action === "cut") return cut(args);
  if (args.action === "rollback") return rollback(args);

  if (args.action !== undefined && args.action !== "promote") {
    return fail("ReleaseInputError", `action must be promote, cut or rollback; got "${args.action}". Nothing was sent.`, "bad-request", "E_BAD_REQUEST");
  }

  const credential = resolveCredential({ project: args.project, api: args.api });
  const token = credential.token;

  if (!token && args.project) {
    return fail("PromoteAuthError", noStoredLoginHint(args.project), "auth-required", "E_AUTH_REQUIRED");
  }

  if (!token) {
    return fail(
      "ReleaseAuthError",
      "No token. Set EXTENSION_DEV_TOKEN to a release token (create one in the extension.dev dashboard under project settings -> Access tokens; tokens live at most 7 days, so CI must re-mint before expiry), or run extension_auth (action: login).",
      "auth-required",
      "E_AUTH_REQUIRED",
    );
  }

  const buildId = String(args.buildId || "").trim();
  const channel = String(args.channel || "").trim();

  if (!buildId || !channel) {
    return fail(
      "ReleaseInputError",
      "buildId and channel are required.",
      "bad-request",
      "E_BAD_REQUEST",
    );
  }

  const apiCheck = safeApiBase(resolveApiBase(args.api), args.api);

  if (!apiCheck.ok) {
    return fail(
      "ReleaseConfigError",
      apiCheck.message,
      "bad-config",
      "E_CONFIG",
    );
  }

  const url = `${apiCheck.base}/api/cli/release/promote`;

  const sourceChannel = args.sourceChannel
    ? String(args.sourceChannel).trim()
    : "";
  const gateBrowsers = (Array.isArray(args.browsers) ? args.browsers : [])
    .map((b) => String(b).trim())
    .filter(Boolean);
  const gateInput = {
    command: "extension_release_promote",
    action: "extension_release_promote",
    scope: {
      buildId: buildId.toLowerCase(),
      channel,
      ...(sourceChannel ? { sourceChannel } : {}),
      ...(gateBrowsers.length ? { browsers: [...gateBrowsers].sort() } : {}),
    },
    description: `Promote build ${buildId} to the ${channel} channel, changing what ${channel} serves.`,
    approvalId: args.approvalId,
    token,
    api: args.api,
    refusedStatus: "promote-failed",
    refusalHint: promoteRefusalHint,
    irreversible: true,
  };
  const gate = await evaluateApproval({
    ...gateInput,
    enabled: approvalGateEnabled(channel === "stable"),
  });
  if (gate.blocked) return gate.envelope;

  const body: Record<string, unknown> = { buildId, channel };
  const approvalId = gate.approvalId ?? (args.approvalId ? String(args.approvalId).trim() : "");
  if (approvalId) body.approvalId = approvalId;
  if (args.sourceChannel) body.sourceChannel = String(args.sourceChannel).trim();

  if (Array.isArray(args.browsers) && args.browsers.length) {
    body.browsers = args.browsers.map((b) => String(b).trim()).filter(Boolean);
  }

  if (args.version) body.version = String(args.version).trim();
  if (args.releaseNotes) body.releaseNotes = String(args.releaseNotes);

  let res: Response;

  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
  } catch (err: any) {
    return fail(
      "ReleaseNetworkError",
      `Could not reach ${url}: ${err?.message || err}`,
      "network-failed",
      "E_NETWORK",
    );
  }

  const text = await res.text();
  let data: any;

  try {
    data = JSON.parse(text);
  } catch {
    data = { message: text };
  }

  if (!res.ok) {
    if (sawPlatformHold(res, data)) {
      return platformHoldEnvelope({
        command: "extension_release_promote",
        name: "ReleaseHeld",
        body: data,
        api: args.api,
        value: { channel, buildId },
      });
    }

    if (!args.approvalId && platformRequiresApproval(res, data)) {
      return requestApprovalAfterRefusal(gateInput);
    }

    const code = typeof data?.code === "string" ? data.code : undefined;
    const enrich: Record<string, unknown> = {};
    let hint = (code && promoteRefusalHint(code)) || "";
    const ref = credential.ref;

    if (res.status === 404 || code === "UNKNOWN_BUILD") {
      enrich.buildsPageUrl = consoleProjectUrl(ref, "builds", args.api);
      hint =
        "Run extension_release_status to see this project's channels, their promoted shas, and recent builds.";

      if (ref) {
        const channelsUrl = registryFileUrl(ref, "channels.json", args.api);
        const channelsRes = await fetchRegistryJson(channelsUrl, fetch, {
          ref,
          api: args.api,
        });

        if (channelsRes.ok) {
          const rows = channelsShapeProblem(channelsRes.json) ? [] : parseChannels(channelsRes.json).filter((c) => c.sha);
          enrich.validChannelShas = Object.fromEntries(
            rows.map((c) => [c.channel, c.sha]),
          );

          enrich.registryChannelsUrl = channelsUrl;
        }
      }
    }

    return envelope({
      ok: false,
      command: "extension_release_promote",
      status: "promote-failed",
      error: {
        code: "E_PLATFORM",
        name: "ReleaseError",
        message: `promote failed (${res.status}): ${data?.message || text || "unknown error"}`,
        ...(code ? { platformCode: code } : {}),
      },
      value: enrich,
      hint,
    });
  }

  const promotedRef = credential.ref;
  const channelLink = promotedRef
    ? channelLinkFields(promotedRef, await readVisibility(promotedRef, args.api), channel, args.api)
    : {};
  const publicBuildUrl = userlandProjectUrl(
    promotedRef,
    UserlandProjectPage.build(buildId),
    args.api,
  );
  const allowance = spendNarration({
    what: "This promote",
    body: data,
    api: args.api,
  });
  const enriched: Record<string, unknown> =
    data && typeof data === "object" && !Array.isArray(data)
      ? {
          ...data,
          ...channelLink,
          ...(publicBuildUrl ? { publicBuildUrl } : {}),
          allowance,
        }
      : { platform: data, allowance };
  const outcome = readPromoteOutcome(data);
  const statusRead = `extension_release_status (include: ['releases']${
    args.project ? `, project: '${args.project}'` : ""
  })`;

  if (outcome.state === "unconfirmed") {
    return envelope({
      ok: false,
      command: "extension_release_promote",
      status: "promote-unconfirmed",
      error: {
        code: "E_PLATFORM",
        name: "PromoteUnconfirmed",
        message: `The platform answered ${res.status} but ${outcome.why}, so whether ${channel} now serves build ${buildId} is unknown.`,
      },
      value: { channel, buildId, platform: data },
      hint: `Do not promote again blind: a promote that did go through would be dispatched a second time. Read ${statusRead} and promote again only if ${channel} does not name ${buildId}.`,
    });
  }

  if (outcome.state === "partial") {
    return envelope({
      ok: true,
      command: "extension_release_promote",
      status: "promoted-partially",
      value: {
        ...enriched,
        incomplete: {
          failedBrowsers: outcome.failedBrowsers,
          pendingMirrors: outcome.pendingMirrors,
          githubReleaseFailed: outcome.githubReleaseFailed,
          githubReleaseAssetErrors: outcome.githubReleaseAssetErrors,
        },
      },
      hint: `The release workflow was dispatched for ${outcome.queuedBrowsers.join(", ")}, and part of this promote did not happen: read the warnings. Do not repeat the whole promote; confirm what ${channel} serves with ${statusRead}.`,
      warnings: [...partialPromoteWarnings(outcome, channel), credential.note],
    });
  }

  return envelope({
    ok: true,
    command: "extension_release_promote",
    status: "promoted",
    value: enriched,
    hint: `The platform dispatched the release workflow for ${outcome.queuedBrowsers.join(", ")} and moved the ${channel} channel pointer to build ${buildId}. The artifacts land when that workflow finishes; ${statusRead} reads what the channel serves.`,
    warnings: [...notarizationNotes(outcome.notarization), credential.note],
  });
}
