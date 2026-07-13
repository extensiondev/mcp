// extension_publish — thin MCP adapter over @extension.dev/core's publish().
//
// The platform client (token resolution, base-URL egress guard, POST) lives in
// core and is shared by every surface; this file owns only the MCP tool
// contract. The schema and the JSON-string envelopes are frozen: agents
// pattern-match on PublishAuthError / PublishNetworkError / PublishError, and
// success returns the platform response verbatim.

import { publish, resolveToken } from "@extension.dev/core";

export const schema = {
  name: "extension_publish",
  description:
    "Publish a project to extension.dev and return a shareable URL. Auth-gated: requires EXTENSION_DEV_TOKEN (a workspace/project access token) in the environment. Posts to the platform's CLI publish endpoint directly. This is the only tool that talks to the hosted platform rather than the local browser.",
  inputSchema: {
    type: "object" as const,
    properties: {
      projectPath: {
        type: "string",
        description: "Path to the extension project root",
      },
      ttlHours: {
        type: "number",
        description: "Share-link lifetime in hours (1–168, default 24)",
      },
      buildSha: {
        type: "string",
        description: "Pin the share URL to a specific build sha",
      },
      api: {
        type: "string",
        description:
          "Platform base URL (defaults to https://www.extension.dev or EXTENSION_DEV_API_URL)",
      },
    },
    required: ["projectPath"],
  },
};

export async function handler(args: {
  // projectPath is accepted for interface parity with the CLI; the publish
  // target is identified by the token's claims (workspaceSlug/projectSlug),
  // so the value is not sent in the request body.
  projectPath: string;
  ttlHours?: number;
  buildSha?: string;
  api?: string;
}): Promise<string> {
  // Pre-check the token here so the guidance names the MCP tool
  // (extension_login), not core's surface-neutral wording.
  const token = resolveToken();
  if (!token) {
    return JSON.stringify({
      ok: false,
      error: {
        name: "PublishAuthError",
        message:
          "No token. Run extension_login, or set EXTENSION_DEV_TOKEN (create one in the extension.dev dashboard).",
      },
    });
  }

  const result = await publish({
    ttlHours: args.ttlHours,
    buildSha: args.buildSha,
    api: args.api,
    token,
  });

  // Success: the platform response verbatim (shareUrl, visibility, …).
  // Failure: core's envelope is byte-compatible with the frozen
  // { ok: false, error: { name, message } } shape.
  return result.ok ? JSON.stringify(result.data) : JSON.stringify(result);
}
