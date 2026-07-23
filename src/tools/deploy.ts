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

import fs from "node:fs";
import path from "node:path";
import { resolveToken } from "../lib/publish";
import { safeApiBase } from "../lib/login-flow";
import {
  consoleProjectUrl,
  fetchRegistryJson,
  parseChannels,
  registryFileUrl,
  resolveProjectRef,
} from "../lib/registry";

const DEFAULT_API = "https://www.extension.dev";

// Advisory only: the platform's mirror CI reads STORE.md at submission time
// (Firefox reviewer/release notes, Edge certification notes), so a missing
// field there means a store submission without them. Never blocks the run.
export function storeMdWarnings(browsers: string[], cwd: string): string[] {
  const wantsFirefox = browsers.includes("firefox");
  const wantsEdge = browsers.includes("edge");
  if (!wantsFirefox && !wantsEdge) return [];

  let content: string;
  try {
    content = fs.readFileSync(path.join(cwd, "STORE.md"), "utf8");
  } catch {
    // The check reads the LOCAL working directory, but platform submissions
    // fetch STORE.md from the project's SOURCE repository at submit time, so
    // a local miss is advisory, not a verdict (operator hit the old wording
    // claiming notes "will not accompany" a submission whose source repo had
    // the file).
    return [
      "No STORE.md found in the current working directory. Platform submissions read STORE.md from the project's source repository, so this may not apply here; make sure STORE.md exists there for Firefox reviewer notes and Edge certification notes. See the extension-dev skill's store-md reference.",
    ];
  }

  const hasField = (section: RegExp, field: RegExp): boolean => {
    const parts = content.split(/^## +/m);
    const match = parts.find((p) => section.test(p.split("\n", 1)[0] ?? ""));
    if (!match) return false;
    const sub = match.split(/^### +/m).find((p) => field.test(p.split("\n", 1)[0] ?? ""));
    if (!sub) return false;
    const body = sub.split("\n").slice(1).join("\n");
    return body.replace(/<!--[\s\S]*?-->/g, "").trim().length > 0;
  };

  const warnings: string[] = [];
  if (wantsFirefox && !hasField(/firefox|amo/i, /reviewer notes/i)) {
    warnings.push(
      "STORE.md has no Firefox reviewer notes; AMO reviews go faster with test credentials and steps.",
    );
  }
  if (wantsEdge && !hasField(/edge/i, /certification notes/i)) {
    warnings.push(
      "STORE.md has no Edge certification notes; the certification team gets no testing guidance.",
    );
  }
  return warnings;
}

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
    "Submit a built extension to the Chrome Web Store, Firefox AMO, and/or Edge Add-ons THROUGH extension.dev, which holds your store credentials and dispatches the release from your project's mirror CI. DEFAULTS TO A DRY RUN (preflight - dispatches nothing): the platform side verifies auth, the project, that the build exists, and the store workflow, and this tool then adds the per-store verdict from each store's public credential-health record; trust the per-store rows in the result over the platform's bare preflight line, which does not check store health. Pass dryRun:false to actually submit, which is irreversible and enters store review. The target project is identified by your token (extension_login or a release token in EXTENSION_DEV_TOKEN; tokens live at most 7 days, so CI must re-mint from the console's Access tokens page). Store credentials are never tool arguments and local files are not uploaded. Pass browsers + buildSha (extension_release_list lists valid shas); after a real submission, extension_store_status reads the recorded outcome and review state. Posts to the platform's CLI store-submission endpoint.",
  inputSchema: {
    type: "object" as const,
    properties: {
      browsers: {
        type: "array",
        items: {
          type: "string",
          enum: ["chrome", "firefox", "edge"],
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
      "No token. Run extension_login, or set EXTENSION_DEV_TOKEN (create one in the extension.dev dashboard under project settings -> Access tokens; tokens live at most 7 days, so CI must re-mint before expiry).",
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
    // Under dryRun nothing was (or could have been) submitted, so the error
    // must say "preflight failed", never "submit failed".
    return fail(
      "DeployError",
      `${dryRun ? "preflight" : "submit"} failed (${res.status}): ${data?.message || text || "unknown error"}`,
    );
  }

  const warnings: unknown[] = Array.isArray(data?.warnings)
    ? [...data.warnings]
    : [];
  warnings.push(...storeMdWarnings(browsers, process.cwd()));

  const result: Record<string, unknown> = { mode: "platform", dryRun, ...data };

  if (dryRun) {
    // The platform's preflight verifies auth, project, build, and the store
    // workflow - but not the consequence it gates: which stores are actually
    // configured to receive this submission, and in what publish mode. Read
    // what is knowable from the public registry and never echo an
    // unqualified "Preflight OK" per browser.
    const ref = resolveProjectRef();
    const consoleStoresUrl = consoleProjectUrl(ref, "stores");
    const storeModeNote = `Store publish mode (draft / skip-publish / live) is not readable with the CLI token, so it cannot be verified from here; check per-store settings at ${consoleStoresUrl}.`;

    let health: Record<string, { ok?: boolean; message?: string }> | null = null;
    let healthUnreadable: string | null = null;
    let channelRows: ReturnType<typeof parseChannels> | null = null;
    if (ref) {
      const [healthRes, channelsRes] = await Promise.all([
        fetchRegistryJson(registryFileUrl(ref, "stores/health.json")),
        fetchRegistryJson(registryFileUrl(ref, "channels.json")),
      ]);
      if (healthRes.ok) {
        const stores = (healthRes.json as { stores?: unknown })?.stores;
        health =
          stores && typeof stores === "object"
            ? (stores as Record<string, { ok?: boolean; message?: string }>)
            : null;
        if (!health) healthUnreadable = "stores/health.json had no stores map";
      } else {
        healthUnreadable = healthRes.message;
      }
      if (channelsRes.ok) channelRows = parseChannels(channelsRes.json);
    } else {
      healthUnreadable =
        "no stored workspace/project to look up (run extension_login)";
    }

    const preflight = browsers.map((browser) => {
      if (!health) {
        return {
          browser,
          ok: false,
          configured: "unknown" as const,
          publishMode: "unknown",
          reason: `Store configuration could not be read (${healthUnreadable}); verify the ${browser} store in the console before submitting.`,
        };
      }
      const row = health[browser];
      if (!row) {
        return {
          browser,
          ok: false,
          configured: false,
          publishMode: "unknown",
          reason: `No ${browser} store is configured on this project; a real submission for ${browser} would fail. Configure it at ${consoleStoresUrl}.`,
        };
      }
      if (row.ok !== true) {
        return {
          browser,
          ok: false,
          configured: false,
          publishMode: "unknown",
          reason:
            String(row.message || "").trim() ||
            `The ${browser} store failed its last credential health check.`,
        };
      }
      return {
        browser,
        ok: true,
        configured: true as const,
        publishMode: "unknown",
      };
    });

    const actionable = preflight.filter((p) => p.ok).map((p) => p.browser);
    const blocked = preflight.filter((p) => !p.ok);

    // Channel disclosure: the platform silently defaults to "stable", which
    // this project's channels.json may not even contain.
    const channelDefaulted = !String(args.channel || "").trim();
    const resolvedChannel =
      String(data?.channel || "").trim() ||
      (channelDefaulted ? "stable" : String(args.channel).trim());
    if (channelRows) {
      const exists = channelRows.some(
        (r) =>
          r.channel === resolvedChannel ||
          r.channel.endsWith(`-${resolvedChannel}`),
      );
      if (!exists) {
        warnings.push(
          `Channel "${resolvedChannel}"${channelDefaulted ? " (the default)" : ""} does not exist in this project's channels.json (existing: ${
            channelRows.map((r) => r.channel).join(", ") || "none"
          }), so a real submission from it has no promoted build to serve. Promote a build there first (extension_release_promote) or pass an existing channel.`,
        );
      }
    }

    const summaryParts: string[] = [];
    if (actionable.length > 0) {
      summaryParts.push(
        `Preflight passed for ${actionable.join(", ")}: the platform verified auth, the project, build ${
          data?.buildId ?? buildSha
        }, and the store workflow, and the store credentials passed their last health check.`,
      );
    }
    for (const p of blocked) {
      summaryParts.push(
        `${p.browser}: ${p.configured === "unknown" ? "cannot be verified" : "NOT actionable"} - ${p.reason}`,
      );
    }
    summaryParts.push(storeModeNote);

    result.ok = actionable.length > 0;
    result.preflight = preflight;
    result.channel = resolvedChannel;
    result.channelDefaulted = channelDefaulted;
    if (channelDefaulted) {
      result.channelNote = `channel: ${resolvedChannel} (default)`;
    }
    result.consoleStoresUrl = consoleStoresUrl;
    if (typeof data?.message === "string") result.platformMessage = data.message;
    result.message = summaryParts.join(" ");
  }

  if (!dryRun) {
    // Close the post-submit loop: the store journey continues on the public
    // registry, and extension_store_status is the verb that reads it.
    result.statusNote =
      "Track this submission with extension_store_status: it reads the recorded outcome, per-store credential health, and review state from the public registry.";
  }

  if (warnings.length > 0) result.warnings = warnings;
  return JSON.stringify(result);
}
