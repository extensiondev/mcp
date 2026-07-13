// Headless "promote a build to a channel" for CI/CLI.
//
// Mirrors tools/publish.ts: auth-AWARE not auth-HOLDING. The release token is
// read at call time (EXTENSION_DEV_TOKEN, else the login creds file) and never
// persisted or logged here. The project is identified by the token's claims, so
// the caller passes only the build + channel.
//
// Promote is mirror-side on the platform (it dispatches the release workflow and
// pins channels.json), so it works with no browser. Cutting a release (the
// version-bump PR) is intentionally NOT exposed headlessly: it writes to your
// source repo, which needs an interactive GitHub login the CLI does not hold.

import { resolveToken, safeApiBase } from "@extension.dev/core";

const DEFAULT_API = "https://www.extension.dev";

export const schema = {
  name: "extension_release_promote",
  description:
    "Promote a built extension to a release channel (e.g. stable, preview, beta) on extension.dev, headless. Auth-gated: requires a release token in EXTENSION_DEV_TOKEN (mint and revoke it in the dashboard under project settings -> Access tokens). Posts to the platform's CLI release endpoint; the project is identified by the token. Cutting a version-bump PR is not available headlessly (it writes to your source repo and needs an interactive login).",
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
      "No token. Set EXTENSION_DEV_TOKEN to a release token (create one in the extension.dev dashboard under project settings -> Access tokens), or run extension_login.",
    );
  }

  const buildId = String(args.buildId || "").trim();
  const channel = String(args.channel || "").trim();
  if (!buildId || !channel) {
    return fail("ReleaseInputError", "buildId and channel are required.");
  }

  const apiCheck = safeApiBase(
    String(args.api || process.env.EXTENSION_DEV_API_URL || DEFAULT_API),
  );
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
    return fail(
      "ReleaseError",
      `promote failed (${res.status}): ${data?.message || text || "unknown error"}`,
    );
  }

  // Success: return the platform response verbatim (queuedBrowsers, ...).
  return JSON.stringify(data);
}
