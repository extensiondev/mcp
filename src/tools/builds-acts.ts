// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { envelope } from "../lib/envelope";
import {
  OWNER_REQUIRED_CODE,
  openProjectApi,
  projectApiOpenFailure,
  projectApiReadFailure,
  tokenRefusal,
  type ProjectApi,
  type ProjectApiRefusal,
} from "../lib/project-api";

export const COMMAND = "extension_builds";
export const BUILD_ENVS = ["staging", "production"] as const;

export type Row = Record<string, unknown>;

export interface ActArgs {
  action?: string;
  buildId?: string;
  buildEnv?: string;
  buildSettings?: unknown;
  approvalId?: string;
  channel?: string;
  description?: string;
  color?: string;
  audience?: string;
  waitSeconds?: unknown;
  project?: string;
  api?: string;
}

export function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : "";
}

export function isRow(value: unknown): value is Row {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function badRequest(action: string, name: string, message: string, extra: Row = {}): string {
  return envelope({
    ok: false,
    command: COMMAND,
    status: "bad-request",
    value: { action, ...extra },
    error: { code: "E_BAD_REQUEST", name, message },
  });
}

const RATE_LIMITED = new Set(["burst_cap", "monthly_cap", "RATE_LIMITED"]);
const UNAVAILABLE = new Set(["counter_unavailable", "entitlement_unavailable", "kill_switch", "unattributed"]);

function refusalHint(code: string, retryAfterSeconds?: number): string | undefined {
  const wait = retryAfterSeconds ? ` The platform asks for ${retryAfterSeconds} seconds before the next try.` : "";

  if (code === "burst_cap") return `The workspace started too many builds in the last hour.${wait} Nothing was dispatched.`;
  if (code === "monthly_cap") return `The workspace's build allowance for this month is spent, so nothing was dispatched.${wait} The plan page in the console raises it.`;
  if (code === "RATE_LIMITED") return `This login made too many of these requests.${wait}`;
  if (code === "BUILD_DISPATCH_DISABLED") return "Build dispatch is paused for every project right now, so nothing was dispatched. Try again later.";
  if (UNAVAILABLE.has(code)) return `The platform could not confirm this build is within the workspace's allowance, so it refused instead of guessing.${wait || " Try again shortly."}`;

  if (code === "BUILD_ENV_SERVED") {
    return "This commit is what a Stable channel serves, and a Preview rebuild would change the environment recorded for the build that channel points at. Rebuild another commit for Preview, or release a new build to that channel first.";
  }

  if (code === "REBUILD_FORCE_NEEDS_A_PERSON") return "Replacing artifacts a live channel serves is a person's decision: ask a person on the project to replace them from the console, where releasing this commit offers Replace and rebuild.";
  if (code === "TESTING_WORKSPACE_READ_ONLY") return "This is a testing workspace, which reads but does not build or change anything.";

  return undefined;
}

export function actRefusal(read: ProjectApiRefusal, action: string, api: ProjectApi, args: ActArgs, value: Row = {}): string {
  const context = { workspace: api.ref.workspace, project: `${api.ref.workspace}/${api.ref.project}` };

  if (read.held || tokenRefusal(read.code, context) || read.code === OWNER_REQUIRED_CODE || read.status === 0) {
    return projectApiReadFailure(COMMAND, read, { api: args.api, name: "Builds", value: { action, ...value }, context });
  }

  const hint = refusalHint(read.code, read.retryAfterSeconds);
  const status =
    read.status === 400
      ? "bad-request"
      : RATE_LIMITED.has(read.code) || read.status === 429
        ? read.code === "BUILD_DISPATCH_DISABLED"
          ? "paused"
          : "rate-limited"
        : read.status === 503 || UNAVAILABLE.has(read.code)
          ? "unavailable"
          : read.status === 404
            ? "not-found"
            : "refused";

  return envelope({
    ok: false,
    command: COMMAND,
    status,
    value: {
      action,
      ...value,
      ...(read.retryAfterSeconds ? { retryAfterSeconds: read.retryAfterSeconds } : {}),
    },
    error: {
      code: status === "bad-request" ? "E_BAD_REQUEST" : read.status === 403 ? "E_AUTH_DENIED" : "E_PLATFORM",
      name: `Builds${status === "bad-request" ? "InputError" : "Refused"}`,
      ...(read.code ? { platformCode: read.code } : {}),
      message: read.message,
    },
    ...(hint ? { hint } : {}),
  });
}

export async function openFor(args: ActArgs, action: string, value: Row = {}): Promise<{ api: ProjectApi } | { refused: string }> {
  const opened = await openProjectApi({ command: COMMAND, project: args.project, api: args.api });

  if (!opened.ok) {
    return { refused: projectApiOpenFailure(COMMAND, opened, { api: args.api, name: "Builds", value: { action, ...value } }) };
  }

  return { api: opened.api };
}
