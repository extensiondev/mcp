// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { UserlandProjectPage } from "@extension.dev/urls/userland";

import { WAIT_SECONDS_INPUT, dispatchedHint, madeSentence, stampNow, text as plain } from "../lib/act-outcome";
import { API_BASE } from "../lib/common-schema";
import { awaitPromoteRecord, promoteLinks, releasesPage, unknownBuildEnrichment } from "../lib/promote-record";
import { resolveCredential } from "../lib/credential-source";
import { envelope, type ErrorCode } from "../lib/envelope";
import { PROJECT_TOKEN_INPUT, noStoredLoginHint } from "../lib/credentials";
import { resolveApiBase, safeApiBase } from "../lib/login-flow";
import { platformFetch } from "../lib/platform-fetch";
import { platformHoldEnvelope, sawPlatformHold } from "../lib/platform-hold";
import {
  approvalGateEnabled,
  evaluateApproval,
  platformRequiresApproval,
  requestApprovalAfterRefusal,
} from "../lib/approval-gate";
import { spendNarration } from "../lib/allowance";
import { approvalRoundTrip } from "../lib/approval-outcome";
import {
  notarizationNotes,
  partialPromoteWarnings,
  readPromoteOutcome,
} from "../lib/promote-outcome";
import { userlandProjectUrl } from "../lib/registry";
import { cut, rollback, type ReleaseActArgs } from "./release-acts";
import { channelLinkFields, readVisibility } from "../lib/channel-link";
import { firefoxChannelFields, firefoxChannelSentence } from "../lib/firefox-update-url";

export const schema = {
  name: "extension_release_promote",
  description:
    "Promote a built extension to a release channel (stable, preview, beta) on extension.dev, headless: action promote (the default) points channel at buildId, cut opens a release pull request that bumps the manifest version, and rollback returns channel to the build it served before. A promote needs a token minted by a workspace owner and a workspace owner's approval of that exact promote, every time; cut and rollback need a workspace owner's approval of the exact act too: the first call runs the platform's checks and either refuses with the reason and the next step, asking nobody, or answers approval-required with the approval URL and the platform's own description of the act; the same call with approvalId then runs it once. It records the release on the platform and answers what the platform recorded in value.outcome and every link it made or touched in value.links (the release page, the channel link, the build page), waiting up to waitSeconds for the record: promoted only when the record confirms the channel at that build, promote-dispatched until then, promote-failed when the record reads failed, promoted-partially with warnings naming what did not happen (never repeat it whole), promote-unconfirmed when the platform's answer carried no result, so read extension_release_status before promoting again. Not for a store: that is extension_submit. Not for a tester link: that is extension_publish. The project comes from your stored login (extension_auth) or a release token in EXTENSION_DEV_TOKEN, minted under project settings, Access tokens; tokens live at most 7 days, so CI re-mints before expiry, and project picks one of several logins. Call extension_release_status for a valid buildId. On a public project a promote answers value.channelUrl, the channel link, which always opens the channel's newest build and never expires; on a public project, or a public channel, send testers the channel link; a build link from extension_publish opens one build and, on a private project, expires; a private project gets value.channelUrlWithheld instead.",
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
      waitSeconds: WAIT_SECONDS_INPUT,
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
  waitSeconds?: unknown;
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

  const sent = await platformFetch(
    url,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    },
    { kind: "dispatch" },
  );

  if (!sent.ok) return fail("ReleaseNetworkError", sent.unreached.message, "network-failed", "E_NETWORK");

  const res = sent.res;

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
    const answered = approvalId
      ? approvalRoundTrip({
          command: "extension_release_promote",
          platformCode: code ?? "",
          message: typeof data?.message === "string" ? data.message : "",
          approvalId,
          undone: "Nothing was promoted by this call.",
          api: args.api,
          value: { channel, buildId },
          stateRead: "extension_release_status",
        })
      : undefined;

    if (answered) return answered;

    const unknownBuild = res.status === 404 || code === "UNKNOWN_BUILD";
    const enrich = unknownBuild ? await unknownBuildEnrichment(credential.ref, args.api) : {};
    const hint = unknownBuild
      ? "Run extension_release_status to see this project's channels, their promoted shas, and recent builds."
      : (code && promoteRefusalHint(code)) || "";

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
  const visibility = promotedRef ? await readVisibility(promotedRef, args.api) : null;
  const channelLink = promotedRef
    ? channelLinkFields(promotedRef, visibility, channel, args.api)
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

  const acceptedAt = plain(data?.dispatchedAt) || stampNow();
  const waited = await awaitPromoteRecord({
    command: "extension_release_promote",
    project: args.project,
    api: args.api,
    channel,
    buildId,
    acceptedAt,
    waitSeconds: args.waitSeconds,
  });
  const releaseId = plain(waited.record?.id);
  const links = promoteLinks({
    command: "extension_release_promote",
    callArgs: { ...args, action: "promote" } as Record<string, unknown>,
    value: enriched,
    releaseId,
    channelUrl: enriched.channelUrl,
    publicBuildUrl,
  });
  const firefox = visibility === "public" ? firefoxChannelFields(promotedRef, channel, outcome.queuedBrowsers, args.api) : {};
  const made = [madeSentence(links), firefoxChannelSentence(firefox)].filter(Boolean).join(" ");
  const trackPage = links.find((link) => link.kind === "release")?.url ?? releasesPage(promotedRef, args.api);
  const value = { ...enriched, ...firefox, ...(releaseId ? { releaseId } : {}), outcome: waited.outcome, links };

  if (waited.failed) {
    return envelope({
      ok: false,
      command: "extension_release_promote",
      status: "promote-failed",
      value,
      error: { code: "E_PLATFORM", name: "PromoteFailed", message: `The platform's release record for ${channel} at build ${buildId} reads ${waited.outcome.status}, so the channel does not serve it.` },
      hint: `Read the release page for the failed step, fix the cause and promote again; ${statusRead} reads the record. ${made}`,
      warnings: [credential.note],
    });
  }

  if (outcome.state === "partial") {
    return envelope({
      ok: true,
      command: "extension_release_promote",
      status: waited.outcome.recorded ? "promoted-partially" : "promote-dispatched",
      value: {
        ...value,
        incomplete: {
          failedBrowsers: outcome.failedBrowsers,
          pendingMirrors: outcome.pendingMirrors,
          githubReleaseFailed: outcome.githubReleaseFailed,
          githubReleaseAssetErrors: outcome.githubReleaseAssetErrors,
        },
      },
      hint: `${
        waited.outcome.recorded
          ? `The platform's release record for ${channel} reads ${waited.outcome.status} for ${outcome.queuedBrowsers.join(", ")}, and part of this promote did not happen: read the warnings.`
          : `${dispatchedHint({ acceptedAt, trackUrl: trackPage, readCall: statusRead })} Part of this promote did not happen: read the warnings.`
      } Do not repeat the whole promote; confirm what ${channel} serves with ${statusRead}. ${made}`,
      warnings: [...partialPromoteWarnings(outcome, channel), credential.note],
    });
  }

  if (!waited.outcome.recorded) {
    return envelope({
      ok: true,
      command: "extension_release_promote",
      status: "promote-dispatched",
      value,
      hint: `${dispatchedHint({ acceptedAt, trackUrl: trackPage, readCall: statusRead })} The release workflow was dispatched for ${outcome.queuedBrowsers.join(", ")} toward the ${channel} channel at build ${buildId}. ${made}`,
      warnings: [...notarizationNotes(outcome.notarization), credential.note],
    });
  }

  return envelope({
    ok: true,
    command: "extension_release_promote",
    status: "promoted",
    value,
    hint: `The platform's release record confirms the ${channel} channel at build ${buildId} (${waited.outcome.status}) for ${outcome.queuedBrowsers.join(", ")}. ${statusRead} reads what the channel serves. ${made}`,
    warnings: [...notarizationNotes(outcome.notarization), credential.note],
  });
}
