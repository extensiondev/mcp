// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { PROJECT_PIN_ENV, isProjectRef, pinnedProject, sameProject } from "./credentials";
import { envelope } from "./envelope";
import { sameStoredProject } from "./project-identity";
import { submitCheckRefused, submitShips } from "./submit-action-safety";
import { TOOL_ANNOTATIONS, type ToolAnnotations } from "./tool-annotations";

export type { ToolAnnotations } from "./tool-annotations";

export type FeatureGroup = "local" | "platform";

export const FEATURE_GROUPS: FeatureGroup[] = ["local", "platform"];

export const FEATURES_ENV = "EXTENSION_DEV_FEATURES";
export const NO_SHIP_ENV = "EXTENSION_DEV_NO_SHIP";

type Args = Record<string, unknown>;

export interface ToolPolicy {
  group: FeatureGroup;
  annotations: ToolAnnotations;
  ships?: "always" | ((args: Args) => boolean);
  untrusted?: true;
  actsAs?: { tool: string; refuse: (args: Args) => string | null };
}

/* @invariant EVERY TOOL CARRIES A TITLE, THE VERB PHRASE A CLIENT SHOWS IN A
 * CONSENT PROMPT. Without one the person approving a call reads the raw tool
 * name; with one they read what the call does, the same words the approval
 * page uses for the act. Two to five words, a capital verb first.
 */
export const TOOL_TITLES: Record<string, string> = {
  extension_create: "Create an extension",
  extension_templates: "List the templates",
  extension_docs_search: "Search the docs",
  extension_add_feature: "Plan a feature",
  extension_build: "Build the extension locally",
  extension_dev: "Run the dev session",
  extension_start: "Start a browser",
  extension_wait: "Wait for the session",
  extension_stop: "Stop the session",
  extension_manifest_validate: "Validate the manifest",
  extension_theme_verify: "Verify a theme",
  extension_analyze: "Analyze the extension",
  extension_assert: "Assert on a page",
  extension_inspect: "Inspect a live page",
  extension_dom_snapshot: "Snapshot the page",
  extension_element: "Act on an element",
  extension_screenshot: "Take a screenshot",
  extension_try: "Try a published extension",
  extension_list_extensions: "List the loaded extensions",
  extension_logs: "Read the console",
  extension_doctor: "Diagnose the session",
  extension_eval: "Evaluate code in a context",
  extension_storage: "Read extension storage",
  extension_network: "Stub network responses",
  extension_reload: "Reload the extension",
  extension_open: "Open a surface",
  extension_browsers: "List the browsers",
  extension_auth: "Log in to extension.dev",
  extension_workspace_create: "Create a workspace",
  extension_project_create: "Create a project",
  extension_preview_web: "Preview on the web",
  extension_shares: "Manage share links",
  extension_publish: "Publish a build link",
  extension_release_status: "Read the release status",
  extension_approvals: "Read or revoke an approval",
  extension_builds: "Read and rebuild builds",
  extension_workspace: "Read or change the workspace",
  extension_release_promote: "Promote a release",
  extension_submit: "Submit to a store",
  extension_submit_check: "Check a store submission",
};

export function toolTitle(name: string): string {
  return TOOL_TITLES[name] ?? name;
}

export const TOOL_POLICY: Record<string, ToolPolicy> = {
  extension_create: { group: "local", annotations: TOOL_ANNOTATIONS.extension_create },
  extension_templates: { group: "local", annotations: TOOL_ANNOTATIONS.extension_templates },
  extension_docs_search: { group: "local", annotations: TOOL_ANNOTATIONS.extension_docs_search },
  extension_add_feature: { group: "local", annotations: TOOL_ANNOTATIONS.extension_add_feature },
  extension_build: { group: "local", annotations: TOOL_ANNOTATIONS.extension_build },
  extension_dev: { group: "local", annotations: TOOL_ANNOTATIONS.extension_dev },
  extension_start: { group: "local", annotations: TOOL_ANNOTATIONS.extension_start },
  extension_wait: {
    group: "local",
    annotations: TOOL_ANNOTATIONS.extension_wait,
    untrusted: true,
  },
  extension_stop: { group: "local", annotations: TOOL_ANNOTATIONS.extension_stop },
  extension_manifest_validate: { group: "local", annotations: TOOL_ANNOTATIONS.extension_manifest_validate },
  extension_theme_verify: { group: "local", annotations: TOOL_ANNOTATIONS.extension_theme_verify },
  extension_analyze: { group: "local", annotations: TOOL_ANNOTATIONS.extension_analyze },
  extension_assert: {
    group: "local",
    annotations: TOOL_ANNOTATIONS.extension_assert,
    untrusted: true,
  },
  extension_inspect: {
    group: "local",
    annotations: TOOL_ANNOTATIONS.extension_inspect,
    untrusted: true,
  },
  extension_dom_snapshot: {
    group: "local",
    annotations: TOOL_ANNOTATIONS.extension_dom_snapshot,
    untrusted: true,
  },
  extension_element: { group: "local", annotations: acts(), untrusted: true },
  extension_screenshot: {
    group: "local",
    annotations: TOOL_ANNOTATIONS.extension_screenshot,
    untrusted: true,
  },
  extension_try: {
    group: "local",
    annotations: TOOL_ANNOTATIONS.extension_try,
    untrusted: true,
  },
  extension_list_extensions: {
    group: "local",
    annotations: TOOL_ANNOTATIONS.extension_list_extensions,
    untrusted: true,
  },
  extension_logs: {
    group: "local",
    annotations: TOOL_ANNOTATIONS.extension_logs,
    untrusted: true,
  },
  extension_doctor: {
    group: "local",
    annotations: TOOL_ANNOTATIONS.extension_doctor,
    untrusted: true,
  },
  extension_eval: {
    group: "local",
    annotations: TOOL_ANNOTATIONS.extension_eval,
    untrusted: true,
  },
  extension_storage: {
    group: "local",
    annotations: TOOL_ANNOTATIONS.extension_storage,
    untrusted: true,
  },
  extension_reload: {
    group: "local",
    annotations: TOOL_ANNOTATIONS.extension_reload,
    untrusted: true,
  },
  extension_network: {
    group: "local",
    annotations: acts(),
    untrusted: true,
  },
  extension_open: {
    group: "local",
    annotations: TOOL_ANNOTATIONS.extension_open,
    untrusted: true,
  },
  extension_browsers: {
    group: "local",
    annotations: TOOL_ANNOTATIONS.extension_browsers,
  },
  extension_auth: { group: "platform", annotations: TOOL_ANNOTATIONS.extension_auth },
  extension_workspace_create: {
    group: "platform",
    annotations: TOOL_ANNOTATIONS.extension_workspace_create,
  },
  extension_project_create: {
    group: "platform",
    annotations: TOOL_ANNOTATIONS.extension_project_create,
  },
  extension_preview_web: {
    group: "platform",
    annotations: TOOL_ANNOTATIONS.extension_preview_web,
    ships: (args) => args.share === true,
  },
  extension_shares: {
    group: "platform",
    annotations: TOOL_ANNOTATIONS.extension_shares,
    ships: (args) => args.action === "revoke" || args.action === "create",
  },
  extension_publish: {
    group: "platform",
    annotations: TOOL_ANNOTATIONS.extension_publish,
    ships: "always",
  },
  extension_release_status: { group: "platform", annotations: TOOL_ANNOTATIONS.extension_release_status },
  extension_approvals: {
    group: "platform",
    annotations: TOOL_ANNOTATIONS.extension_approvals,
  },
  extension_builds: {
    group: "platform",
    annotations: TOOL_ANNOTATIONS.extension_builds,
    untrusted: true,
  },
  extension_workspace: {
    group: "platform",
    annotations: TOOL_ANNOTATIONS.extension_workspace,
    untrusted: true,
  },
  extension_release_promote: {
    group: "platform",
    annotations: TOOL_ANNOTATIONS.extension_release_promote,
    ships: "always",
  },
  extension_submit: {
    group: "platform",
    annotations: TOOL_ANNOTATIONS.extension_submit,
    ships: submitShips,
  },
  extension_submit_check: {
    group: "platform",
    annotations: TOOL_ANNOTATIONS.extension_submit_check,
    actsAs: { tool: "extension_submit", refuse: submitCheckRefused },
  },
};

export interface ServerOptions {
  features: FeatureGroup[];
  noShip: boolean;
  project?: string;
}

export const DEFAULT_SERVER_OPTIONS: ServerOptions = {
  features: ["local"],
  noShip: false,
};

const truthy = (raw: string | undefined): boolean => {
  const value = String(raw ?? "").trim().toLowerCase();

  return value !== "" && value !== "0" && value !== "false" && value !== "off";
};

export function isServerFlag(arg: string): boolean {
  return (
    arg === "--no-ship" ||
    arg === "--features" ||
    arg.startsWith("--features=") ||
    arg === "--project" ||
    arg.startsWith("--project=")
  );
}

export function resolveServerOptions(
  argv: string[],
  env: Record<string, string | undefined>,
): { ok: true; options: ServerOptions } | { ok: false; message: string } {
  let rawFeatures = env[FEATURES_ENV];
  let noShip = truthy(env[NO_SHIP_ENV]);
  let project = String(env[PROJECT_PIN_ENV] || "").trim().toLowerCase();

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--no-ship") noShip = true;
    else if (arg === "--features") rawFeatures = argv[++i] ?? "";
    else if (arg.startsWith("--features=")) rawFeatures = arg.slice("--features=".length);
    else if (arg === "--project") project = String(argv[++i] ?? "").trim().toLowerCase();
    else if (arg.startsWith("--project=")) project = arg.slice("--project=".length).trim().toLowerCase();
    else return { ok: false, message: `Unknown flag "${arg}".` };
  }

  if (project && !isProjectRef(project)) {
    return {
      ok: false,
      message: `--project takes "<workspace>/<project>", got "${project}".`,
    };
  }

  const pin = project ? { project } : {};

  if (rawFeatures === undefined || rawFeatures.trim() === "") {
    return {
      ok: true,
      options: { features: [...DEFAULT_SERVER_OPTIONS.features], noShip, ...pin },
    };
  }

  const names = rawFeatures
    .split(",")
    .map((name) => name.trim().toLowerCase())
    .filter(Boolean);
  const unknown = names.filter(
    (name) => !FEATURE_GROUPS.includes(name as FeatureGroup),
  );

  if (unknown.length) {
    return {
      ok: false,
      message: `Unknown feature group ${unknown.map((n) => `"${n}"`).join(", ")}. Use ${FEATURE_GROUPS.join(" or ")}, comma-separated.`,
    };
  }

  const features = FEATURE_GROUPS.filter((group) => names.includes(group));

  return { ok: true, options: { features, noShip, ...pin } };
}

export function isToolListed(name: string, options: ServerOptions): boolean {
  const policy = TOOL_POLICY[name];
  if (!policy) return false;
  if (!options.features.includes(policy.group)) return false;

  return !(options.noShip && policy.ships === "always");
}

let activeServerOptions: ServerOptions = DEFAULT_SERVER_OPTIONS;

export function setServerOptions(options: ServerOptions): void {
  activeServerOptions = options;
}

export function platformListed(): boolean {
  return isToolListed("extension_publish", activeServerOptions);
}

export function disabledToolEnvelope(
  name: string,
  args: Args,
  options: ServerOptions,
): string | null {
  const policy = TOOL_POLICY[name];
  if (!policy) return null;

  if (!options.features.includes(policy.group)) {
    return envelope({
      ok: false,
      command: name,
      status: "tool-disabled",
      error: {
        code: "E_TOOL_DISABLED",
        message: `${name} is in the "${policy.group}" feature group, which this server was started without.`,
      },
      value: { group: policy.group, features: options.features },
      hint: `Add ${policy.group} to --features (or ${FEATURES_ENV}) in this server's MCP config, or ask the user to.`,
    });
  }

  const ships =
    policy.ships === "always" ||
    (typeof policy.ships === "function" && policy.ships(args));

  if (options.noShip && ships) {
    return envelope({
      ok: false,
      command: name,
      status: "tool-disabled",
      error: {
        code: "E_TOOL_DISABLED",
        message: `${name} with these arguments reaches people outside this machine, and this server was started in no-ship mode.`,
      },
      value: { noShip: true },
      hint: `Dry runs, previews without share, and listing still work. To ship, the user removes --no-ship (or ${NO_SHIP_ENV}) from this server's MCP config.`,
    });
  }

  return null;
}

export function pinProjectArgs(
  name: string,
  args: Args,
  inputSchema: Record<string, unknown>,
  options: ServerOptions,
): { args: Args } | { refused: string } {
  const pinned = options.project ? pinnedProject() || options.project : "";
  if (!pinned) return { args };

  const api = typeof args.api === "string" ? args.api : undefined;
  const isPinned = (entry: string): boolean => sameProject(entry, pinned) || sameStoredProject(api, entry, pinned);

  if (args.projects !== undefined && args.projects !== null) {
    const entries = Array.isArray(args.projects) ? args.projects : [args.projects];
    const names = entries.map((entry) =>
      typeof entry === "string"
        ? entry.trim()
        : entry && typeof entry === "object" && !Array.isArray(entry)
          ? String((entry as { project?: unknown }).project ?? "").trim()
          : "",
    );
    const others = names.filter(
      (entry) => !entry.includes("/") || !isPinned(entry),
    );

    if (others.length > 0 || entries.length === 0) {
      const shown = others.map((entry) => entry || "(an unnamed entry)");

      return {
        refused: envelope({
          ok: false,
          command: name,
          status: "project-pinned",
          error: {
            code: "E_TOOL_DISABLED",
            message: `This server is pinned to ${pinned} and was asked to act on a list naming ${
              shown.length ? shown.join(", ") : "no project"
            }.`,
          },
          value: { pinned, named: shown },
          hint: `A pinned server takes a batch only when every entry is ${pinned}. Work on other projects through an MCP server configured without --project, or with its own --project (or ${PROJECT_PIN_ENV}).`,
        }),
      };
    }

    return { args };
  }

  const named = typeof args.project === "string" ? args.project : "";

  if (named && !isPinned(named)) {
    return {
      refused: envelope({
        ok: false,
        command: name,
        status: "project-pinned",
        error: {
          code: "E_TOOL_DISABLED",
          message: `This server is pinned to ${pinned} and was asked to act on ${named}.`,
        },
        value: { pinned, named },
        hint: `Work on ${named} through an MCP server configured with --project ${named}, or change this server's --project (or ${PROJECT_PIN_ENV}).`,
      }),
    };
  }

  const properties = (inputSchema.properties ?? {}) as Record<string, unknown>;
  const statusOnly = name === "extension_auth" && args.action === "status";
  if (named || statusOnly || !("project" in properties)) return { args };

  return { args: { ...args, project: pinned } };
}
