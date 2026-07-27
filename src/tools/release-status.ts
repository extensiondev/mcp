// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { API_BASE } from "../lib/common-schema";
import { readReleases } from "./release-list";
import { readStores } from "./store-status";

export const schema = {
  name: "extension_release_status",
  description:
    "Read where a project stands on extension.dev, from the public registry (registry.extension.land). This is read-only: it dispatches nothing and promotes nothing. Pass include:'releases' for the release channels (channel to promoted build sha), recent builds, and a public build-page URL for each, which is how you find a valid sha for extension_release_promote, extension_submit or extension_publish. Pass include:'stores' for the per-store picture after an extension_submit (chrome, firefox, edge, safari): configured or not, the last credential health check, the last recorded submission, and the latest review status, read from stores/health.json, stores/status.json and stores/submissions.json. Both are included by default. This defaults to the logged-in project (extension_auth); pass workspace and project to read another. Private projects work when your stored login covers them. Registry state can lag the store dashboards by up to a polling interval.",
  inputSchema: {
    type: "object" as const,
    properties: {
      include: {
        type: "array",
        items: { type: "string", enum: ["releases", "stores"] },
        default: ["releases", "stores"],
        description: "Which sections to read. Both by default.",
      },
      workspace: {
        type: "string",
        description: "Workspace slug override (default: the stored login's).",
      },
      project: {
        type: "string",
        description: "Project slug override (default: the stored login's).",
      },
      api: API_BASE,
    },
    required: [],
  },
};

function parse(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return { ok: false, error: { name: "ParseError", message: raw } };
  }
}

export async function handler(args: {
  include?: string[];
  workspace?: string;
  project?: string;
  api?: string;
}): Promise<string> {
  const include =
    Array.isArray(args.include) && args.include.length
      ? args.include
      : ["releases", "stores"];
  const scope = {
    workspace: args.workspace,
    project: args.project,
    api: args.api,
  };

  const [releases, stores] = await Promise.all([
    include.includes("releases") ? readReleases(scope).then(parse) : null,
    include.includes("stores") ? readStores(scope).then(parse) : null,
  ]);

  const sections = [releases, stores].filter(Boolean) as Record<
    string,
    unknown
  >[];

  return JSON.stringify({
    ok: sections.some((section) => section.ok === true),
    ...(releases ? { releases } : {}),
    ...(stores ? { stores } : {}),
  });
}
