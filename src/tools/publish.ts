// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

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
    "Publish the project your stored token is scoped to (from extension_login, or EXTENSION_DEV_TOKEN) to extension.dev and return its shareable URL. The publish target is the token's project -- there is no projectPath, the local files are not uploaded. For a PUBLIC project the URL is the canonical public page and ttlHours does not apply; for a PRIVATE project it is a fresh time-limited share link (?share=) whose lifetime is ttlHours. Posts to the platform's CLI publish endpoint. Besides extension_login this is the only tool that talks to the hosted platform.",
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
          "Pin the share URL to a specific build sha (7-40 hex chars). The platform verifies the build exists in the project's build index and rejects an unknown sha, so the returned URL always points at a real build.",
      },
      api: {
        type: "string",
        description:
          "Platform base URL (defaults to https://www.extension.dev or EXTENSION_DEV_API_URL)",
      },
    },
    required: [],
  },
};

function fail(name: string, message: string): string {
  return JSON.stringify({ ok: false, error: { name, message } });
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
      "No token. Run extension_login, or set EXTENSION_DEV_TOKEN (create one in the extension.dev dashboard).",
    );
  }

  if (args.ttlHours != null) {
    const t = Number(args.ttlHours);
    if (!Number.isInteger(t) || t < 1 || t > 168) {
      return fail(
        "PublishBadRequest",
        "ttlHours must be an integer between 1 and 168.",
      );
    }
  }

  if (args.buildSha != null && args.buildSha !== "") {
    if (!/^[0-9a-f]{7,40}$/i.test(args.buildSha)) {
      return fail(
        "PublishBadRequest",
        "buildSha must be a 7-40 character hex git sha.",
      );
    }
  }

  const result = await publish({
    ttlHours: args.ttlHours,
    buildSha: args.buildSha,
    api: args.api,
    token,
  });

  if (!result.ok) return JSON.stringify(result);

  const data = result.data as Record<string, unknown>;
  if (args.ttlHours != null && data.visibility === "public") {
    data.note =
      "ttlHours was ignored: this is a public project, whose share URL is its canonical public page.";
  }

  const ref = resolveProjectRef();
  if (ref) {
    const buildsUrl = registryFileUrl(ref, "builds/index.json");
    const buildsRes = await fetchRegistryJson(buildsUrl, fetch, {
      ref,
      api: args.api,
    });
    if (buildsRes.ok) {
      const items = parseBuildIndex(buildsRes.json);
      const pinned = args.buildSha
        ? items.find((item) => {
            const short = String(args.buildSha).slice(0, 7).toLowerCase();
            return (
              item.sha.toLowerCase() === short ||
              String(item.commit ?? "")
                .toLowerCase()
                .startsWith(short)
            );
          })
        : undefined;
      const newestSuccess = items
        .filter((item) => item.status === "success")
        .sort((a, b) =>
          String(b.timestamp ?? "").localeCompare(String(a.timestamp ?? "")),
        )[0];
      const served = pinned ?? newestSuccess;
      if (served) {
        if (data.buildSha == null) data.buildSha = served.sha;
        if (data.builtAt == null && served.timestamp) data.builtAt = served.timestamp;
        if (data.version == null && served.version) data.version = served.version;
        if (data.channel == null && served.channel) data.channel = served.channel;
        data.registryUrl = buildsUrl;
        if (!pinned && args.buildSha == null) {
          data.buildNote =
            "buildSha/builtAt/version describe the newest successful build in the project's registry index, which is what the share link serves. Pin buildSha to serve a specific build.";
        }
      }
    }
  }
  return JSON.stringify(data);
}
