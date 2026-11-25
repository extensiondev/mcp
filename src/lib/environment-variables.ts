// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { APPROVAL_GATE_ENV } from "./approval-gate-env";
import { NO_AUTO_OPEN_ENV } from "./approval-open";
import { PROJECT_PIN_ENV } from "./credentials";
import { ENGINE_BIN_ENV, ENGINE_DIR_ENV } from "./engine-override";
import { FORWARD_URL_OVERRIDE } from "./forward-credential";
import { ISOLATED_ROOT_ENV } from "./isolated-run";
import { NO_TELEMETRY_ENV } from "./session-identity";
import { FEATURES_ENV, NO_SHIP_ENV } from "./tool-policy";
import { TRY_ROOT_ENV } from "./try-runs";

export interface UserVariable {
  name: string;
  internal?: false;
  description: string;
  isSecret?: true;
  format?: "boolean" | "filepath";
  default?: string;
  choices?: string[];
  placeholder?: string;
}

export interface InternalVariable {
  name: string;
  internal: true;
  why: string;
}

export type EnvironmentVariable = UserVariable | InternalVariable;

const FEATURE_CHOICES = ["local", "local,platform", "local,extras", "local,platform,extras"];

export const ENVIRONMENT_VARIABLES: EnvironmentVariable[] = [
  {
    name: FEATURES_ENV,
    description: "Same as --features: the tool groups to expose.",
    default: "local",
    choices: FEATURE_CHOICES,
  },
  {
    name: NO_SHIP_ENV,
    description:
      "Set to 1 to refuse every call that puts something in front of other people: publish, promote, a real store submit, a share link or a share revoke. The --no-ship flag does the same.",
    format: "boolean",
  },
  {
    name: PROJECT_PIN_ENV,
    description: "Same as --project: pin the server to one extension.dev project.",
    placeholder: "<workspace>/<project>",
  },
  {
    name: "EXTENSION_DEV_TOKEN",
    description: "An extension.dev access token the platform tools send in place of the device login, for CI.",
    isSecret: true,
  },
  {
    name: "EXTENSION_DEV_API_URL",
    description:
      "Base URL of the extension.dev platform the platform tools and docs search call, an extension.dev host or a local development server. Unset: https://www.extension.dev.",
    placeholder: "https://www.extension.dev",
  },
  {
    name: NO_AUTO_OPEN_ENV,
    description:
      "Set to 1 to stop the server from opening the approval page in the default browser when a platform act needs a human approval.",
    format: "boolean",
  },
  {
    name: NO_TELEMETRY_ENV,
    description:
      "Set to 1 to send no telemetry (the one scaffold event and the per-install id header). DO_NOT_TRACK=1 does the same.",
    format: "boolean",
  },
  {
    name: "DO_NOT_TRACK",
    description: "Set to 1 to send no telemetry, the same as EXTENSION_DEV_NO_TELEMETRY=1.",
    format: "boolean",
  },
  {
    name: "EXTENSION_MCP_CLI_VERSION",
    description: "The Extension.js engine version to run when the project has none of its own. Unset: the version this release pins.",
    placeholder: "<version>",
  },
  {
    name: ENGINE_DIR_ENV,
    description: "Run every engine command from this compiled Extension.js checkout instead of the published engine.",
    format: "filepath",
  },
  {
    name: ENGINE_BIN_ENV,
    description: "Run every engine command from this one engine bin file instead of the published engine.",
    format: "filepath",
  },
  {
    name: "EXTENSION_HEADLESS",
    description: "Set to 1 to launch every browser the server starts headless, unless a call passes headless: false.",
    format: "boolean",
  },
  {
    name: "EXTENSION_BROWSER_FLAGS",
    description: "Extra command line flags for every browser the engine starts, separated by spaces. A --headless flag here counts as EXTENSION_HEADLESS=1.",
    placeholder: "--lang=en-US",
  },
  {
    name: "EXT_BROWSERS_CACHE_DIR",
    description: "Folder that holds the managed browsers extension_browsers_install installs. Unset: the per-user extension.js browsers cache.",
    format: "filepath",
  },
  {
    name: "EXTENSION_MCP_SESSION_DIR",
    description: "Folder for the running sessions' state files. Unset: extension-dev-mcp-sessions in the system temporary folder.",
    format: "filepath",
  },
  {
    name: TRY_ROOT_ENV,
    description: "Folder where extension_try unpacks a published build. Unset: extension-try in the system temporary folder.",
    format: "filepath",
  },
  {
    name: ISOLATED_ROOT_ENV,
    description: "Folder for isolated runs, which build and open a copy of the project. Unset: extension-isolated in the system temporary folder.",
    format: "filepath",
  },
  {
    name: "EXTENSION_KEEP_SOCKET_PROCESS",
    description: "Set to 1 on Linux to keep Firefox's socket process when the engine is older than 4.3.0, where the server turns it off by default.",
    format: "boolean",
  },
  { name: "EXTENSION_DEV_CONSOLE_URL", internal: true, why: "development origin override" },
  { name: "EXTENSION_DEV_INSPECT_URL", internal: true, why: "development origin override" },
  { name: "EXTENSION_DEV_PREVIEW_URL", internal: true, why: "development origin override" },
  { name: "EXTENSION_DEV_USERLAND_URL", internal: true, why: "development origin override" },
  { name: "EXTENSION_DEV_REGISTRY_URL", internal: true, why: "development origin override" },
  { name: FORWARD_URL_OVERRIDE, internal: true, why: "development origin override" },
  { name: "EXTENSION_MEDIA_ORIGIN", internal: true, why: "development origin override" },
  { name: "EXTENSION_DEV_POSTHOG_HOST", internal: true, why: "telemetry development override" },
  { name: "EXTENSION_DEV_POSTHOG_KEY", internal: true, why: "telemetry development override" },
  { name: "EXTENSION_DEV_POSTHOG_KEY_NONPRODUCTION", internal: true, why: "telemetry development override" },
  { name: "EXTENSION_TEMPLATES_CATALOG_URL", internal: true, why: "template catalog development override" },
  { name: "EXTENSION_TEMPLATES_COMMIT", internal: true, why: "template catalog development override" },
  { name: APPROVAL_GATE_ENV, internal: true, why: "approval gate test switch" },
  { name: "EXTENSION_MCP_BUILD_ID", internal: true, why: "written at compile time" },
  { name: "EXTENSION_OUTPUT", internal: true, why: "set by the server for the engine it runs" },
  { name: "EXTENSION_CREATE_TEMPLATE_REF", internal: true, why: "set by the server for the scaffold it runs" },
];

export function userVariables(): UserVariable[] {
  return ENVIRONMENT_VARIABLES.filter((variable): variable is UserVariable => !variable.internal);
}

export function internalVariables(): InternalVariable[] {
  return ENVIRONMENT_VARIABLES.filter((variable): variable is InternalVariable => variable.internal === true);
}

export function registryEnvironmentVariables(): Array<Record<string, unknown>> {
  return userVariables().map(({ name, description, isSecret, format, default: fallback, choices, placeholder }) => ({
    name,
    description,
    ...(isSecret ? { isSecret } : {}),
    ...(format ? { format } : {}),
    ...(fallback !== undefined ? { default: fallback } : {}),
    ...(choices ? { choices } : {}),
    ...(placeholder ? { placeholder } : {}),
  }));
}

export function internalVariablesLine(): string {
  return `Internal overrides for development and tests, not for normal use: ${internalVariables()
    .map(({ name }) => `\`${name}\``)
    .join(", ")}.`;
}
