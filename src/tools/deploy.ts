// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// MIT License (c) Cezar Augusto and the extension.dev collaborators

// Thin wrapper around the standalone deploy CLI (bin:
// extension-deploy), which submits built extensions to the Chrome Web Store,
// Firefox AMO, and Edge Add-ons directly. deploy is the store-submission
// engine; this tool lets an agent drive it. Store CREDENTIALS are NEVER passed
// as tool arguments (they would land in the agent transcript) - they are read
// by the deploy CLI from the environment or a local .env.submit file. Only
// non-secret inputs (zip paths, public store IDs, channel) cross this boundary.

import spawn from "cross-spawn";

// Pin the deploy CLI the way exec.ts pins the extension CLI: a default that
// tracks a known-good release, overridable for CI/testing.
const DEFAULT_DEPLOY_VERSION = "1.2.1";

function pinnedDeployVersion(): string {
  return String(process.env.EXTENSION_DEPLOY_VERSION || "").trim() ||
    DEFAULT_DEPLOY_VERSION;
}

export interface DeployToolArgs {
  projectPath: string;
  chromeZip?: string;
  chromeExtensionId?: string;
  chromePublisherId?: string;
  firefoxZip?: string;
  firefoxSourcesZip?: string;
  firefoxExtensionId?: string;
  firefoxChannel?: "listed" | "unlisted";
  edgeZip?: string;
  edgeProductId?: string;
  dryRun?: boolean;
  stagedPublish?: boolean;
  chromeDeployPercentage?: number;
  chromeSkipSubmitReview?: boolean;
  edgeSkipSubmitReview?: boolean;
  outputJson?: string;
}

/**
 * Build the extension-deploy argv from tool arguments. Pure and exported so the
 * flag mapping is unit-tested without spawning a process. Never emits a
 * credential flag - secrets come from the environment / .env.submit.
 */
export function buildDeployArgs(args: DeployToolArgs): string[] {
  const argv: string[] = [];
  const pushValue = (flag: string, value: string | number | undefined) => {
    if (value === undefined || value === "") return;
    argv.push(flag, String(value));
  };

  // dryRun defaults to true: a store submission is irreversible, so the safe
  // default for an agent is to verify auth and inputs without uploading. The
  // caller must pass dryRun:false explicitly to actually submit.
  if (args.dryRun !== false) argv.push("--dry-run");

  pushValue("--chrome-zip", args.chromeZip);
  pushValue("--chrome-extension-id", args.chromeExtensionId);
  pushValue("--chrome-publisher-id", args.chromePublisherId);
  if (args.stagedPublish) argv.push("--chrome-staged-publish");
  pushValue("--chrome-deploy-percentage", args.chromeDeployPercentage);
  if (args.chromeSkipSubmitReview) argv.push("--chrome-skip-submit-review");

  pushValue("--firefox-zip", args.firefoxZip);
  pushValue("--firefox-sources-zip", args.firefoxSourcesZip);
  pushValue("--firefox-extension-id", args.firefoxExtensionId);
  pushValue("--firefox-channel", args.firefoxChannel);

  pushValue("--edge-zip", args.edgeZip);
  pushValue("--edge-product-id", args.edgeProductId);
  if (args.edgeSkipSubmitReview) argv.push("--edge-skip-submit-review");

  pushValue("--output-json", args.outputJson);

  return argv;
}

export const schema = {
  name: "extension_deploy",
  description:
    "Submit a built extension to the Chrome Web Store, Firefox AMO, and/or Edge Add-ons by driving the standalone deploy CLI. Provide the built .zip path(s); the target stores are inferred from which zips you pass. DEFAULTS TO A DRY RUN (verifies auth and inputs, uploads nothing) - pass dryRun:false to actually submit, which is irreversible and enters store review. Store CREDENTIALS are NOT arguments: set them in the environment or a .env.submit file in projectPath (CHROME_CLIENT_ID/CHROME_CLIENT_SECRET/CHROME_REFRESH_TOKEN or CHROME_SERVICE_ACCOUNT_JSON; FIREFOX_JWT_ISSUER/FIREFOX_JWT_SECRET; EDGE_CLIENT_ID/EDGE_API_KEY). Runs `npx deploy`.",
  inputSchema: {
    type: "object" as const,
    properties: {
      projectPath: {
        type: "string",
        description:
          "Working directory. Relative zip paths and a .env.submit credential file are resolved from here.",
      },
      chromeZip: {
        type: "string",
        description: "Path to the built Chrome extension .zip",
      },
      chromeExtensionId: {
        type: "string",
        description: "Chrome extension ID (or set CHROME_EXTENSION_ID)",
      },
      chromePublisherId: {
        type: "string",
        description: "Chrome publisher UUID (or set CHROME_PUBLISHER_ID)",
      },
      firefoxZip: {
        type: "string",
        description: "Path to the built Firefox extension .zip",
      },
      firefoxSourcesZip: {
        type: "string",
        description: "Path to the Firefox sources .zip (optional)",
      },
      firefoxExtensionId: {
        type: "string",
        description: "Firefox add-on GUID or email-style ID",
      },
      firefoxChannel: {
        type: "string",
        enum: ["listed", "unlisted"],
        description: "Firefox channel (unlisted is required for a first submission)",
      },
      edgeZip: {
        type: "string",
        description: "Path to the built Edge extension .zip",
      },
      edgeProductId: {
        type: "string",
        description: "Edge Partner Center product ID (or set EDGE_PRODUCT_ID)",
      },
      dryRun: {
        type: "boolean",
        default: true,
        description:
          "Verify auth and inputs without uploading or publishing. Pass false to actually submit (irreversible).",
      },
      stagedPublish: {
        type: "boolean",
        default: false,
        description:
          "Chrome: publish as STAGED_PUBLISH so the rollout can be raised review-free later.",
      },
      chromeDeployPercentage: {
        type: "number",
        description: "Chrome staged rollout percentage (1-100).",
      },
      chromeSkipSubmitReview: {
        type: "boolean",
        default: false,
        description: "Chrome: upload only, skip the publish/submit-for-review step.",
      },
      edgeSkipSubmitReview: {
        type: "boolean",
        default: false,
        description: "Edge: upload only, skip the publish/submit-for-review step.",
      },
      outputJson: {
        type: "string",
        description: "Write the machine-readable DeployResult JSON to this path.",
      },
    },
    required: ["projectPath"],
  },
};

export async function handler(args: DeployToolArgs): Promise<string> {
  if (!args.chromeZip && !args.firefoxZip && !args.edgeZip) {
    return JSON.stringify({
      ok: false,
      error: {
        name: "DeployInputError",
        message:
          "No store targets. Provide at least one of chromeZip, firefoxZip, or edgeZip.",
      },
    });
  }

  const version = pinnedDeployVersion();
  const argv = ["--yes", `deploy@${version}`, ...buildDeployArgs(args)];

  return new Promise((resolve) => {
    const child = spawn("npx", argv, {
      cwd: args.projectPath,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => (stdout += d.toString()));
    child.stderr?.on("data", (d) => (stderr += d.toString()));
    child.on("close", (code) => {
      resolve(
        JSON.stringify({
          ok: code === 0,
          dryRun: args.dryRun !== false,
          code,
          stdout: stdout.trim(),
          stderr: stderr.trim(),
        }),
      );
    });
    child.on("error", (err) => {
      resolve(
        JSON.stringify({
          ok: false,
          error: {
            name: "DeploySpawnError",
            message: `Could not run extension-deploy: ${
              err instanceof Error ? err.message : String(err)
            }`,
          },
        }),
      );
    });
  });
}
