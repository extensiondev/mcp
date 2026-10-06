// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { API_BASE } from "../lib/common-schema";
import { envelope, type ErrorCode } from "../lib/envelope";
import { spendNarration } from "../lib/allowance";
import { publish, resolveToken } from "../lib/publish";
import { PROJECT_TOKEN_INPUT, noStoredLoginHint } from "../lib/credentials";
import { platformHoldEnvelope } from "../lib/platform-hold";
import {
  fetchRegistryJson,
  isSuccessfulBuild,
  parseBuildIndex,
  registryFileUrl,
  loginProjectRef,
} from "../lib/registry";

export const schema = {
  name: "extension_publish",
  description:
    "Publish the project your stored token is scoped to (extension_auth, or EXTENSION_DEV_TOKEN) to extension.dev, and return its shareable URL. This is what \"deploy\" or \"ship\" an extension usually means; extension_submit is the separate store-review path. The target is the token's project: there is no projectPath, and no local file is uploaded. With several logins stored, pass `project` ('<workspace>/<project>') to pick which one; it outranks EXTENSION_DEV_TOKEN. For a public project the URL is the canonical public page and ttlHours does not apply. For a private one it is a fresh time-limited share link (?share=) whose lifetime is ttlHours.",
  inputSchema: {
    type: "object" as const,
    properties: {
      project: PROJECT_TOKEN_INPUT,
      ttlHours: {
        type: "number",
        description:
          "Private-project share-link lifetime in hours, 1-168 (default 24). Ignored for public projects.",
      },
      buildSha: {
        type: "string",
        description:
          "Pin the URL to a build sha (7-40 hex chars). An unknown sha is rejected, so the returned URL always points at a real build.",
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
  const token = resolveToken({ project: args.project });
  if (!token && args.project) {
    return fail("PublishAuthError", noStoredLoginHint(args.project), "auth-required", "E_AUTH_REQUIRED");
  }
  if (!token) {
    return fail(
      "PublishAuthError",
      "No token. Run extension_auth (action: login), or set EXTENSION_DEV_TOKEN (create one in the extension.dev dashboard).",
      "auth-required",
      "E_AUTH_REQUIRED",
    );
  }

  if (args.ttlHours != null) {
    const t = Number(args.ttlHours);
    if (!Number.isInteger(t) || t < 1 || t > 168) {
      return fail(
        "PublishBadRequest",
        "ttlHours must be an integer between 1 and 168.",
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
    /* @invariant The held branch precedes the 404 branch because its hint sends
     * the reader to extension.dev/new, which the public hold answers with 503.
     * A refusal may not hand somebody an error page as its way forward. */
    if (result.held) {
      return platformHoldEnvelope({
        command: "extension_publish",
        name: result.error.name,
        body: result.body,
        api: args.api,
      });
    }
    const code = (result.error as { code?: string }).code;
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
  /* @invariant A SHARE IS A URL THE PLATFORM NAMED, OVER A BUILD IT NAMED.
     "published" used to be any 2xx: an empty body, an HTML page, and a
     share minted over a project with no successful build (the platform
     mints it and answers `buildSha: null`) all read as published with a
     link that renders nothing. No share URL is
     unconfirmed; a share with no build is said to be exactly that. */
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
      "ttlHours was ignored: this is a public project, whose share URL is its canonical public page.";
  }
  let buildNote: string | null = null;

  const ref = loginProjectRef(args.project);
  if (ref) {
    const buildsUrl = registryFileUrl(ref, "builds/index.json");
    const buildsRes = await fetchRegistryJson(buildsUrl, fetch, {
      ref,
      api: args.api,
    });
    if (buildsRes.ok) {
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
            data.builtAt = pinned.timestamp;
          if (data.version == null && pinned.version)
            data.version = pinned.version;
          if (data.channel == null && pinned.channel)
            data.channel = pinned.channel;
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
        if (newestSuccess) {
          if (data.buildSha == null) data.buildSha = newestSuccess.sha;
          if (data.builtAt == null && newestSuccess.timestamp)
            data.builtAt = newestSuccess.timestamp;
          if (data.version == null && newestSuccess.version)
            data.version = newestSuccess.version;
          if (data.channel == null && newestSuccess.channel)
            data.channel = newestSuccess.channel;
          data.registryUrl = buildsUrl;
          buildNote =
            "buildSha/builtAt/version describe the newest successful build in the project's registry index, which is what the share link serves. Pin buildSha to serve a specific build.";
        }
      }
    }
  }
  data.allowance = spendNarration({
    what: "This publish",
    body: data,
    api: args.api,
  });
  /* @invariant The preview commands come from the PLATFORM and are relayed,
   * never rebuilt here: they carry the share token inside a registry URL, and
   * a tool that assembled its own would be a tool that could be talked into
   * pointing the token at another host. While the public hold keeps the share
   * page dark the command is the only way the link is usable, so the hint
   * names that outright instead of sending the reader to a 503. */
  const previewCommands = previewCommandsOf(data.previewCommands);
  const previewHint =
    previewCommands.length > 0
      ? `Run the extension without opening the share page: ${previewCommands
          .map(([browser, command]) => `${browser}: ${command}`)
          .join(" | ")}. Each command carries the same share token as the URL and expires with it.`
      : null;
  const noBuild = data.buildSha == null;
  const noBuildNote = noBuild
    ? "This share serves NO build: the platform minted the link but named no build sha, which means the project has no successful build yet (or its build index could not be read). Anyone opening the link gets nothing to run. Build first (push a commit, or extension_build then a platform build), then publish again."
    : null;
  return envelope({
    ok: true,
    command: "extension_publish",
    status: noBuild ? "published-without-build" : "published",
    value: data,
    warnings: [noBuildNote, note, buildNote],
    ...(previewHint ? { hint: previewHint } : {}),
  });
}
