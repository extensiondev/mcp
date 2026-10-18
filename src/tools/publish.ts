// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { API_BASE } from "../lib/common-schema";
import { resolveCredential } from "../lib/credential-source";
import { envelope, type ErrorCode } from "../lib/envelope";
import { spendNarration } from "../lib/allowance";
import { publish } from "../lib/publish";
import { NO_TOKEN_MESSAGE, PROJECT_TOKEN_INPUT, noStoredLoginHint } from "../lib/credentials";
import { platformHoldEnvelope } from "../lib/platform-hold";
import { CHANNEL_LINK_ADVICE, channelLinkFields, channelServing, readChannels } from "../lib/channel-link";
import { publishLinkFields } from "../lib/publish-link";
import {
  fetchRegistryJson,
  isSuccessfulBuild,
  parseBuildIndex,
  registryFileUrl,
  buildIndexShapeProblem,
} from "../lib/registry";

export const schema = {
  name: "extension_publish",
  description:
    "Publish a build of the project your stored token is scoped to (extension_auth, or EXTENSION_DEV_TOKEN) on extension.dev, and return the link to send testers, which opens a page with a download and a run command for each browser. Reach for this first whenever the ask is to share, publish, deploy, distribute, release or ship an extension, or to send it to testers; extension_submit is the separate store-review path, and extension_preview_web share:true is a quick emulator link beside this one. An extension with no project on extension.dev yet starts with extension_project_create, which makes one from its GitHub repository, then extension_auth. The target is the token's project: there is no projectPath, and no local file is uploaded. With several logins stored, pass `project` ('<workspace>/<project>') to pick which one; it outranks EXTENSION_DEV_TOKEN. There are two links. A build link opens one build, <workspace>.extension.dev/<project>/builds/<sha> (pass buildSha, which extension_builds lists, or the newest successful build is linked); on a private project it carries a share token and expires, its lifetime ttlHours: 7 days by default, and up to the plan's share window (30 days free, 365 Pro) when asked. A channel link, <workspace>.extension.dev/<project>/channels/<channel>, always opens a channel's newest build and never expires; a public project gets one in value.channelUrl when a release channel serves the build, and later a public channel of a private project will too. On a public project, or a public channel, send testers the channel link; otherwise send the build link and tell them the date it stops working. A private project gets no channel link: value.channelUrlWithheld says why. A project's visibility is set in its extension.dev project settings, not its GitHub repository. In the answer, value.link is the link to send (kind build or channel, url, expiresAt as an ISO date or null, pointsAt, audience, scope, and renewBy, the call that mints a fresh one, on a private project), value.links lists every link this build has, value.tellThem is the sentence to say with it (the hint carries it too), value.clamped says the platform cut ttlHours back to the plan's window, and value.projectVisibility names where visibility is set and, on a private project, makeEvergreen, the console page that gives a link that never expires.",
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
  api?: string;
}): Promise<string> {
  const credential = resolveCredential({ project: args.project, api: args.api });
  const token = credential.token;

  if (!token && args.project) {
    return fail("PublishAuthError", noStoredLoginHint(args.project), "auth-required", "E_AUTH_REQUIRED");
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
      code === "PROJECT_NOT_FOUND" || (code === undefined && /\(404\)/.test(result.error.message));

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
            hint:
              "The token's project does not exist on the host this call targeted. Run extension_auth (action: status) to see which workspace/project the token is scoped to, create that project first (import a repo or a template at extension.dev/new), or run extension_auth (action: login) against a project that exists there.",
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
        message: "The platform answered the publish but named no share URL, so whether a share was minted is unknown.",
      },
      value: { platform: data },
      hint: `Do not publish again blind: a share that was minted counts against the project's live shares. Run extension_shares (action: list${
        args.project ? `, project: '${args.project}'` : ""
      }) to see whether one appeared, then publish again only if it did not.`,
    });
  }

  let note: string | null = null;

  if (args.ttlHours != null && data.visibility === "public") {
    note =
      "ttlHours was ignored: this is a public project, so its build link never expires.";
  }

  let buildNote: string | null = null;

  const ref = credential.ref;

  if (ref) {
    const buildsUrl = registryFileUrl(ref, "builds/index.json", args.api);
    const buildsRes = await fetchRegistryJson(buildsUrl, fetch, {
      ref,
      api: args.api,
    });

    if (buildsRes.ok && buildIndexShapeProblem(buildsRes.json)) {
      buildNote = `The project's build index at ${buildsUrl} answered but ${buildIndexShapeProblem(buildsRes.json)}, so buildSha, version and builtAt were not filled in from it.`;
    } else if (buildsRes.ok) {
      const items = parseBuildIndex(buildsRes.json);

      if (args.buildSha) {
        const pin = String(args.buildSha).toLowerCase();
        const pinned = items.find((item) => {
          const sha = item.sha.toLowerCase();
          const commit = String(item.commit ?? "").toLowerCase();

          return (
            sha.startsWith(pin) ||
            pin.startsWith(sha) ||
            (commit !== "" && (commit.startsWith(pin) || pin.startsWith(commit)))
          );
        });

        if (pinned) {
          if (data.buildSha == null) data.buildSha = pinned.sha;

          if (data.builtAt == null && pinned.timestamp)
            {data.builtAt = pinned.timestamp;}

          if (data.version == null && pinned.version)
            {data.version = pinned.version;}

          if (data.channel == null && pinned.channel)
            {data.channel = pinned.channel;}

          data.registryUrl = buildsUrl;
        } else {
          if (data.buildSha == null) data.buildSha = args.buildSha;

          data.registryUrl = buildsUrl;
          buildNote = `buildSha ${args.buildSha} is pinned but was not found in the project's registry build index, so builtAt/version/channel are not filled in from another build. The platform accepted the pin without reading its own index (it echoes the sha when the index is unreadable), so whether a build with that sha exists was not verified here.`;
        }
      } else {
        const newestSuccess = items
          .filter(isSuccessfulBuild)
          .sort((a, b) =>
            String(b.timestamp ?? "").localeCompare(String(a.timestamp ?? "")),
          )[0];
        const platformSha = typeof data.buildSha === "string" && data.buildSha ? String(data.buildSha).toLowerCase() : null;
        const served = platformSha
          ? items.find((item) => item.sha.toLowerCase().startsWith(platformSha) || platformSha.startsWith(item.sha.toLowerCase()))
          : newestSuccess;

        if (served) {
          if (data.buildSha == null) data.buildSha = served.sha;
          if (data.builtAt == null && served.timestamp) data.builtAt = served.timestamp;
          if (data.version == null && served.version) data.version = served.version;
          if (data.channel == null && served.channel) data.channel = served.channel;

          data.registryUrl = buildsUrl;
          buildNote = platformSha
            ? `builtAt/version are read from the index row of build ${served.sha}, the build the platform says the link serves.`
            : "The platform named no build for this link; buildSha/builtAt/version describe the newest successful build in the project's registry index, which is what an unpinned link is expected to serve. Pin buildSha to serve a specific build.";
        } else if (platformSha) {
          data.registryUrl = buildsUrl;
          buildNote = `The platform says the link serves build ${data.buildSha}, which the project's registry index does not list, so builtAt and version were not filled in from another build.`;
        }
      }
    }
  }

  let channelNote: string | null = null;
  let serving: string | null = null;

  if (ref && data.visibility === "public") {
    const channels = await readChannels(ref, args.api);
    serving = channels && typeof data.buildSha === "string" ? channelServing(channels, data.buildSha) : null;
    Object.assign(data, channelLinkFields(ref, data.visibility, serving, args.api));

    if (!serving) {
      channelNote = channels
        ? `No release channel serves build ${String(data.buildSha ?? "(none)")} yet, so no channelUrl is offered. Promote it with extension_release_promote for a link that follows the channel. ${CHANNEL_LINK_ADVICE}`
        : "The project's channels.json could not be read, so whether a release channel serves this build is unknown and no channelUrl is offered.";
    }
  } else if (ref) {
    Object.assign(data, channelLinkFields(ref, data.visibility, null, args.api));
  }

  const { sendUrl, ...linkFields } = publishLinkFields({
    data,
    channel: serving,
    ref,
    ttlHours: args.ttlHours,
    project: args.project,
    api: args.api,
  });
  Object.assign(data, linkFields);

  data.allowance = spendNarration({
    what: "This publish",
    body: data,
    api: args.api,
  });

  const previewCommands = previewCommandsOf(data.previewCommands);
  const tokenCarried = previewCommands.every(([, command]) => /[?&]t=/.test(command));
  const previewHint =
    previewCommands.length > 0
      ? `Run the extension without opening the share page: ${previewCommands
          .map(([browser, command]) => `${browser}: ${command}`)
          .join(" | ")}. ${
          tokenCarried
            ? "Each command carries the same share token as the URL and expires with it."
            : "These commands carry no share token: the project is public, so the zips are served without one."
        }`
      : null;
  const noBuild = data.buildSha == null;
  const noBuildNote = noBuild
    ? "This share serves NO build: the platform minted the link but named no build sha, which means the project has no successful build yet (or its build index could not be read). Anyone opening the link gets nothing to run. Build first (push a commit, or extension_build then a platform build), then publish again."
    : null;

  const tellHint = noBuild || !sendUrl ? null : `Send ${String(sendUrl)} and say: ${String(data.tellThem)}`;
  const hint = [tellHint, previewHint].filter(Boolean).join(" ");

  return envelope({
    ok: true,
    command: "extension_publish",
    status: noBuild ? "published-without-build" : "published",
    value: data,
    warnings: [noBuildNote, note, buildNote, channelNote, credential.note],
    ...(hint ? { hint } : {}),
  });
}
