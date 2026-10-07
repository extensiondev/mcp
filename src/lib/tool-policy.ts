// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { PROJECT_PIN_ENV, isProjectRef, sameProject } from "./credentials";
import { envelope } from "./envelope";

export type FeatureGroup = "local" | "platform";

export const FEATURE_GROUPS: FeatureGroup[] = ["local", "platform"];

export const FEATURES_ENV = "EXTENSION_DEV_FEATURES";
export const NO_SHIP_ENV = "EXTENSION_DEV_NO_SHIP";

export interface ToolAnnotations {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

type Args = Record<string, unknown>;

export interface ToolPolicy {
  group: FeatureGroup;
  annotations: ToolAnnotations;
  ships?: "always" | ((args: Args) => boolean);
  untrusted?: true;
}

const reads = (openWorld = false): ToolAnnotations => ({
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: openWorld,
});

const acts = (
  over: Partial<Omit<ToolAnnotations, "readOnlyHint">> = {},
): ToolAnnotations => ({
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
  ...over,
});

/* @invariant
 * EVERY REGISTERED TOOL HAS EXACTLY ONE ROW, AND A MERGED TOOL TAKES ITS
 * WORST ACTION.
 *
 * A client reads these hints once per tool to decide what to auto-approve, so
 * extension_shares is destructive because revoke is, even though list is the
 * default. `ships` marks a call that reaches people outside this machine: a
 * public link, a channel users install from, a store review queue. No-ship mode
 * hides the tools whose every call ships and refuses the shipping calls of the
 * rest, so a dry run and a share listing keep working. tool-policy.test.ts
 * fails a registered tool with no row and a row with no tool.
 *
 * `untrusted` marks a tool whose answer can carry text a web page or an
 * extension wrote at runtime (DOM, console, storage, titles, eval results,
 * runtime errors, other extensions' names); its envelope is fenced by
 * fenceUntrusted. It is per tool and takes the worst branch for the same
 * reason the hints do. Build, analyze, dev, start and the manifest checks are
 * left out on purpose: they carry the project's own source and compiler
 * output, the same bytes the agent reads unfenced with its own file tools, so
 * a fence there would claim a boundary that does not exist. extension_docs_search
 * is left out for the same kind of reason: it returns excerpts of our own
 * published docs, ranked by a route we run, not text any page wrote.
 */
export const TOOL_POLICY: Record<string, ToolPolicy> = {
  extension_create: { group: "local", annotations: acts({ openWorldHint: true }) },
  extension_templates: { group: "local", annotations: reads(true) },
  extension_docs_search: { group: "local", annotations: reads(true) },
  extension_add_feature: { group: "local", annotations: reads() },
  extension_build: { group: "local", annotations: acts({ idempotentHint: true }) },
  extension_dev: { group: "local", annotations: acts() },
  extension_start: { group: "local", annotations: acts() },
  extension_wait: {
    group: "local",
    annotations: reads(),
    untrusted: true,
  },
  extension_stop: { group: "local", annotations: acts({ idempotentHint: true, destructiveHint: true }) },
  extension_manifest_validate: { group: "local", annotations: reads() },
  extension_theme_verify: { group: "local", annotations: reads() },
  extension_analyze: { group: "local", annotations: reads() },
  extension_assert: {
    group: "local",
    annotations: acts({ idempotentHint: true }),
    untrusted: true,
  },
  extension_inspect: {
    group: "local",
    annotations: acts({ idempotentHint: true }),
    untrusted: true,
  },
  extension_dom_snapshot: {
    group: "local",
    annotations: reads(),
    untrusted: true,
  },
  extension_list_extensions: {
    group: "local",
    annotations: reads(),
    untrusted: true,
  },
  extension_logs: {
    group: "local",
    annotations: reads(),
    untrusted: true,
  },
  extension_doctor: {
    group: "local",
    annotations: reads(),
    untrusted: true,
  },
  extension_eval: {
    group: "local",
    annotations: acts({ destructiveHint: true, openWorldHint: true }),
    untrusted: true,
  },
  extension_storage: {
    group: "local",
    annotations: acts({ destructiveHint: true }),
    untrusted: true,
  },
  extension_reload: {
    group: "local",
    annotations: acts({ idempotentHint: true }),
    untrusted: true,
  },
  extension_open: {
    group: "local",
    annotations: acts({ openWorldHint: true }),
    untrusted: true,
  },
  extension_browsers: {
    group: "local",
    annotations: acts({ destructiveHint: true, openWorldHint: true }),
  },
  extension_auth: { group: "platform", annotations: acts({ openWorldHint: true, destructiveHint: true }) },
  extension_workspace_create: {
    group: "platform",
    annotations: acts({ openWorldHint: true }),
  },
  extension_project_create: {
    group: "platform",
    annotations: acts({ openWorldHint: true }),
  },
  extension_preview_web: {
    group: "platform",
    annotations: acts({ openWorldHint: true }),
    ships: (args) => args.share === true,
  },
  extension_shares: {
    group: "platform",
    annotations: acts({ destructiveHint: true, openWorldHint: true }),
    ships: (args) => args.action === "revoke",
  },
  extension_publish: {
    group: "platform",
    annotations: acts({ openWorldHint: true }),
    ships: "always",
  },
  extension_release_status: { group: "platform", annotations: reads(true) },
  extension_release_promote: {
    group: "platform",
    annotations: acts({ destructiveHint: true, openWorldHint: true }),
    ships: "always",
  },
  extension_submit: {
    group: "platform",
    annotations: acts({ destructiveHint: true, openWorldHint: true }),
    ships: (args) => args.dryRun === false,
  },
};

export interface ServerOptions {
  features: FeatureGroup[];
  noShip: boolean;
  project?: string;
}

/* @invariant
  * THE DEFAULT IS THE LOCAL GROUP ALONE. A server started with no flag and no
  * env exposes the 23 tools that work on this machine and none of the 9
  * platform tools, because the platform is in private alpha and the local
  * tools are what is being put in front of strangers. The platform group
  * comes on only by name: --features=local,platform or
  * EXTENSION_DEV_FEATURES=local,platform. The console's Connect recipes say
  * it explicitly for that reason.
  */
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
  const pinned = options.project;
  if (!pinned) return { args };

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
      (entry) => !entry.includes("/") || !sameProject(entry, pinned),
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

  if (named && !sameProject(named, pinned)) {
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
