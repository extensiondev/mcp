// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { ConsoleProjectPage } from "@extension.dev/urls/paths";

import { consoleProjectUrl } from "../lib/console-urls";
import { resolveCredential } from "../lib/credential-source";
import { envelope } from "../lib/envelope";
import { openProjectApi, projectApiGet, projectApiOpenFailure, projectApiSend, type ProjectApi } from "../lib/project-api";
import { isRow, text } from "../lib/ship-act";
import { trackUrl } from "../lib/track-url";
import { COMMAND, refusal } from "./workspace-configure";

export const SET_ENVIRONMENT = "set-environment";
export const ENVIRONMENT_ACTION = "extension_settings.environment";
export const SECRET_CONSOLE_ONLY = "SECRET_CONSOLE_ONLY";
export const ENVIRONMENT_SCOPES = ["all", "production", "staging"] as const;

const NAME = /^[A-Z][A-Z0-9_]*$/;
const ROUTE = "settings/env";

type Row = Record<string, unknown>;

export interface EnvironmentVariable {
  name: string;
  scope: string;
  note: string;
  secret: boolean;
  hasValue: boolean;
  updatedAt: string | null;
}

export interface SetEnvironmentArgs {
  variables?: unknown;
  remove?: unknown;
  project?: string;
  api?: string;
}

interface SetEntry {
  key: string;
  value: string;
  scope: string;
  note?: string;
}

interface RemoveEntry {
  key: string;
  scope: string;
}

/* @invariant A VARIABLE'S VALUE NEVER COMES BACK. The platform stores every
 * value as a CI secret and answers none of them; this view copies the fields
 * it names and never a value field, so a platform that one day answered one
 * would still not reach the chat. The secret flag is the platform's tier:
 * anything not stored as plaintext is a secret.
 */
export function environmentRows(json: Row): EnvironmentVariable[] {
  return (Array.isArray(json.envVars) ? json.envVars : [])
    .filter(isRow)
    .map((raw) => {
      const added = Number(raw.addedAt);

      return {
        name: text(raw.key),
        scope: text(raw.scope) || "all",
        note: text(raw.note),
        secret: text(raw.tier).toLowerCase() !== "plaintext",
        hasValue: raw.hasValue === true,
        updatedAt: Number.isFinite(added) && added > 0 ? new Date(added).toISOString() : null,
      };
    })
    .filter((row) => row.name);
}

export function environmentPage(ref: ProjectApi["ref"] | null, apiHint?: string): string {
  return consoleProjectUrl(ref, ConsoleProjectPage.projectSettingsSection("environment"), apiHint);
}

export async function readEnvironment(api: ProjectApi, apiHint?: string): Promise<{ value: Row; say: string } | { warning: string }> {
  const consoleUrl = environmentPage(api.ref, apiHint);
  const read = await projectApiGet<Row>(api, ROUTE);

  if (!read.ok) {
    return { warning: `The environment variables could not be read (${read.message}); the console lists them at ${consoleUrl}.` };
  }

  const variables = environmentRows(read.json);
  const secrets = variables.filter((row) => row.secret).length;

  return {
    value: { variables, consoleUrl, scopes: [...ENVIRONMENT_SCOPES] },
    say: `${variables.length} environment variable${variables.length === 1 ? "" : "s"} (${secrets} secret) are set; names and flags only, never a value. A plain variable is set or removed with action "set-environment"; a secret's value is only ever typed at ${consoleUrl}.`,
  };
}

function badRequest(name: string, message: string, extra: Row = {}): string {
  return envelope({
    ok: false,
    command: COMMAND,
    status: "bad-request",
    value: { action: SET_ENVIRONMENT, ...extra },
    error: { code: "E_BAD_REQUEST", name, message },
  });
}

function scopeOf(value: unknown): string | null {
  const scope = text(value).toLowerCase() || "all";

  return (ENVIRONMENT_SCOPES as readonly string[]).includes(scope) ? scope : null;
}

export function readEnvironmentChange(args: SetEnvironmentArgs): { set: SetEntry[]; remove: RemoveEntry[] } | { problem: string } | { secret: string[] } {
  const rawSet = Array.isArray(args.variables) ? args.variables : [];
  const rawRemove = Array.isArray(args.remove) ? args.remove : [];

  if ((args.variables !== undefined && !Array.isArray(args.variables)) || (args.remove !== undefined && !Array.isArray(args.remove))) {
    return { problem: "variables and remove must be arrays." };
  }

  if (!rawSet.length && !rawRemove.length) return { problem: "set-environment needs variables to set, remove, or both." };

  const secret: string[] = [];
  const set: SetEntry[] = [];
  const remove: RemoveEntry[] = [];

  for (const entry of rawSet) {
    if (!isRow(entry)) return { problem: "Each of variables must be an object with name and value." };

    const key = text(entry.name);
    if (!NAME.test(key)) return { problem: `"${key || "(empty)"}" is not a variable name; use upper-case letters, digits and underscores, starting with a letter.` };
    if (typeof entry.value !== "string" || !entry.value.length) return { problem: `${key} needs a non-empty string value.` };

    const scope = scopeOf(entry.scope);
    if (!scope) return { problem: `${key}: scope must be one of ${ENVIRONMENT_SCOPES.join(", ")}.` };
    if (entry.secret === true) secret.push(key);

    set.push({ key, value: entry.value, scope, ...(text(entry.note) ? { note: text(entry.note) } : {}) });
  }

  for (const entry of rawRemove) {
    const row: Row = isRow(entry) ? entry : { name: entry };
    const key = text(row.name);
    if (!NAME.test(key)) return { problem: `remove names "${key || "(empty)"}", which is not a variable name.` };

    const scope = scopeOf(row.scope);
    if (!scope) return { problem: `${key}: scope must be one of ${ENVIRONMENT_SCOPES.join(", ")}.` };

    remove.push({ key, scope });
  }

  if (secret.length) return { secret };

  return { set, remove };
}

/* @invariant A SECRET NEVER CROSSES THIS SERVER. A variable flagged secret
 * is refused before anything is sent, with the console environment page
 * where a person types it; a variable the platform stores as a secret is
 * refused by the platform (CONSOLE_ONLY), answered here under the same code;
 * and no answer or refusal from this tool carries a value, flagged or not.
 */
function secretConsoleOnly(names: string[], consoleUrl: string, platformCode?: string): string {
  const list = names.join(", ");
  const say = `${list} ${names.length === 1 ? "is a secret, and its value is" : "are secrets, and their values are"} typed only in the console, at ${consoleUrl}. Nothing was sent.`;

  return envelope({
    ok: false,
    command: COMMAND,
    status: "secret-console-only",
    value: { action: SET_ENVIRONMENT, names, consoleUrl, trackUrl: consoleUrl, sayToPerson: say, nextStep: { kind: "console", say, url: consoleUrl } },
    error: {
      code: "E_CONSOLE_ONLY",
      name: "SecretConsoleOnly",
      ...(platformCode ? { platformCode } : {}),
      message: `${list} ${names.length === 1 ? "is flagged secret" : "are flagged secret"}, and a secret's value never passes through this server: it is typed by a person on the console environment page, ${consoleUrl}. Nothing was sent. Plain variables (secret false) are set from here.`,
    },
    hint: say,
  });
}

export async function setEnvironment(args: SetEnvironmentArgs): Promise<string> {
  const read = readEnvironmentChange(args);
  if ("problem" in read) return badRequest("EnvironmentInputError", `${read.problem} Nothing was sent.`);

  if ("secret" in read) {
    return secretConsoleOnly(read.secret, environmentPage(resolveCredential({ project: args.project, api: args.api }).ref, args.api));
  }

  const opened = await openProjectApi({ command: COMMAND, project: args.project, api: args.api });
  if (!opened.ok) return projectApiOpenFailure(COMMAND, opened, { api: args.api, name: "Environment", value: { action: SET_ENVIRONMENT } });

  const api = opened.api;
  const consoleUrl = environmentPage(api.ref, args.api);

  const project = `${api.ref.workspace}/${api.ref.project}`;
  const body = {
    envVars: read.set.map((entry) => ({ key: entry.key, value: entry.value, tier: "plaintext", scope: entry.scope, ...(entry.note ? { note: entry.note } : {}) })),
    remove: read.remove,
    reconcile: false,
  };
  const sent = await projectApiSend<Row>(api, "PUT", ROUTE, body);

  if (!sent.ok && sent.code === "CONSOLE_ONLY") {
    const answered = isRow(sent.body) ? sent.body : {};
    const named = (Array.isArray(answered.names) ? answered.names : []).map(text).filter(Boolean);

    return secretConsoleOnly(named.length ? named : [...read.set, ...read.remove].map((entry) => entry.key), consoleUrl, sent.code);
  }

  if (!sent.ok) {
    return refusal(sent, api, args, {
      action: SET_ENVIRONMENT,
      variables: read.set.map((entry) => ({ name: entry.key, scope: entry.scope })),
      remove: read.remove.map((entry) => ({ name: entry.key, scope: entry.scope })),
    });
  }

  const changes = Array.isArray(sent.json.changes)
    ? sent.json.changes.filter((line): line is string => typeof line === "string")
    : [...read.set.map((entry) => `set ${entry.key} (${entry.scope})`), ...read.remove.map((entry) => `remove ${entry.key} (${entry.scope})`)];
  const after = await projectApiGet<Row>(api, ROUTE);
  const variables = after.ok ? environmentRows(after.json) : null;
  const page = trackUrl("environment", { workspace: api.ref.workspace, project: api.ref.project }, args.api);
  const metadataOnly = text(sent.json.mode) === "metadata-only";

  return envelope({
    ok: true,
    command: COMMAND,
    status: "environment-set",
    value: {
      action: SET_ENVIRONMENT,
      project,
      changes,
      variables,
      trackUrl: page,
    },
    hint: `${project}'s environment now reads: ${changes.join("; ")}. These were plain variables under your own token; no approval page was involved. The next build exports them; a secret's value is typed at ${consoleUrl}.`,
    warnings: [
      metadataOnly ? `The platform recorded the names but could not store the values (${text(sent.json.secretsError) || "secrets not writable"}); set them again once it can, or at ${consoleUrl}.` : null,
      variables ? null : `The variable list could not be read back${after.ok ? "" : ` (${after.message})`}.`,
    ],
  });
}
