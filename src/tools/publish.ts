// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import {
  WAIT_SECONDS_INPUT,
  dispatchedHint,
  linksOf,
  madeSentence,
  stampNow,
} from "../lib/act-outcome";
import { API_BASE } from "../lib/common-schema";
import { resolveCredential } from "../lib/credential-source";
import { expiredLoginRefusal } from "../lib/login-expired";
import { shareLinks, shareOutcome } from "../lib/share-outcome";
import { envelope, type ErrorCode } from "../lib/envelope";
import { spendNarration } from "../lib/allowance";
import { publish } from "../lib/publish";
import {
  NO_TOKEN_MESSAGE,
  PROJECT_TOKEN_INPUT,
  noStoredLoginHint,
} from "../lib/credentials";
import {
  PLATFORM_HOLD_STATUS,
  platformHoldEnvelope,
} from "../lib/platform-hold";
import {
  CHANNEL_LINK_ADVICE,
  CHANNEL_NAME_INPUT,
  channelFillSentence,
  channelLinkFields,
  channelServesOf,
  channelShareNote,
  channelServing,
  readChannels,
} from "../lib/channel-link";
import {
  carriesRegistryToken,
  carriesShareToken,
  heldRunLine,
  longHeldLines,
  publishLinkFields,
  publishNotes,
  runCommandsOf,
  spokenDate,
  nameMismatchNote,
  shortenPageShas,
  type RunCommand,
} from "../lib/publish-link";
import { GRANT_QUERY } from "../lib/package-address";
import { probeSharePage } from "../lib/share-page-probe";
import { trackFields } from "../lib/track-url";
import {
  everyArtifactFailed,
  readBuildHealth,
  type BuildHealth,
} from "../lib/build-health";
import {
  applyArtifactHealth,
  refuseUnverified,
} from "../lib/publish-artifacts";
import { channelBrowsers, firefoxChannelFields, firefoxChannelSentence, servedOfAnswer } from "../lib/firefox-update-url";
import { fillFromBuildIndex } from "../lib/publish-build-index";
import { localizeExtensionName } from "../lib/publish-localized-name";
import { withPackageAddresses } from "../lib/publish-package-commands";
import { consoleProjectUrl } from "../lib/registry";
import { CAPTURE_BROWSERS } from "../lib/browser-captures";
import { SYNC_CAPTURES, syncCaptures } from "./publish-captures";

export const schema = {
  name: "extension_publish",
  description:
    "Publish a build on extension.dev: the link for testers, with a download and a run command for each browser; use it first to share or ship (no project yet: extension_project_create). On a public project, or a public channel, send testers the channel link (<workspace>.extension.dev/<project>/<channel>); a private build link expires.",
  inputSchema: {
    type: "object" as const,
    properties: {
      action: {
        type: "string",
        enum: ["publish", SYNC_CAPTURES],
        default: "publish",
        description:
          "publish (default): the link; sync-captures: captures/<browser>/*.png to build pages (approval).",
      },
      browsers: {
        type: "array",
        items: { type: "string", enum: [...CAPTURE_BROWSERS] },
        description: "sync-captures: browsers, one approval each.",
      },
      projectPath: {
        type: "string",
        description: "sync-captures: project root.",
      },
      approvalId: {
        type: "string",
        description: "sync-captures: approved approval id.",
      },
      project: PROJECT_TOKEN_INPUT,
      ttlHours: {
        type: "number",
        description:
          "Private link lifetime, hours (default 168).",
      },
      buildSha: {
        type: "string",
        description:
          "Build sha, 7 to 40 hex (an unreadable index echoes the sha back unverified); not with channel.",
      },
      channel: {
        type: "string",
        description:
          "Link a channel's newest build instead.",
      },
      force: {
        type: "boolean",
        description:
          "Publish despite failed checks.",
      },
      waitSeconds: WAIT_SECONDS_INPUT,
      api: API_BASE,
    },
    required: [],
  },
};

function previewCommandsOf(value: unknown): Array<[string, string]> {
  if (!value || typeof value !== "object") return [];

  return Object.entries(value as Record<string, unknown>)
    .filter(
      ([browser, command]) =>
        typeof browser === "string" &&
        browser.trim() !== "" &&
        typeof command === "string" &&
        command.startsWith("npx -y extension@latest preview "),
    )
    .map(([browser, command]) => [browser, command as string]);
}

function linkIsShort(send: { id: string | null }, url: string, runs: RunCommand[]): boolean {
  if (carriesRegistryToken(runs)) return false;
  if (send.id) return true;

  return !GRANT_QUERY.test(url) && !carriesShareToken(runs);
}

function sharePageField(args: {
  url: string;
  probe: { url: string; status: number; retryAfter: string | null } | null;
  held: boolean;
  outcome: { recorded: boolean; readProblem?: string };
}): Record<string, unknown> {
  const { probe, held, outcome } = args;

  if (!probe) return { url: args.url, status: null, retryAfter: null, opensNow: null, reason: "the page did not answer the probe within 4 seconds" };

  const base = { url: probe.url, status: probe.status, retryAfter: probe.retryAfter };

  if (held || probe.status >= 400) return { ...base, opensNow: false };
  if (outcome.recorded) return { ...base, opensNow: true };

  return { ...base, opensNow: null, reason: outcome.readProblem ?? "the share record was not read back, so the grant behind the page is unproven" };
}

function fail(
  name: string,
  message: string,
  status: string,
  code: ErrorCode,
): string {
  return envelope({
    ok: false,
    command: "extension_publish",
    status,
    error: { code, name, message },
  });
}

export async function handler(args: {
  action?: string;
  browsers?: unknown;
  projectPath?: string;
  approvalId?: string;
  project?: string;
  ttlHours?: number;
  buildSha?: string;
  channel?: string;
  force?: boolean;
  waitSeconds?: unknown;
  api?: string;
}): Promise<string> {
  const action = String(args.action ?? "publish").trim().toLowerCase() || "publish";

  if (action === SYNC_CAPTURES) return syncCaptures(args);

  if (action !== "publish") {
    return fail("PublishBadRequest", `action must be publish or ${SYNC_CAPTURES}; got "${String(args.action)}".`, "bad-request", "E_BAD_REQUEST");
  }

  const credential = resolveCredential({
    project: args.project,
    api: args.api,
  });
  const token = credential.token;

  if (!token && credential.expired) {
    return expiredLoginRefusal({ command: "extension_publish", expired: credential.expired, api: args.api, extra: { action: "publish" } });
  }

  if (!token && args.project) {
    return fail(
      "PublishAuthError",
      noStoredLoginHint(args.project),
      "auth-required",
      "E_AUTH_REQUIRED",
    );
  }

  if (!token) {
    return fail(
      "PublishAuthError",
      NO_TOKEN_MESSAGE,
      "auth-required",
      "E_AUTH_REQUIRED",
    );
  }

  if (args.ttlHours != null) {
    const t = Number(args.ttlHours);

    if (!Number.isInteger(t) || t < 1 || t > 8760) {
      return fail(
        "PublishBadRequest",
        "ttlHours must be an integer between 1 and 8760 (365 days); the platform cuts a longer ask back to the plan's share window.",
        "bad-request",
        "E_BAD_REQUEST",
      );
    }
  }

  if (args.buildSha != null && args.buildSha !== "") {
    if (!/^[0-9a-f]{7,40}$/i.test(args.buildSha)) {
      return fail(
        "PublishBadRequest",
        "buildSha must be a 7-40 character hex git sha.",
        "bad-request",
        "E_BAD_REQUEST",
      );
    }
  }

  const channelArg = args.channel === undefined || args.channel === null ? "" : args.channel;

  if (args.channel !== undefined && args.channel !== null && (typeof channelArg !== "string" || !CHANNEL_NAME_INPUT.test(channelArg))) {
    return fail(
      "PublishBadRequest",
      "channel must name one of the project's release channels, lowercase letters, digits and dashes, like preview or stable.",
      "bad-request",
      "E_BAD_REQUEST",
    );
  }

  if (channelArg && args.buildSha) {
    return fail(
      "PublishBadRequest",
      "Send channel for a link that follows the channel's newest build, or buildSha for a link to one build, not both.",
      "bad-request",
      "E_BAD_REQUEST",
    );
  }

  const force = args.force === true;
  let health: BuildHealth | null = null;

  if (args.buildSha) {
    health = await readBuildHealth({
      command: "extension_publish",
      buildId: args.buildSha,
      project: args.project,
      api: args.api,
    });

    if (health.checked && everyArtifactFailed(health) && !force) {
      return refuseUnverified(health, args, null, credential.ref);
    }
  }

  const result = await publish({
    ttlHours: args.ttlHours,
    buildSha: args.buildSha,
    ...(channelArg ? { channel: channelArg } : {}),
    api: args.api,
    token,
    ref: credential.ref,
  });

  if (!result.ok) {
    if (result.held) {
      return platformHoldEnvelope({
        command: "extension_publish",
        name: result.error.name,
        body: result.body,
        api: args.api,
      });
    }

    const code = (result.error as { code?: string }).code;

    if (code === "NO_BUILD_TO_SHARE") {
      return envelope({
        ok: false,
        command: "extension_publish",
        status: "no-build-to-share",
        error: {
          code: "E_PLATFORM",
          name: "PublishError",
          message: result.error.message,
          platformCode: code,
        },
        hint: "This private project has no completed build yet, so there is no build link to make: a build link opens one build. Push a commit or start one with extension_builds (action: 'rebuild'), then publish again once extension_builds lists it as successful.",
      });
    }

    if (code === "CHANNEL_NOT_FOUND" || code === "CHANNEL_HAS_NO_BUILD") {
      return envelope({
        ok: false,
        command: "extension_publish",
        status: code === "CHANNEL_NOT_FOUND" ? "channel-unknown" : "channel-has-no-build",
        error: {
          code: "E_PLATFORM",
          name: "PublishError",
          message: result.error.message,
          platformCode: code,
        },
        hint:
          code === "CHANNEL_NOT_FOUND"
            ? `The project has no release channel named ${channelArg}, so no link was minted. extension_release_status (include: ['releases']${args.project ? `, project: '${args.project}'` : ""}) lists the channels it has.`
            : `Channel ${channelArg} serves no build yet, so its link would open nothing and none was minted. extension_release_status (include: ['releases']) value.channels predicts this: a channel whose sha is empty serves nothing, and its source says how it fills. ${channelFillSentence(channelArg)}`,
      });
    }

    if (code === "UNKNOWN_BUILD") {
      return envelope({
        ok: false,
        command: "extension_publish",
        status: "build-unknown",
        error: {
          code: "E_PLATFORM",
          name: "PublishError",
          message: result.error.message,
          platformCode: code,
        },
        hint: `The platform has no completed build for buildSha ${String(args.buildSha ?? "")}, so no share was minted. extension_release_status (include: ['releases']${
          args.project ? `, project: '${args.project}'` : ""
        }) lists the shas it does have; omit buildSha to share the newest successful build.`,
      });
    }

    const projectMissing =
      code === "PROJECT_NOT_FOUND" ||
      (code === undefined && /\(404\)/.test(result.error.message));

    return envelope({
      ok: false,
      command: "extension_publish",
      status: "publish-failed",
      error: {
        code: "E_PLATFORM",
        name: result.error.name,
        message: result.error.message,
      },
      ...(projectMissing
        ? {
            hint: "The token's project does not exist on the host this call targeted. Run extension_auth (action: status) to see which workspace/project the token is scoped to, create that project first (import a repo or a template at extension.dev/new), or run extension_auth (action: login) against a project that exists there.",
          }
        : {}),
    });
  }

  const data = result.data as Record<string, unknown>;

  if (typeof data.shareUrl !== "string" || !data.shareUrl.trim()) {
    return envelope({
      ok: false,
      command: "extension_publish",
      status: "publish-unconfirmed",
      error: {
        code: "E_PLATFORM",
        name: "PublishUnconfirmed",
        message:
          "The platform answered the publish but named no share URL, so whether a share was minted is unknown.",
      },
      value: { platform: data },
      hint: `Do not publish again blind: a build link that was minted counts against the project's live shares. The console Settings, Share links section${
        credential.ref
          ? ` (${consoleProjectUrl(credential.ref, "settings/share-links", args.api)})`
          : ""
      } lists the build links minted for this project with their expiry; check it, then publish again only if none appeared.`,
    });
  }

  delete data.token;
  shortenPageShas(data);

  if (!health && typeof data.buildSha === "string" && data.buildSha.trim()) {
    health = await readBuildHealth({
      command: "extension_publish",
      buildId: data.buildSha.trim(),
      project: args.project,
      api: args.api,
    });

    if (health.checked && everyArtifactFailed(health) && !force) {
      return refuseUnverified(
        health,
        args,
        {
          settingsUrl: credential.ref
            ? consoleProjectUrl(
                credential.ref,
                "settings/share-links",
                args.api,
              )
            : null,
        },
        credential.ref,
      );
    }
  }

  let note: string | null = null;

  if (args.ttlHours != null && data.visibility === "public") {
    note =
      "ttlHours was ignored: this is a public project, so its build link never expires.";
  }

  const ref = credential.ref;
  const buildNote = await fillFromBuildIndex(
    data,
    args.buildSha,
    ref,
    args.api,
  );
  const nameNote = (await localizeExtensionName(data, args)) ?? nameMismatchNote(
    data,
    credential.ref
      ? consoleProjectUrl(credential.ref, "project-settings", args.api)
      : null,
  );

  let channelNote: string | null = null;
  let serving: string | null = null;
  const platformKind = data.link && typeof data.link === "object" ? (data.link as Record<string, unknown>).kind : null;
  const channelShare = data.visibility !== "public" && platformKind === "channel";

  if (ref && data.visibility === "public") {
    const channels = await readChannels(ref, args.api);
    serving =
      channels && typeof data.buildSha === "string"
        ? channelServing(channels, data.buildSha)
        : null;

    Object.assign(
      data,
      channelLinkFields(ref, data.visibility, serving, args.api),
    );

    if (serving && channels) {
      Object.assign(data, firefoxChannelFields(ref, serving, channelBrowsers(channels, serving, previewCommandsOf(data.previewCommands).map(([browser]) => browser)), args.api, servedOfAnswer(data)));
    }

    if (!serving) {
      channelNote = channels
        ? `No release channel serves build ${String(data.buildSha ?? "(none)")} yet, so no channelUrl is offered. Promote it with extension_release_promote for a link that follows the channel. ${CHANNEL_LINK_ADVICE}`
        : "The project's channels.json could not be read, so whether a release channel serves this build is unknown and no channelUrl is offered.";
    }
  } else if (ref && !channelShare) {
    Object.assign(
      data,
      channelLinkFields(ref, data.visibility, null, args.api),
    );
  }

  const {
    sendUrl,
    pageLine: page,
    name,
    send,
    ...linkFields
  } = publishLinkFields({
    data,
    channel: serving ?? (channelArg || null),
    ref,
    ttlHours: args.ttlHours,
    project: args.project,
    api: args.api,
  });
  Object.assign(data, linkFields);
  data.link = send;
  withPackageAddresses(data, ref, send.id, args.api);

  data.allowance = spendNarration({
    what: "This publish",
    body: data,
    api: args.api,
  });

  const { note: artifactNote, failed } = applyArtifactHealth(data, health);
  const previewCommands = previewCommandsOf(data.previewCommands).filter(
    ([browser]) => !failed.has(browser.toLowerCase()),
  );
  const runs = runCommandsOf(previewCommands);
  const short = linkIsShort(send, String(sendUrl ?? ""), runs);
  const noBuild = data.buildSha == null;
  const noBuildNote = noBuild
    ? "This share serves NO build: the platform minted the link but named no build sha, which means the project has no successful build yet (or its build index could not be read). Anyone opening the link gets nothing to run. Build first (push a commit, or extension_build then a platform build), then publish again."
    : null;

  const sharePage =
    noBuild || !sendUrl ? null : await probeSharePage(String(sendUrl));
  const held = Boolean(sharePage?.held);
  const told = String(data.tellThem);

  const pageNote =
    sharePage && !held && sharePage.status >= 400
      ? `The share page ${sharePage.url} answered ${sharePage.status} when this tool opened it, so do not send it until it opens; the run commands in value.previewCommands work on their own.`
      : null;

  if (held && sharePage) {
    const longLines = short ? null : longHeldLines(name, send, runs);

    data.tellThem = longLines
      ? told.replace(page, longLines)
      : `${told}\n${heldRunLine(runs)}`;
  }

  const track = trackFields("extension_publish", {
    args: { ...args },
    status: held ? PLATFORM_HOLD_STATUS : "published",
    value: data,
  });
  const shareLinksUrl = track?.trackUrl ?? null;

  data.notes = publishNotes({ data, runs, short, held, shareLinksUrl });

  if (track) Object.assign(data, track);

  const acceptedAt = stampNow();
  const isPublic = data.visibility === "public";
  const shareId =
    (send.kind === "build" || send.kind === "channel") && send.id
      ? String(send.id)
      : typeof data.shareId === "string"
        ? data.shareId
        : "";
  const { outcome, expiresAt: recordedExpiry } = await shareOutcome({
    data,
    ref,
    shareId,
    noBuild,
    waitSeconds: args.waitSeconds,
    api: args.api,
  });
  if (recordedExpiry && data.expiresAt == null) data.expiresAt = recordedExpiry;

  const links = linksOf(shareLinks(data, track, !isPublic && !noBuild));
  data.outcome = outcome;
  data.links = links;

  /* @invariant EVERY PUBLISH THAT SERVES A BUILD SAYS WHETHER ITS PAGE
   * OPENS. value.sharePage used to appear only while the platform held the
   * page, so an answer with no sharePage read as "the page opens" when the
   * probe had not run, had not answered, or had answered an error (ledger
   * 435). It is present whenever a page was handed out. opensNow is true only
   * when the page answered under 400 AND the share record read back under the
   * short sha the page rewrites to, which is the exchange the page's own
   * script makes for a signed-out visitor; false when the page is held or
   * answered an error; null, with the reason, when the page or the record did
   * not answer in time, since an unread grant is not a proven one. */
  if (!noBuild && sendUrl) {
    data.sharePage = sharePageField({ url: String(sendUrl), probe: sharePage, held, outcome });
  }

  const made = madeSentence(links);
  const unconfirmed =
    !outcome.recorded && !noBuild
      ? dispatchedHint({
          acceptedAt,
          trackUrl: track?.trackUrl ?? String(sendUrl ?? ""),
          readHow:
            "the link itself reads it: a page that opens is a recorded share, and not found means the record is not there",
        })
      : null;
  const watch = track
    ? `Watch it at ${track.trackUrl}${track.trackLinks?.[1] ? `, and the build at ${track.trackLinks[1]}` : ""}.`
    : null;
  const what =
    noBuild || !sendUrl
      ? "Do not send this link: it serves no build yet."
      : held
        ? short
          ? "Send value.tellThem to the person as written; the page is on hold until extension.dev opens, so it carries the Chrome run command."
          : "Send value.tellThem to the person as written; the page is on hold, so it carries the Chrome run command, which is long because the platform has not minted a short link yet."
        : short
          ? "Send value.tellThem to the person as written."
          : "Send value.tellThem to the person as written; its link is long because the platform has not minted a short one yet.";
  const hint = [unconfirmed, what, watch, made, firefoxChannelSentence(data)].filter(Boolean).join(" ");
  const servesNote = (() => {
    if (!channelShare) return null;

    const serves = channelServesOf((data.link as Record<string, unknown>).serves);
    const ends = typeof data.expiresAt === "string" && data.expiresAt ? spokenDate(data.expiresAt) : null;

    return serves ? channelShareNote(serves, ends) : null;
  })();
  const channelIgnored =
    channelArg && platformKind !== "channel"
      ? `You asked for channel ${channelArg}, but the platform answered a build link, not a channel link: it does not mint channel links for this project yet, so this address opens one build and changes with the next build. Do not put it on a site as the lasting address.`
      : null;

  if (held && sharePage) {
    const answer = `${sharePage.status}${sharePage.retryAfter ? `, retry-after ${sharePage.retryAfter}` : ""}`;
    const expiresAt =
      typeof data.expiresAt === "string" && data.expiresAt
        ? data.expiresAt
        : null;
    const until = expiresAt ? ` until ${spokenDate(expiresAt)}` : "";

    return envelope({
      ok: true,
      command: "extension_publish",
      status: PLATFORM_HOLD_STATUS,
      value: data,
      warnings: [
        `The share page ${sharePage.url} answers the platform's hold page (${answer}) while extension.dev is not open to the public, so do not tell anyone to open it yet. What works now: ${
          runs.length
            ? "the run commands in value.previewCommands"
            : "nothing this link serves; the build has no run command"
        }. What does not: the share page, until the platform opens. The link is minted${until ? ` and stays valid${until}` : ""}, and the same page opens once the platform does.`,
        artifactNote,
        note,
        buildNote,
        nameNote,
        channelNote,
        servesNote,
        channelIgnored,
        credential.note,
      ],
      hint,
    });
  }

  return envelope({
    ok: true,
    command: "extension_publish",
    status: noBuild
      ? "published-without-build"
      : outcome.recorded
        ? "published"
        : "publish-dispatched",
    value: data,
    warnings: [
      noBuildNote,
      pageNote,
      artifactNote,
      note,
      buildNote,
      nameNote,
      channelNote,
      servesNote,
      channelIgnored,
      credential.note,
    ],
    hint,
  });
}
