// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { envelope } from "./envelope";

import type { FeatureGroup } from "./tool-policy";
import type { ToolAnnotations } from "./tool-annotations";

/* @invariant A TOOL THAT BOTH READS AND WRITES IS LISTED AS TWO TOOLS.
 * Cezar ruled on 2026-11-24 (ledger 1108) that every tool whose action enum
 * mixed reads and writes becomes a read-only twin and a write twin, as
 * extension_builds and extension_builds_act already were, since a directory
 * review rejects one tool that accepts both. A twin is a narrowed view of
 * the module that serves it: it lists only its own actions, refuses any
 * other before anything runs, and is answered by that module under its own
 * name. The old name stays callable and unlisted, and each of its answers
 * names the twins in warnings, so a saved prompt keeps working.
 */
export interface ToolTwin {
  name: string;
  of: string;
  actions: string[];
  group: FeatureGroup;
  title: string;
  annotations: ToolAnnotations;
  description: string;
  drop?: string[];
}

const reads = (openWorldHint = false): ToolAnnotations => ({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint });
const writes = (over: Partial<ToolAnnotations> = {}): ToolAnnotations => ({ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false, ...over });

export const TOOL_TWINS: ToolTwin[] = [
  {
    name: "extension_storage_read",
    drop: ["value", "valueJson"],
    of: "extension_storage",
    actions: ["get"],
    group: "extras",
    title: "Read extension storage",
    annotations: reads(),
    description: "Read the extension's storage (chrome.storage or browser.storage) from its background, with no eval. Answers a key's value or the whole area; extension_storage_write sets a key. Needs the session's control channel (on by default in extension_dev).",
  },
  {
    name: "extension_storage_write",
    of: "extension_storage",
    actions: ["set"],
    group: "extras",
    title: "Write extension storage",
    annotations: writes({ destructiveHint: true }),
    description: "Write one key of the extension's storage (chrome.storage or browser.storage) from its background, with no eval. Answers the key read back in value.readBack; extension_storage_read reads. Needs the session's control channel (on by default in extension_dev).",
  },
  {
    name: "extension_network_read",
    drop: ["method", "status", "body", "json", "contentType"],
    of: "extension_network",
    actions: ["list", "requests"],
    group: "extras",
    title: "Read network stubs",
    annotations: reads(),
    description: "List the network stub rules of a Chromium session, or read which requests hit one or missed. Answers the rules and the requests seen; extension_network_stub adds or clears rules. Firefox is refused.",
  },
  {
    name: "extension_network_stub",
    of: "extension_network",
    actions: ["add", "clear"],
    group: "extras",
    title: "Stub network responses",
    annotations: writes(),
    description: "Add a network stub rule to a Chromium session, or clear the rules. Answers the rules now in force; extension_network_read lists them and the requests seen. Rules last until extension_stop. Firefox is refused.",
  },
  {
    name: "extension_shares_read",
    drop: ["tokenId", "artifactId", "url", "approvalId"],
    of: "extension_shares",
    actions: ["list"],
    group: "platform",
    title: "List share links",
    annotations: reads(true),
    description: "List a project's emulator preview links and build links on extension.dev. Answers each link and its status; extension_shares_manage creates and revokes, extension_publish makes build links.",
  },
  {
    name: "extension_shares_manage",
    drop: ["status", "limit"],
    of: "extension_shares",
    actions: ["create", "revoke"],
    group: "platform",
    title: "Create or revoke share links",
    annotations: writes({ destructiveHint: true, openWorldHint: true }),
    description: "Create an emulator preview link for a tester, or revoke a preview or build link, on extension.dev. Answers the link made or revoked; extension_shares_read lists them, extension_publish and extension_preview_web make them. A revoke is permanent and needs a workspace member's approval.",
  },
  {
    name: "extension_approvals_read",
    of: "extension_approvals",
    actions: ["list", "status"],
    group: "platform",
    title: "List approvals",
    annotations: reads(true),
    description: "List the open approvals this login asked for on extension.dev, or read one. Answers each approval with its id and status; extension_approvals_revoke revokes one.",
  },
  {
    name: "extension_approvals_revoke",
    of: "extension_approvals",
    actions: ["revoke"],
    group: "platform",
    title: "Revoke an approval",
    annotations: writes({ destructiveHint: true, openWorldHint: true }),
    description: "Revoke an approval granted by mistake on extension.dev (owner token). Answers the revoked approval; extension_approvals_read lists them.",
  },
  {
    name: "extension_workspace_read",
    drop: ["visibility", "settings", "variables", "remove", "approvalId"],
    of: "extension_workspace",
    actions: ["info", "projects", "usage", "settings"],
    group: "platform",
    title: "Read the workspace",
    annotations: reads(true),
    description: "Read the extension.dev workspace: info, projects, usage and settings. Answers the sections asked; extension_workspace_configure changes settings, visibility and environment.",
  },
  {
    name: "extension_workspace_configure",
    drop: ["include"],
    of: "extension_workspace",
    actions: ["set-visibility", "configure-project", "set-environment"],
    group: "platform",
    title: "Configure a project",
    annotations: writes({ openWorldHint: true }),
    description: "Change a project's settings, visibility or build environment on extension.dev. configure-project renames a project (displayName; slug and URLs stay). set-visibility public or a public liveChannel needs approval. Answers what changed; extension_workspace_read reads.",
  },
  {
    name: "extension_auth_read",
    drop: ["deviceCode", "lifetime", "waitSeconds", "projects"],
    of: "extension_auth",
    actions: ["status"],
    group: "platform",
    title: "Read the stored logins",
    annotations: reads(true),
    description: "List the extension.dev logins stored on this machine. Answers each login; value.tokenCheck.verdict is confirmed, refused or unavailable. extension_auth_login signs in or clears logins.",
  },
  {
    name: "extension_auth_login",
    of: "extension_auth",
    actions: ["login", "logout"],
    group: "platform",
    title: "Log in to extension.dev",
    annotations: writes({ destructiveHint: true, openWorldHint: true }),
    description: "Sign in to an extension.dev project (a code at extension.dev/device, then deviceCode), or clear stored logins. Answers the login; extension_auth_read lists them. A login lasts a day, or what lifetime says (CI: Access tokens).",
  },
  {
    name: "extension_browsers_read",
    of: "extension_browsers",
    actions: ["detect", "list"],
    group: "extras",
    title: "Find the browsers",
    annotations: reads(),
    description: "Find the browsers Extension.js launches: detect scans system and managed ones, list reads the managed cache. Answers each browser with its path and version; extension_browsers_install installs or removes managed ones.",
  },
  {
    name: "extension_browsers_install",
    of: "extension_browsers",
    actions: ["install", "uninstall"],
    group: "extras",
    title: "Install and remove browsers",
    annotations: writes({ destructiveHint: true, openWorldHint: true }),
    description: "Install or remove a managed browser Extension.js launches; install downloads hundreds of MB in one blocking call, and uninstall never touches a system install. Answers the binary installed or removed; extension_browsers_read finds them.",
  },
  {
    name: "extension_submit_read",
    drop: ["dryRun", "approvalId", "screenshots", "storeSettings", "buildNumber", "deployPercentage", "connectSession", "replace", "waitSeconds"],
    of: "extension_submit",
    actions: ["preflight", "status"],
    group: "platform",
    title: "Read a store submission",
    annotations: reads(true),
    description: "Read a project's store state through extension.dev: preflight answers what each store still needs, status the submissions. extension_submit_check asks approvals and extension_submit runs them.",
  },
  {
    name: "extension_builds_read",
    drop: ["to"],
    of: "extension_builds",
    actions: ["list", "get", "logs"],
    group: "platform",
    title: "Read the builds",
    annotations: reads(true),
    description: "Read builds made on extension.dev: list recent ones, get one, or read its logs. Answers rows with env and the channels holding each; extension_builds_download saves a verified package, extension_builds_act rebuilds, extension_build and extension_analyze work on this machine.",
  },
  {
    name: "extension_builds_download",
    drop: ["limit"],
    of: "extension_builds",
    actions: ["download"],
    group: "platform",
    title: "Download a build",
    annotations: writes({ idempotentHint: true, openWorldHint: true }),
    description: "Download a verified package of an extension.dev build to this machine. Answers the saved path; extension_builds_read lists and reads builds.",
  },
  {
    name: "extension_element_read",
    drop: ["value", "x", "y", "points", "button", "text", "key", "modifiers", "deltaX", "deltaY"],
    of: "extension_element",
    actions: ["text", "wait"],
    group: "extras",
    title: "Read an element",
    annotations: reads(),
    description: "Read one element's text by CSS selector, or wait until it is visible, in a surface or page. Answers the text or the wait's outcome; extension_element_act clicks, fills and types. Chromium only.",
  },
  {
    name: "extension_element_act",
    of: "extension_element",
    actions: ["click", "fill", "move", "press", "release", "type", "key", "scroll"],
    group: "local",
    title: "Act on an element",
    annotations: writes(),
    description: "Click or fill one element by CSS selector, or send trusted mouse and key input to a surface or page, with no caller code and no allowEval. Answers the element's state after the act; extension_element_read, extension_dom_snapshot, extension_inspect and extension_logs read, extension_eval runs code. Chromium only.",
  },
];

export const TWIN_ALIASES: Record<string, string[]> = TOOL_TWINS.reduce<Record<string, string[]>>((aliases, twin) => {
  if (twin.of === "extension_submit") return aliases;

  return { ...aliases, [twin.of]: [...(aliases[twin.of] ?? []), twin.name] };
}, {});

export function twinRefusal(twin: ToolTwin): (args: Record<string, unknown>) => string | null {
  return (args) => {
    const action = typeof args.action === "string" ? args.action : twin.actions[0];

    if (twin.actions.includes(action as string)) return null;

    const other = TOOL_TWINS.find((candidate) => candidate.of === twin.of && candidate.actions.includes(action as string));

    return envelope({
      ok: false,
      command: twin.name,
      status: "action-not-here",
      error: {
        code: "E_INPUT_VALIDATION",
        message: `${twin.name} takes action ${twin.actions.join(", ")}, not ${String(action)}.`,
        hint: other ? `Call ${other.name} with the same arguments.` : `Call ${twin.of} with the same arguments.`,
      },
      value: { useTool: other?.name ?? twin.of },
    });
  };
}

export function twinArgs(twin: ToolTwin, args: Record<string, unknown>): Record<string, unknown> {
  return typeof args.action === "string" ? args : { ...args, action: twin.actions[0] };
}

export function twinSchema(twin: ToolTwin, of: { inputSchema: Record<string, unknown> }): { name: string; description: string; inputSchema: Record<string, unknown> } {
  const input = of.inputSchema as { properties?: Record<string, Record<string, unknown>>; required?: string[] };
  const properties = Object.fromEntries(Object.entries(input.properties ?? {}).filter(([name]) => !twin.drop?.includes(name)));
  const action = properties.action ?? {};
  properties.action = { ...action, enum: twin.actions, default: twin.actions[0] };
  const required = (input.required ?? []).filter((name) => name !== "action" && !twin.drop?.includes(name));

  return {
    name: twin.name,
    description: twin.description,
    inputSchema: { ...of.inputSchema, properties, ...(required.length ? { required } : { required: [] }) },
  };
}
