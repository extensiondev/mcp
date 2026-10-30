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
  channelLinkFields,
  channelServing,
  readChannels,
} from "../lib/channel-link";
import {
  carriesRegistryToken,
  heldRunLine,
  longHeldLines,
  publishLinkFields,
  publishNotes,
  runCommandsOf,
  spokenDate,
  nameMismatchNote,
} from "../lib/publish-link";
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
import { channelBrowsers, firefoxChannelFields, firefoxChannelSentence } from "../lib/firefox-update-url";
import { fillFromBuildIndex } from "../lib/publish-build-index";
import { withPackageAddresses } from "../lib/publish-package-commands";
import { consoleProjectUrl } from "../lib/registry";

export const schema = {
  name: "extension_publish",
  description:
    "Publish a build of the logged-in project on extension.dev and answer the link to send testers, which opens a page with a download and a run command for each browser. Reach for this first whenever the ask is to share, publish, deploy, distribute, release or ship an extension, or to send it to testers. Not for a store: that is extension_submit. Not for a quick emulator link beside this one: that is extension_preview_web share:true. A project that does not exist on extension.dev yet starts with extension_project_create, then extension_auth. It records a share on the platform and answers what the platform recorded in value.outcome and every link it made or touched in value.links, waiting up to waitSeconds for the record and answering publish-dispatched until it confirms. There are two links. A build link opens one build, <workspace>.extension.dev/<project>/builds/<sha>, and on a private project expires after ttlHours (7 days by default). A channel link, <workspace>.extension.dev/<project>/channels/<channel>, always opens a channel's newest build and never expires; a public project gets one in value.channelUrl when a release channel serves the build. On a public project, or a public channel, send testers the channel link; otherwise send the build link and the date it stops working. A private project's channel link is withheld and value.channelUrlWithheld says why; visibility is set in the extension.dev project settings, not the GitHub repository. value.link is the link to send (kind, url, expiresAt, audience, renewBy), value.tellThem the message to send as written, value.trackUrl the console Share links page, value.artifacts the per-browser integrity read before the link is handed out, value.sharePage whether the page answers; a build whose every browser artifact failed is refused unless force is true, and while extension.dev is held the status is platform-held and tellThem adds the Chrome run command, which works now.",
  inputSchema: {
    type: "object" as const,
    properties: {
      project: PROJECT_TOKEN_INPUT,
      ttlHours: {
        type: "number",
        description:
          "Private-project build link lifetime in hours. Defaults to 7 days; ask for up to the plan's share window (30 days free, 365 Pro), up to 8760 here, and the platform cuts a longer ask back to the window. Ignored for public projects.",
      },
      buildSha: {
        type: "string",
        description:
          "Pin the URL to a build sha (7-40 hex chars). The platform rejects a sha missing from a readable build index; when its index cannot be read it echoes the sha back and a pin on a failed build is accepted, so value.buildSha is the platform's claim, not a verified build. extension_release_status lists the builds it knows.",
      },
      force: {
        type: "boolean",
        description:
          "Publish even when the platform's checks reject every browser's artifact of the build (integrity failed or the browser build failed). Without it such a build is refused with E_ARTIFACTS_UNVERIFIED; with it the link is minted and the answer still warns and names the failed browsers.",
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
  project?: string;
  ttlHours?: number;
  buildSha?: string;
  force?: boolean;
  waitSeconds?: unknown;
  api?: string;
}): Promise<string> {
  const credential = resolveCredential({
    project: args.project,
    api: args.api,
  });
  const token = credential.token;

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
    api: args.api,
    token,
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
  const nameNote = nameMismatchNote(
    data,
    credential.ref
      ? consoleProjectUrl(credential.ref, "project-settings", args.api)
      : null,
  );

  let channelNote: string | null = null;
  let serving: string | null = null;

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
      Object.assign(data, firefoxChannelFields(ref, serving, channelBrowsers(channels, serving, previewCommandsOf(data.previewCommands).map(([browser]) => browser)), args.api));
    }

    if (!serving) {
      channelNote = channels
        ? `No release channel serves build ${String(data.buildSha ?? "(none)")} yet, so no channelUrl is offered. Promote it with extension_release_promote for a link that follows the channel. ${CHANNEL_LINK_ADVICE}`
        : "The project's channels.json could not be read, so whether a release channel serves this build is unknown and no channelUrl is offered.";
    }
  } else if (ref) {
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
    channel: serving,
    ref,
    ttlHours: args.ttlHours,
    project: args.project,
    api: args.api,
  });
  Object.assign(data, linkFields);
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
  const short = Boolean(send.id) && !carriesRegistryToken(runs);
  const noBuild = data.buildSha == null;
  const noBuildNote = noBuild
    ? "This share serves NO build: the platform minted the link but named no build sha, which means the project has no successful build yet (or its build index could not be read). Anyone opening the link gets nothing to run. Build first (push a commit, or extension_build then a platform build), then publish again."
    : null;

  const sharePage =
    noBuild || !sendUrl ? null : await probeSharePage(String(sendUrl));
  const held = Boolean(sharePage?.held);
  const told = String(data.tellThem);

  if (held && sharePage) {
    const longLines = short ? null : longHeldLines(name, send, runs);

    data.tellThem = longLines
      ? told.replace(page, longLines)
      : `${told}\n${heldRunLine(runs)}`;

    data.sharePage = {
      url: sharePage.url,
      status: sharePage.status,
      retryAfter: sharePage.retryAfter,
      opensNow: false,
    };
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
    send.kind === "build" && send.id
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
      artifactNote,
      note,
      buildNote,
      nameNote,
      channelNote,
      credential.note,
    ],
    hint,
  });
}
