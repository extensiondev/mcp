// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// MIT License (c) Cezar Augusto and the extension.dev collaborators

// Thin wrapper around the standalone deploy CLI (bin:
// extension-deploy). Two modes: DIRECT talks to the store APIs with the
// caller's own credentials; PLATFORM routes the submission through
// extension.dev (which holds the credentials and dispatches the release).
// deploy is the store-submission engine; this tool lets an agent drive it.
// Store CREDENTIALS and platform TOKENS are NEVER passed as tool arguments
// (they would land in the agent transcript) - they are read by the deploy CLI
// from the environment or a local .env.submit file.

import spawn from "cross-spawn";

// Pin the deploy CLI the way exec.ts pins the extension CLI: a default that
// tracks a known-good release, overridable for CI/testing. NOTE: platform mode
// needs deploy >= 1.3.0; bump this once 1.3.0 is published.
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
  // Platform mode (route through extension.dev instead of the store APIs).
  platform?: boolean;
  browsers?: string[];
  buildSha?: string;
  channel?: string;
}

/**
 * Platform mode is intended when the caller asks for it (`platform: true`) or
 * supplies platform-only inputs (browsers/buildSha). It is NOT inferred from the
 * mere presence of a token in the environment - see the handler, which shapes
 * the child env so a stray EXTENSION_DEV_TOKEN cannot silently redirect a
 * direct, zip-based submission into platform mode.
 */
export function isPlatformInvocation(args: DeployToolArgs): boolean {
  return (
    args.platform === true ||
    (Array.isArray(args.browsers) && args.browsers.length > 0) ||
    (typeof args.buildSha === "string" && args.buildSha.length > 0)
  );
}

/**
 * Build the direct-mode extension-deploy argv. Pure and exported so the flag
 * mapping is unit-tested without spawning a process. Never emits a credential
 * flag - secrets come from the environment / .env.submit.
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

/** Build the platform-mode extension-deploy argv. Pure and exported. */
export function buildPlatformArgs(args: DeployToolArgs): string[] {
  const argv = ["--platform"];
  // Same irreversible-by-default posture as direct mode: dry run unless the
  // caller explicitly opts out (the platform treats dryRun as a preflight).
  if (args.dryRun !== false) argv.push("--dry-run");
  if (args.browsers?.length) argv.push("--browsers", args.browsers.join(","));
  if (args.buildSha) argv.push("--build-sha", args.buildSha);
  if (args.channel) argv.push("--channel", args.channel);
  if (args.outputJson) argv.push("--output-json", args.outputJson);
  return argv;
}

export const schema = {
  name: "extension_deploy",
  description:
    "Submit a built extension to the Chrome Web Store, Firefox AMO, and/or Edge Add-ons by driving the standalone deploy CLI. DEFAULTS TO A DRY RUN (verifies auth and inputs, submits nothing) - pass dryRun:false to actually submit, which is irreversible and enters store review. Two modes: (1) DIRECT - provide the built .zip path(s) and store credentials via the environment or a .env.submit file in projectPath (CHROME_CLIENT_ID/CHROME_CLIENT_SECRET/CHROME_REFRESH_TOKEN or CHROME_SERVICE_ACCOUNT_JSON; FIREFOX_JWT_ISSUER/FIREFOX_JWT_SECRET; EDGE_CLIENT_ID/EDGE_API_KEY); target stores are inferred from which zips you pass. (2) PLATFORM - set platform:true (needs EXTENSION_DEV_TOKEN in the environment) and pass browsers + buildSha to route the submission through extension.dev, which holds the credentials and dispatches the release; requires deploy >= 1.3.0. Store CREDENTIALS and tokens are never tool arguments. Runs `npx deploy`.",
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
      platform: {
        type: "boolean",
        default: false,
        description:
          "Platform mode: route through extension.dev instead of the store APIs. Needs EXTENSION_DEV_TOKEN in the environment plus browsers and buildSha. Implied when browsers or buildSha are set.",
      },
      browsers: {
        type: "array",
        items: { type: "string", enum: ["chrome", "firefox", "edge", "safari"] },
        description: "Platform mode: stores to submit to.",
      },
      buildSha: {
        type: "string",
        description: "Platform mode: the built commit SHA to submit.",
      },
      channel: {
        type: "string",
        description: "Platform mode: release channel to submit from (default stable).",
      },
    },
    required: ["projectPath"],
  },
};

function toolError(name: string, message: string): string {
  return JSON.stringify({ ok: false, error: { name, message } });
}

export async function handler(args: DeployToolArgs): Promise<string> {
  const platform = isPlatformInvocation(args);

  // Shape the child environment per mode. In direct mode we strip
  // EXTENSION_DEV_TOKEN so a token that merely happens to be in the server
  // environment cannot silently redirect a zip-based submission into platform
  // mode on deploy >= 1.3.0. In platform mode we require the token.
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    FORCE_COLOR: "0",
    NO_COLOR: "1",
  };

  let argvTail: string[];
  if (platform) {
    if (!String(process.env.EXTENSION_DEV_TOKEN || "").trim()) {
      return toolError(
        "DeployAuthError",
        "Platform mode needs EXTENSION_DEV_TOKEN in the environment. Create a token in the extension.dev dashboard.",
      );
    }
    if (!args.browsers?.length) {
      return toolError(
        "DeployInputError",
        'Platform mode needs browsers (e.g. ["chrome","firefox","edge"]).',
      );
    }
    if (!args.buildSha) {
      return toolError(
        "DeployInputError",
        "Platform mode needs buildSha, the built commit to submit.",
      );
    }
    argvTail = buildPlatformArgs(args);
  } else {
    if (!args.chromeZip && !args.firefoxZip && !args.edgeZip) {
      return toolError(
        "DeployInputError",
        "No store targets. Provide at least one of chromeZip, firefoxZip, or edgeZip, or use platform mode.",
      );
    }
    delete childEnv.EXTENSION_DEV_TOKEN;
    argvTail = buildDeployArgs(args);
  }

  const version = pinnedDeployVersion();
  const argv = ["--yes", `deploy@${version}`, ...argvTail];

  return new Promise((resolve) => {
    const child = spawn("npx", argv, {
      cwd: args.projectPath,
      stdio: ["ignore", "pipe", "pipe"],
      env: childEnv,
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => (stdout += d.toString()));
    child.stderr?.on("data", (d) => (stderr += d.toString()));
    child.on("close", (code) => {
      resolve(
        JSON.stringify({
          ok: code === 0,
          mode: platform ? "platform" : "direct",
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
