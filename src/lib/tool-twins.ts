// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { BUILDS_ACT_TOOL, movedActHint } from "./builds-split";
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
  params: Record<string, Record<string, unknown>>;
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
    params: { action: { description: "get: a key's value, or the whole area with no key." }, key: { description: "Key to read; omitted, the whole area answers." } },
  },
  {
    name: "extension_storage_write",
    of: "extension_storage",
    actions: ["set"],
    group: "extras",
    title: "Write extension storage",
    annotations: writes({ destructiveHint: true }),
    description: "Write one key of the extension's storage (chrome.storage or browser.storage) from its background, with no eval. Answers the key read back in value.readBack; extension_storage_read reads. Needs the session's control channel (on by default in extension_dev).",
    params: { action: { description: "set: one key, read back in value.readBack." }, key: { description: "Key to write." }, area: { enum: ["local", "sync", "session"], description: "local (this device), sync (the browser account) or session (until restart); managed is policy and read-only." } },
  },
  {
    name: "extension_network_read",
    drop: ["method", "url", "status", "body", "json", "contentType", "ruleId", "confirm"],
    of: "extension_network",
    actions: ["list", "requests"],
    group: "extras",
    title: "Read network stubs",
    annotations: reads(),
    description: "List the network stub rules of a Chromium session, or read which requests hit one or missed. Answers the rules and the requests seen; extension_network_stub adds or clears rules. Firefox is refused.",
    params: { action: { description: "list: the rules in force; requests: which requests hit a rule or missed." } },
  },
  {
    name: "extension_network_stub",
    of: "extension_network",
    actions: ["add", "clear"],
    group: "extras",
    title: "Stub network responses",
    annotations: writes({ destructiveHint: true }),
    description: "Add a network stub rule to a Chromium session, or clear the rules. Answers the rules now in force; extension_network_read lists them and the requests seen. Rules last until extension_stop. Firefox is refused.",
    params: { action: { description: "add: install a rule; clear: take one rule down by ruleId, or every rule with confirm." } },
  },
  {
    name: "extension_shares_read",
    drop: ["tokenId", "artifactId", "url", "approvalId", "buildId", "browser"],
    of: "extension_shares",
    actions: ["list"],
    group: "platform",
    title: "List share links",
    annotations: reads(true),
    description: "List a project's emulator preview links and build links on extension.dev. Answers each link and its status; extension_shares_manage creates and revokes, extension_publish makes build links.",
    params: { action: { description: "list: the project's links and their status." } },
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
    params: { action: { description: "create: share a build; revoke: one share, for good." }, kind: { description: "revoke: build-link (extension_publish links), preview (emulator links) or both." } },
  },
  {
    name: "extension_approvals_read",
    of: "extension_approvals",
    actions: ["list", "status"],
    group: "platform",
    title: "List approvals",
    annotations: reads(true),
    description: "List the open approvals this login asked for on extension.dev, or read one. Answers each approval with its id and status; extension_approvals_revoke revokes one.",
    params: { action: { description: "list: the open approvals (the default with no approvalId); status: one approval." }, approvalId: { description: "The apr_ id; status needs it." } },
  },
  {
    name: "extension_approvals_revoke",
    of: "extension_approvals",
    actions: ["revoke"],
    group: "platform",
    title: "Revoke an approval",
    annotations: writes({ destructiveHint: true, openWorldHint: true }),
    description: "Revoke an approval granted by mistake on extension.dev (owner token). Answers the revoked approval; extension_approvals_read lists them.",
    params: { action: { description: "revoke: one approval granted by mistake." }, approvalId: { description: "The apr_ id to revoke." } },
  },
  {
    name: "extension_workspace_read",
    drop: ["visibility", "settings", "variables", "remove", "confirm", "approvalId"],
    of: "extension_workspace",
    actions: ["info", "projects", "usage", "settings"],
    group: "platform",
    title: "Read the workspace",
    annotations: reads(true),
    description: "Read the extension.dev workspace: info, projects, usage and settings. Answers the sections asked; extension_workspace_configure changes settings, visibility and environment.",
    params: { action: { description: "info, projects, usage or settings: the section to answer." } },
  },
  {
    name: "extension_workspace_configure",
    drop: ["include"],
    of: "extension_workspace",
    actions: ["set-visibility", "configure-project", "set-environment"],
    group: "platform",
    title: "Configure a project",
    annotations: writes({ destructiveHint: true, openWorldHint: true }),
    description: "Change a project's settings, visibility or build environment on extension.dev. configure-project renames a project (displayName; slug and URLs stay). set-visibility public or a public liveChannel needs approval. Answers what changed; extension_workspace_read reads.",
    params: { action: { description: "configure-project: project fields; set-visibility: private or public; set-environment: build variables." }, project: { description: "Stored login; the project to change." } },
  },
  {
    name: "extension_auth_read",
    drop: ["projectPath", "projects", "workspace", "deviceCode", "lifetime", "waitSeconds"],
    of: "extension_auth",
    actions: ["status"],
    group: "platform",
    title: "Read the stored logins",
    annotations: reads(true),
    description: "List the extension.dev logins stored on this machine. Answers each login; value.tokenCheck.verdict is confirmed, refused or unavailable. extension_auth_login signs in or clears logins.",
    params: { action: { description: "status: the stored logins." }, project: { description: "'<workspace>/<project>': that login only." } },
  },
  {
    name: "extension_auth_login",
    of: "extension_auth",
    actions: ["login", "logout"],
    group: "platform",
    title: "Log in to extension.dev",
    annotations: writes({ destructiveHint: true, openWorldHint: true }),
    description: "Sign in to an extension.dev project (a code on the linked device page, then deviceCode), or clear stored logins. Answers the login; extension_auth_read lists them. A login lasts a day, or what lifetime says (CI: Access tokens).",
    params: { action: { description: "login signs in; logout deletes only the local login." } },
  },
  {
    name: "extension_browsers_read",
    drop: ["browser", "all", "confirm"],
    of: "extension_browsers",
    actions: ["detect", "list"],
    group: "extras",
    title: "Find the browsers",
    annotations: reads(),
    description: "Find the browsers Extension.js launches: detect scans system and managed ones, list reads the managed cache. Answers each browser with its path and version; extension_browsers_install installs or removes managed ones.",
    params: { action: { description: "detect scans system and managed browsers; list reads the managed cache." } },
  },
  {
    name: "extension_browsers_install",
    drop: ["browsers"],
    of: "extension_browsers",
    actions: ["install", "uninstall"],
    group: "extras",
    title: "Install and remove browsers",
    annotations: writes({ destructiveHint: true, openWorldHint: true }),
    description: "Install or remove a managed browser Extension.js launches; install downloads hundreds of MB in one blocking call, and uninstall never touches a system install. Answers the binary installed or removed; extension_browsers_read finds them.",
    params: { action: { description: "install downloads a managed browser; uninstall removes one." }, browser: { description: "The managed binary." } },
  },
  {
    name: "extension_submit_read",
    drop: ["dryRun", "approvalId", "screenshots", "storeSettings", "buildNumber", "deployPercentage", "connectSession", "replace", "waitSeconds", "workspace", "projectPath", "useBuild", "store", "submissionId"],
    of: "extension_submit",
    actions: ["preflight", "status"],
    group: "platform",
    title: "Read a store submission",
    annotations: reads(true),
    description: "Read a project's store state through extension.dev: preflight answers what each store still needs, status the submissions. extension_submit_check asks approvals and extension_submit runs them.",
    params: { action: { description: "preflight: what each store still needs; status: each store's word on the submissions." }, browsers: { description: "The stores to read." } },
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
    params: { action: { description: "list: recent builds, lastPush; get: one build; logs: its log lines." }, buildId: { description: "Commit sha, never the build number; required for get and logs." }, browser: { description: "chrome, edge, firefox or safari." } },
  },
  {
    name: "extension_builds_download",
    drop: ["limit", "waitSeconds"],
    of: "extension_builds",
    actions: ["download"],
    group: "platform",
    title: "Download a build",
    annotations: writes({ idempotentHint: true, openWorldHint: true }),
    description: "Download a verified package of an extension.dev build to this machine. Answers the saved path; extension_builds_read lists and reads builds.",
    params: { action: { description: "download: a verified package." }, buildId: { description: "Commit sha, never the build number." }, browser: { description: "chrome, edge, firefox, safari, or source; required." } },
  },
  {
    name: "extension_element_read",
    drop: ["value", "x", "y", "points", "button", "text", "key", "modifiers", "deltaX", "deltaY"],
    of: "extension_element",
    actions: ["text", "wait"],
    group: "local",
    title: "Read an element",
    annotations: reads(),
    description: "Read one element's text by CSS selector, or wait until it is visible, in a surface or page. Answers the text or the wait's outcome; extension_element_act clicks, fills and types. Chromium only.",
    params: { action: { description: "text: the element's text; wait: until it is visible." } },
  },
  {
    name: "extension_element_act",
    of: "extension_element",
    actions: ["click", "fill", "move", "press", "release", "type", "key", "scroll"],
    group: "local",
    title: "Act on an element",
    annotations: writes(),
    description: "Click or fill one element by CSS selector, or send trusted mouse and key input to a surface or page, with no caller code and no allowEval. Answers the element's state after the act; extension_element_read, extension_dom_snapshot, extension_inspect and extension_logs read, extension_eval runs code. Chromium only.",
    params: { action: { description: "click (a real mouse press) and fill; move, press, release, type, key and scroll send trusted input." }, timeout: { description: "Timeout ms (default 10000, max 30000)." } },
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
    const moved = twin.of === "extension_builds" ? movedActHint(action) : undefined;

    return envelope({
      ok: false,
      command: twin.name,
      status: "action-not-here",
      error: {
        code: "E_INPUT_VALIDATION",
        message: `${twin.name} takes action ${twin.actions.join(", ")}, not ${String(action)}.`,
        hint: other ? `Call ${other.name} with the same arguments.` : (moved ?? `Call ${twin.of} with the same arguments.`),
      },
      value: { useTool: other?.name ?? (moved ? BUILDS_ACT_TOOL : twin.of) },
    });
  };
}

export function twinArgs(twin: ToolTwin, args: Record<string, unknown>): Record<string, unknown> {
  return typeof args.action === "string" ? args : { ...args, action: twin.actions[0] };
}

export function twinSchema(twin: ToolTwin, of: { inputSchema: Record<string, unknown> }): { name: string; description: string; inputSchema: Record<string, unknown> } {
  const input = of.inputSchema as { properties?: Record<string, Record<string, unknown>>; required?: string[] };
  const properties = Object.fromEntries(Object.entries(input.properties ?? {}).filter(([name]) => !twin.drop?.includes(name)));

  for (const [name, over] of Object.entries(twin.params)) {
    if (properties[name]) properties[name] = { ...properties[name], ...over };
  }

  properties.action = { ...properties.action, enum: twin.actions, default: twin.actions[0] };
  const required = (input.required ?? []).filter((name) => name !== "action" && !twin.drop?.includes(name));

  return {
    name: twin.name,
    description: twin.description,
    inputSchema: { ...of.inputSchema, properties, ...(required.length ? { required } : { required: [] }) },
  };
}

/* @invariant A LISTED WRITE TOOL NEVER ADVERTISES A READ ITS TWIN OWNS.
 * extension_submit and extension_submit_check stay listed, so they cannot
 * become unlisted aliases, yet their reads moved to extension_submit_read
 * and the dry run to extension_submit_check (ledger 1139). Their listed
 * schemas name only acts; a saved call that still sends a moved read keeps
 * its answer, validated against the action enum widened here, and every
 * such answer names the tool that owns the read now, as an old name's does.
 */
export interface MovedRead {
  actions: string[];
  to: string;
  dryRun?: true;
}

export const MOVED_READS: Record<string, MovedRead[]> = {
  extension_submit: [
    { actions: ["preflight", "status"], to: "extension_submit_read" },
    { actions: ["submit"], to: "extension_submit_check", dryRun: true },
  ],
  extension_submit_check: [{ actions: ["preflight", "status"], to: "extension_submit_read" }],
};

const defaultAction = (schema: Record<string, unknown>): string | undefined => {
  const action = (schema.properties as Record<string, { default?: unknown }> | undefined)?.action?.default;

  return typeof action === "string" ? action : undefined;
};

export function movedReadSentence(name: string, args: Record<string, unknown>, schema: Record<string, unknown>): { sentence: string; to: string } | null {
  const action = typeof args.action === "string" && args.action ? args.action : defaultAction(schema);
  const moved = (MOVED_READS[name] ?? []).find((read) => read.actions.includes(String(action)) && (!read.dryRun || args.dryRun !== false));

  if (!moved) return null;

  const what = moved.dryRun ? `${name} with dryRun true` : `${name} action ${String(action)}`;

  return { sentence: `${what} is now ${moved.to}; it still answers here.`, to: moved.to };
}

export function acceptedSchema(name: string, schema: Record<string, unknown>): Record<string, unknown> {
  const moved = (MOVED_READS[name] ?? []).flatMap((read) => (read.dryRun ? [] : read.actions));
  const properties = schema.properties as Record<string, { enum?: unknown[] }> | undefined;
  const action = properties?.action;

  if (!moved.length || !action?.enum) return schema;

  return { ...schema, properties: { ...properties, action: { ...action, enum: [...action.enum, ...moved.filter((read) => !action.enum!.includes(read))] } } };
}

/* @invariant AN ANSWER NAMES ONLY TOOLS ITS READER SERVES. The hosted lane
 * runs the newest kernel, so its answers name the read and write twins, but
 * a forwarder released before the split (11.3.0 and older) lists none of
 * them, and an agent told to call extension_approvals_read met "Unknown
 * tool" (ledger 1198). Every twin is a narrowed view of the tool it splits,
 * taking the same arguments, so an answer bound for such a forwarder names
 * that tool in each twin's place, in every string it carries.
 */
export const LAST_VERSION_WITHOUT_TWINS = [11, 3, 0] as const;

export function servesTwins(version: string | null | undefined): boolean {
  const parts = String(version ?? "").split(/[.+-]/).slice(0, 3).map(Number);
  if (parts.length < 3 || parts.some((part) => !Number.isInteger(part))) return true;

  for (let index = 0; index < 3; index++) {
    if (parts[index]! !== LAST_VERSION_WITHOUT_TWINS[index]) return parts[index]! > LAST_VERSION_WITHOUT_TWINS[index]!;
  }

  return false;
}

const TWIN_NAME = new RegExp(`\\b(${TOOL_TWINS.map((twin) => twin.name).join("|")})\\b`, "g");
const TWIN_OF = new Map(TOOL_TWINS.map((twin) => [twin.name, twin.of]));

function untwinned(value: unknown): unknown {
  if (typeof value === "string") return value.replace(TWIN_NAME, (name) => TWIN_OF.get(name) ?? name);
  if (Array.isArray(value)) return value.map(untwinned);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, untwinned(inner)]));

  return value;
}

export function namedForForwarder<T>(answer: T, forwarderVersion: string | null | undefined): T {
  return servesTwins(forwarderVersion) ? answer : (untwinned(answer) as T);
}
