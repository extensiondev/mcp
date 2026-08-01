// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { API_BASE } from "../lib/common-schema";
import { envelope, type ErrorCode } from "../lib/envelope";
import { publish, resolveToken } from "../lib/publish";
import {
  fetchRegistryJson,
  parseBuildIndex,
  registryFileUrl,
  resolveProjectRef,
} from "../lib/registry";

export const schema = {
  name: "extension_publish",
  description:
    "Publish the project your stored token is scoped to (extension_auth, or EXTENSION_DEV_TOKEN) to extension.dev, and return its shareable URL. This is what \"deploy\" or \"ship\" an extension usually means; extension_submit is the separate store-review path. The target is the token's project: there is no projectPath, and no local file is uploaded. For a public project the URL is the canonical public page and ttlHours does not apply. For a private one it is a fresh time-limited share link (?share=) whose lifetime is ttlHours.",
  inputSchema: {
    type: "object" as const,
    properties: {
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
  ttlHours?: number;
  buildSha?: string;
  api?: string;
}): Promise<string> {
  const token = resolveToken();
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
    const projectMissing = /\(404\)/.test(result.error.message);
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
  let note: string | null = null;
  if (args.ttlHours != null && data.visibility === "public") {
    note =
      "ttlHours was ignored: this is a public project, whose share URL is its canonical public page.";
  }
  let buildNote: string | null = null;

  const ref = resolveProjectRef();
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
          buildNote = `buildSha ${args.buildSha} is pinned but was not found in the project's registry build index, so builtAt/version/channel are not filled in from another build. The URL still serves the pinned build the platform accepted.`;
        }
      } else {
        const newestSuccess = items
          .filter((item) => item.status === "success")
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
  return envelope({
    ok: true,
    command: "extension_publish",
    status: "published",
    value: data,
    warnings: [note, buildNote],
  });
}
