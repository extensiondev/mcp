// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// MIT License (c) Cezar Augusto and the extension.dev collaborators

// Submit a built extension to the browser stores THROUGH extension.dev. The
// platform holds the store credentials and dispatches the release from the
// project's mirror CI, so this tool never handles store secrets - it is a thin
// authenticated client of the platform's store-submission endpoint, exactly like
// extension_publish and extension_release_promote. (It previously shelled out to
// a standalone deploy CLI; routing through the platform is both the correct trust
// boundary and the only path that works from a hosted MCP client.)

import { resolveToken } from "../lib/publish";
import { safeApiBase } from "../lib/login-flow";

const DEFAULT_API = "https://www.extension.dev";

export interface DeployToolArgs {
  browsers: string[];
  buildSha: string;
  channel?: string;
  version?: string;
  dryRun?: boolean;
  api?: string;
}

export const schema = {
  name: "extension_deploy",
  description:
    "Submit a built extension to the Chrome Web Store, Firefox AMO, and/or Edge Add-ons THROUGH extension.dev, which holds your store credentials and dispatches the release from your project's mirror CI. DEFAULTS TO A DRY RUN (preflight: verifies auth, the project, that the build exists, and the store workflow - dispatches nothing); pass dryRun:false to actually submit, which is irreversible and enters store review. The target project is identified by your token (extension_login or a release token in EXTENSION_DEV_TOKEN); store credentials are never tool arguments and local files are not uploaded. Pass browsers + buildSha. Posts to the platform's CLI store-submission endpoint.",
  inputSchema: {
    type: "object" as const,
    properties: {
      browsers: {
        type: "array",
        items: {
          type: "string",
          enum: ["chrome", "firefox", "edge", "safari"],
        },
        description: "Stores to submit to.",
      },
      buildSha: {
        type: "string",
        description:
          "The built commit SHA to submit. It must have a completed build in the project's build index; an unknown sha is rejected.",
      },
      channel: {
        type: "string",
        description: "Release channel to submit from (default stable).",
      },
      version: {
        type: "string",
        description: "Version label for the submission record (optional).",
      },
      dryRun: {
        type: "boolean",
        default: true,
        description:
          "Preflight only (verify auth, project, build, and store workflow). Pass false to actually dispatch the submission (irreversible, enters store review).",
      },
      api: {
        type: "string",
        description:
          "Platform base URL (defaults to https://www.extension.dev or EXTENSION_DEV_API_URL)",
      },
    },
    required: ["browsers", "buildSha"],
  },
};

function fail(name: string, message: string): string {
  return JSON.stringify({ ok: false, error: { name, message } });
}

export async function handler(args: DeployToolArgs): Promise<string> {
  const token = resolveToken();
  if (!token) {
    return fail(
      "DeployAuthError",
      "No token. Run extension_login, or set EXTENSION_DEV_TOKEN (create one in the extension.dev dashboard under project settings -> Access tokens).",
    );
  }

  const browsers = (Array.isArray(args.browsers) ? args.browsers : [])
    .map((b) => String(b).trim().toLowerCase())
    .filter(Boolean);
  if (browsers.length === 0) {
    return fail(
      "DeployInputError",
      'browsers is required (e.g. ["chrome","firefox","edge"]).',
    );
  }
  const buildSha = String(args.buildSha || "").trim();
  if (!buildSha) {
    return fail(
      "DeployInputError",
      "buildSha is required (the built commit to submit).",
    );
  }

  const apiCheck = safeApiBase(
    String(args.api || process.env.EXTENSION_DEV_API_URL || DEFAULT_API),
  );
  if (!apiCheck.ok) {
    return fail("DeployConfigError", apiCheck.message);
  }
  const url = `${apiCheck.base}/api/cli/stores/submit`;

  const dryRun = args.dryRun !== false;
  const body: Record<string, unknown> = { browsers, buildSha, dryRun };
  if (args.channel) body.channel = String(args.channel).trim();
  if (args.version) body.version = String(args.version).trim();

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
      "DeployNetworkError",
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
      "DeployError",
      `submit failed (${res.status}): ${data?.message || text || "unknown error"}`,
    );
  }

  return JSON.stringify({ mode: "platform", dryRun, ...data });
}
