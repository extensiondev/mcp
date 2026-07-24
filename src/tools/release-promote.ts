// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { resolveToken } from "../lib/publish";
import { resolveApiBase, safeApiBase } from "../lib/login-flow";
import { UserlandProjectPage } from "@extension.dev/urls/userland";

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
    "Promote a built extension to a release channel (e.g. stable, preview, beta) on extension.dev, headless. Auth-gated: uses your stored login (extension_login) or a release token in EXTENSION_DEV_TOKEN (mint and revoke it in the dashboard under project settings -> Access tokens; tokens live at most 7 days, so CI must re-mint before expiry). Posts to the platform's CLI release endpoint; the project is identified by the token. Cutting a version-bump PR is not available headlessly (it writes to your source repo and needs an interactive login).",
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
      api: {
        type: "string",
        description:
          "Platform base URL (defaults to https://www.extension.dev or EXTENSION_DEV_API_URL)",
      },
    },
    required: ["buildId", "channel"],
  },
};

function fail(name: string, message: string): string {
  return JSON.stringify({ ok: false, error: { name, message } });
}

export async function handler(args: {
  buildId: string;
  channel: string;
  sourceChannel?: string;
  browsers?: string[];
  version?: string;
  releaseNotes?: string;
  api?: string;
}): Promise<string> {
  const token = resolveToken();
  if (!token) {
    return fail(
      "ReleaseAuthError",
      "No token. Set EXTENSION_DEV_TOKEN to a release token (create one in the extension.dev dashboard under project settings -> Access tokens; tokens live at most 7 days, so CI must re-mint before expiry), or run extension_login.",
    );
  }

  const buildId = String(args.buildId || "").trim();
  const channel = String(args.channel || "").trim();
  if (!buildId || !channel) {
    return fail("ReleaseInputError", "buildId and channel are required.");
  }

  const apiCheck = safeApiBase(resolveApiBase(args.api));
  if (!apiCheck.ok) {
    return fail("ReleaseConfigError", apiCheck.message);
  }
  const url = `${apiCheck.base}/api/cli/release/promote`;

  const body: Record<string, unknown> = { buildId, channel };
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
    const code = typeof data?.code === "string" ? data.code : undefined;
    const enrich: Record<string, unknown> = {};
    const ref = resolveProjectRef();

    if (res.status === 404 || code === "UNKNOWN_BUILD") {
      enrich.buildsPageUrl = consoleProjectUrl(ref, "builds", args.api);
      enrich.hint =
        "Run extension_release_list to see this project's channels, their promoted shas, and recent builds.";
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

    return JSON.stringify({
      ok: false,
      error: {
        name: "ReleaseError",
        message: `promote failed (${res.status}): ${data?.message || text || "unknown error"}`,
        ...(code ? { code } : {}),
      },
      ...enrich,
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
  const enriched =
    data && typeof data === "object" && !Array.isArray(data)
      ? {
          ...data,
          ...(publicChannelUrl ? { publicChannelUrl } : {}),
          ...(publicBuildUrl ? { publicBuildUrl } : {}),
        }
      : data;
  return JSON.stringify(enriched);
}
