// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { API_BASE } from "../lib/common-schema";
import { envelope, type ErrorCode } from "../lib/envelope";
import { resolveToken } from "../lib/publish";
import { resolveApiBase, safeApiBase } from "../lib/login-flow";
import { UserlandProjectPage } from "@extension.dev/urls/userland";
import { platformHoldEnvelope, sawPlatformHold } from "../lib/platform-hold";
import { evaluateApproval } from "../lib/approval-gate";
import { spendNarration } from "../lib/allowance";

import {
  consoleProjectUrl,
  fetchRegistryJson,
  parseChannels,
  registryFileUrl,
  resolveProjectRef,
  userlandProjectUrl,
} from "../lib/registry";

export const schema = {
  name: "extension_release_promote",
  description:
    "Promote a built extension to a release channel (stable, preview, beta, …) on extension.dev, headless. This WRITES: it is the only verb that changes what a channel points at. It is auth-gated by your stored login (extension_auth) or a release token in EXTENSION_DEV_TOKEN, minted and revoked under project settings, Access tokens. Tokens live at most 7 days, so CI must re-mint before expiry. The project comes from the token. Call extension_release_status to find a valid buildId. Cutting a version-bump PR is not available headlessly, because it writes to your source repo and needs an interactive login.",
  inputSchema: {
    type: "object" as const,
    properties: {
      buildId: {
        type: "string",
        description: "Build commit SHA to promote (a 7-char short SHA is fine)",
      },
      channel: {
        type: "string",
        description: "Target release channel, e.g. stable, preview, beta",
      },
      sourceChannel: {
        type: "string",
        description: "Channel to promote from (optional; inferred otherwise)",
      },
      browsers: {
        type: "array",
        items: { type: "string" },
        description:
          "Browsers to release (optional; auto-detected from the build)",
      },
      version: {
        type: "string",
        description: "Version label for the release (optional)",
      },
      releaseNotes: {
        type: "string",
        description: "Release notes markdown (optional)",
      },
      approvalId: {
        type: "string",
        description:
          "The approval handle returned by a prior approval-required response. Promoting changes what a public channel serves and is not reversible in place, so when the platform's approval gate is on this needs a human approval: call once without this to get an approval id and URL, have a human approve at extension.dev, then call again with the same id.",
      },
      api: API_BASE,
    },
    required: ["buildId", "channel"],
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

export async function handler(args: {
  buildId: string;
  channel: string;
  sourceChannel?: string;
  browsers?: string[];
  version?: string;
  releaseNotes?: string;
  approvalId?: string;
  api?: string;
}): Promise<string> {
  const token = resolveToken();
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
  const gate = await evaluateApproval({
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
  });
  if (gate.blocked) return gate.envelope;

  const body: Record<string, unknown> = { buildId, channel };
  if (gate.approvalId) body.approvalId = gate.approvalId;
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
    /* @invariant Held first: every other branch below enriches with a console
     * Builds URL, and console answers 503 while the hold is on. */
    if (sawPlatformHold(res, data)) {
      return platformHoldEnvelope({
        command: "extension_release_promote",
        name: "ReleaseHeld",
        body: data,
        api: args.api,
        value: { channel, buildId },
      });
    }
    const code = typeof data?.code === "string" ? data.code : undefined;
    const enrich: Record<string, unknown> = {};
    let hint = "";
    const ref = resolveProjectRef();

    if (res.status === 404 || code === "UNKNOWN_BUILD") {
      enrich.buildsPageUrl = consoleProjectUrl(ref, "builds", args.api);
      hint =
        "Run extension_release_status to see this project's channels, their promoted shas, and recent builds.";
      if (ref) {
        const channelsUrl = registryFileUrl(ref, "channels.json");
        const channelsRes = await fetchRegistryJson(channelsUrl, fetch, {
          ref,
          api: args.api,
        });
        if (channelsRes.ok) {
          const rows = parseChannels(channelsRes.json).filter((c) => c.sha);
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

  const promotedRef = resolveProjectRef();
  const publicChannelUrl = userlandProjectUrl(
    promotedRef,
    UserlandProjectPage.channel(channel),
    args.api,
  );
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
  const enriched =
    data && typeof data === "object" && !Array.isArray(data)
      ? {
          ...data,
          ...(publicChannelUrl ? { publicChannelUrl } : {}),
          ...(publicBuildUrl ? { publicBuildUrl } : {}),
          allowance,
        }
      : { platform: data, allowance };
  return envelope({
    ok: true,
    command: "extension_release_promote",
    status: "promoted",
    value: enriched,
  });
}
