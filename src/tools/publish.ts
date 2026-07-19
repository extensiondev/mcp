// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// MIT License (c) Cezar Augusto and the extension.dev collaborators

import { publish, resolveToken } from "../lib/publish";

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
          "Pin the share URL to a specific build sha (7-40 hex chars). Existence is not verified here; an unknown sha yields a link to a build that does not exist.",
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

  // Validate ttlHours against the documented range instead of letting an
  // out-of-range value be silently clamped server-side with no feedback.
  if (args.ttlHours != null) {
    const t = Number(args.ttlHours);
    if (!Number.isInteger(t) || t < 1 || t > 168) {
      return fail(
        "PublishBadRequest",
        "ttlHours must be an integer between 1 and 168.",
      );
    }
  }

  // Validate buildSha shape (a git sha is 7-40 hex chars) to catch typos; the
  // build's actual existence is the platform's responsibility (see note below).
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

  // Surface why ttlHours had no effect rather than accepting it silently: a
  // public project returns the canonical URL with no ttl/expiresAt.
  const data = result.data as Record<string, unknown>;
  if (args.ttlHours != null && data.visibility === "public") {
    data.note =
      "ttlHours was ignored: this is a public project, whose share URL is its canonical public page.";
  }
  return JSON.stringify(data);
}
