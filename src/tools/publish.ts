// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// MIT License (c) Cezar Augusto and the extension.dev collaborators

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
  projectPath: string;
  ttlHours?: number;
  buildSha?: string;
  api?: string;
}): Promise<string> {
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

  return result.ok ? JSON.stringify(result.data) : JSON.stringify(result);
}
