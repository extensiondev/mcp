// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { spendNarration } from "./allowance";
import { writeCredentialBatch } from "./credentials";
import { pollDeviceGrant, requestDeviceCode } from "./device-flow";
import { envelope, type ErrorCode } from "./envelope";
import { fetchLoginConfig, resolveApiBase, safeApiBase } from "./login-flow";
import { platformHoldEnvelope, sawPlatformHold } from "./platform-hold";
import {
  PLATFORM_CREATES_PER_HOUR,
  createRateLimitNote,
  parseProjectBatch,
  sameProjectSet,
} from "./project-batch";
import { buildCreateBody } from "./project-create-body";
import { consoleBase, consoleProjectUrl } from "./registry";
import { identityHeaders } from "./session-identity";

const COMMAND = "extension_project_create";

const FIRST_CALL_BUDGET_MS = 8_000;
const RESUME_BUDGET_MS = 22_000;
const SLICE_BUDGET_MS = 20_000;
const GRANT_EXPIRY_MARGIN_SECONDS = 5;

const ENTRY_KEYS = [
  "project",
  "repo",
  "displayName",
  "description",
  "installCommand",
  "buildCommand",
  "outputDirectory",
  "browsers",
  "outputDirectories",
] as const;

const ENTRY_STRING_KEYS = [
  "displayName",
  "description",
  "installCommand",
  "buildCommand",
  "outputDirectory",
] as const;

const BROWSERS = ["chrome", "edge", "firefox"];

const SINGLE_ONLY_KEYS = ["project", "repo", "displayName", "description"];

export interface BatchCreateArgs {
  projects?: unknown;
  project?: unknown;
  repo?: unknown;
  installationId?: string;
  displayName?: unknown;
  description?: unknown;
  installCommand?: string;
  buildCommand?: string;
  outputDirectory?: string;
  browsers?: string[];
  outputDirectories?: Record<string, unknown>;
  deviceCode?: string;
  api?: string;
}

interface BatchEntry {
  ref: string;
  workspace: string;
  slug: string;
  repo: string;
  owner: string;
  repoName: string;
  displayName?: string;
  description?: string;
  installCommand?: string;
  buildCommand?: string;
  outputDirectory?: string;
  browsers?: string[];
  outputDirectories?: Record<string, unknown>;
}

type Row =
  | {
      project: string;
      status: "created";
      loggedIn: boolean;
      projectId: unknown;
      consoleUrl: string;
      expiresAt?: string | null;
      tokenCode?: string;
      hint?: string;
    }
  | {
      project: string;
      status: "refused";
      httpStatus: number;
      code: string;
      message: string;
      connectUrl?: string;
      retryAfterSeconds?: number;
      hint?: string;
    }
  | { project: string; status: "unconfirmed"; message: string; hint: string }
  | { project: string; status: "not-attempted"; code: string; message: string }
  | { project: string; status: "pending" };

interface Stop {
  code: string;
  message: string;
  body?: Record<string, unknown>;
  held?: boolean;
}

interface Session {
  apiBase: string;
  workspace: string;
  refs: string[];
  entries: BatchEntry[];
  grant: string;
  grantExpiresAt: number;
  rows: Map<string, Row>;
  busy: boolean;
  stop: Stop | null;
  lastBody: Record<string, unknown> | null;
  unanswered: number;
}

/* @invariant THE GRANT LIVES IN THIS PROCESS'S MEMORY AND NOWHERE ELSE.
 * One approval of a list mints one provisioning grant, and creating a project
 * takes long enough that a list cannot be finished inside one tool call, so
 * the grant has to outlive the call that redeemed it. It is kept here, keyed
 * by the device code the agent already holds, for the fifteen minutes it
 * lives. It is never written to disk and never returned in an envelope: a
 * grant on disk would sit beside real project logins as a credential every
 * other door refuses, and a grant in an envelope would be in a model's
 * context. The cost is stated in the envelope rather than hidden: if this
 * server process exits before the list is done, the grant is gone, the
 * projects already created stay created, and the rest need a new approval.
 */
const sessions = new Map<string, Session>();

export function resetBatchCreateSessions(): void {
  sessions.clear();
}

/* @invariant A session outlives its grant by an hour, on purpose. The rows
 * it holds are the only record on this machine of which projects one approval
 * created, and an agent that comes back after the grant ran out must still be
 * told that, project by project, rather than be handed a bare "expired". The
 * grant inside is dead by then and is dropped the moment that is noticed. */
const SESSION_KEEP_SECONDS = 3600;

function sweepSessions(nowSeconds: number): void {
  for (const [key, session] of sessions) {
    if (session.busy) continue;
    if (session.grantExpiresAt <= nowSeconds) session.grant = "";
    if (session.grantExpiresAt + SESSION_KEEP_SECONDS <= nowSeconds) {
      sessions.delete(key);
    }
  }
}

function fail(
  name: string,
  message: string,
  status: string,
  code: ErrorCode,
  extra?: { hint?: string; value?: Record<string, unknown> },
): string {
  return envelope({
    ok: false,
    command: COMMAND,
    status,
    error: { code, name, message },
    ...(extra?.value ? { value: extra.value } : {}),
    ...(extra?.hint ? { hint: extra.hint } : {}),
  });
}

function laneClosedHint(): string {
  return `Create the projects in the console at ${consoleBase()} (workspace page, New project), then run extension_auth (action: login) against them. While the public hold is on, headless creation is open only to workspaces on the platform's allowlist (WWW_MCP_ACTION_ALLOWED_WORKSPACES), the same list that already lets publish, submit and promote run headlessly; this workspace is not on it, so the console is the route.`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/* @invariant EVERY ENTRY IS CHECKED BEFORE A DEVICE CODE IS SPENT, AND AN
 * ENTRY THIS TOOL DOES NOT UNDERSTAND IS REFUSED, NOT SKIPPED. A list with
 * one bad entry would otherwise reach the approval page looking complete,
 * get approved, and then fail one project at a time against a grant that is
 * already running out. The list rules are the platform's own. The cap on a
 * create list is lower than the platform's cap on a list because the platform
 * creates at most ten projects an hour for one approving account: a longer
 * list would be approved whole and could never finish, so it is refused here
 * with that reason instead of being split quietly into approvals nobody asked
 * for.
 */
export function parseBatchCreateArgs(
  args: BatchCreateArgs,
):
  | { ok: true; workspace: string; entries: BatchEntry[] }
  | { ok: false; message: string; hint?: string } {
  for (const key of SINGLE_ONLY_KEYS) {
    const value = (args as Record<string, unknown>)[key];
    if (value !== undefined && value !== null && String(value).trim() !== "") {
      return {
        ok: false,
        message: `With projects, ${key} belongs inside each entry, not beside the list. Pass either the single form (project, repo) or projects, not both.`,
      };
    }
  }
  if (!Array.isArray(args.projects)) {
    return {
      ok: false,
      message:
        "projects must be an array of entries shaped { project: '<workspace>/<project>', repo: '<owner>/<repo>' }.",
    };
  }
  const refs: unknown[] = [];
  for (const entry of args.projects) {
    if (!isRecord(entry)) {
      return {
        ok: false,
        message: `Every entry in projects must be an object shaped { project, repo }; got ${JSON.stringify(entry)}. Each new project needs its own source repository, so a bare name is not enough.`,
      };
    }
    const unknown = Object.keys(entry).filter(
      (key) => !(ENTRY_KEYS as readonly string[]).includes(key),
    );
    if (unknown.length) {
      return {
        ok: false,
        message: `Unknown key ${unknown.map((key) => `'${key}'`).join(", ")} in a projects entry. An entry takes: ${ENTRY_KEYS.join(", ")}.`,
      };
    }
    refs.push(entry.project);
  }
  const parsed = parseProjectBatch(refs);
  if (!parsed.ok) return parsed;
  if (parsed.batch.refs.length > PLATFORM_CREATES_PER_HOUR) {
    return {
      ok: false,
      message: `projects names ${parsed.batch.refs.length} projects to create, and one approval can create at most ${PLATFORM_CREATES_PER_HOUR}.`,
      hint: `${createRateLimitNote()} Split the list into calls of ${PLATFORM_CREATES_PER_HOUR} or fewer and run them an hour apart; each call is its own approval. Nothing was started and no device code was spent.`,
    };
  }
  const entries: BatchEntry[] = [];
  for (const [index, raw] of (args.projects as Record<string, unknown>[]).entries()) {
    const ref = parsed.batch.refs[index] as string;
    const slug = parsed.batch.slugs[index] as string;
    const repo = typeof raw.repo === "string" ? raw.repo.trim() : "";
    if (!/^[^/]+\/[^/]+$/.test(repo)) {
      return {
        ok: false,
        message: `The entry for '${ref}' needs repo as '<owner>/<repo>', the GitHub repository that project's source is pushed to.`,
      };
    }
    for (const key of ENTRY_STRING_KEYS) {
      if (raw[key] !== undefined && typeof raw[key] !== "string") {
        return {
          ok: false,
          message: `In the entry for '${ref}', ${key} must be a string.`,
        };
      }
    }
    if (raw.browsers !== undefined) {
      const list = raw.browsers;
      if (
        !Array.isArray(list) ||
        list.length === 0 ||
        list.some((name) => !BROWSERS.includes(String(name)))
      ) {
        return {
          ok: false,
          message: `In the entry for '${ref}', browsers must be a non-empty array of: ${BROWSERS.join(", ")}.`,
        };
      }
    }
    if (raw.outputDirectories !== undefined && !isRecord(raw.outputDirectories)) {
      return {
        ok: false,
        message: `In the entry for '${ref}', outputDirectories must be an object such as {"edge": "build/edge"}.`,
      };
    }
    const [owner = "", repoName = ""] = repo.split("/");
    entries.push({
      ref,
      workspace: parsed.batch.workspace,
      slug,
      repo,
      owner,
      repoName,
      displayName: raw.displayName as string | undefined,
      description: raw.description as string | undefined,
      installCommand: (raw.installCommand as string | undefined) ?? args.installCommand,
      buildCommand: (raw.buildCommand as string | undefined) ?? args.buildCommand,
      outputDirectory:
        (raw.outputDirectory as string | undefined) ?? args.outputDirectory,
      browsers: (raw.browsers as string[] | undefined) ?? args.browsers,
      outputDirectories:
        (raw.outputDirectories as Record<string, unknown> | undefined) ??
        args.outputDirectories,
    });
  }
  return { ok: true, workspace: parsed.batch.workspace, entries };
}

function pendingEnvelope(args: {
  deviceCode: string;
  refs: string[];
  verificationUri: string;
  userCode?: string;
  verificationUriComplete?: string;
}): string {
  const complete = String(args.verificationUriComplete || "").trim();
  const hasCompleteLink =
    complete.length > 0 && complete !== args.verificationUri;
  const again =
    "then call extension_project_create again with this deviceCode and the same arguments";
  const page = `The page lists all ${args.refs.length} projects this one approval creates and says this device is also signed in to each for 7 days`;
  const hint = !args.userCode
    ? `Still waiting for approval at ${args.verificationUri}. Approve there, ${again}.`
    : hasCompleteLink
      ? `Open ${complete} and approve creating the projects (code ${args.userCode} is pre-filled). ${page}; ${again}. If the page asks for a code, enter ${args.userCode} at ${args.verificationUri}.`
      : `Open ${args.verificationUri}, enter code ${args.userCode} and approve creating the projects. ${page}; ${again}.`;
  return envelope({
    ok: true,
    command: COMMAND,
    status: "authorization-pending",
    value: {
      ...(args.userCode ? { userCode: args.userCode } : {}),
      verificationUri: args.verificationUri,
      ...(args.userCode && hasCompleteLink
        ? { verificationUriComplete: complete }
        : {}),
      deviceCode: args.deviceCode,
      projects: args.refs,
    },
    hint,
  });
}

/* @invariant A STOP IS A REFUSAL THAT SAYS THIS GRANT CAN DO NO MORE RIGHT
 * NOW, AND IT IS READ OFF THE PLATFORM'S CODE. An expired or invalid grant,
 * an approver who left the workspace, a closed lane, the public hold, the
 * hourly creation limit, the plan's project limit and a missing GitHub App
 * installation are all facts about the approval or the account, not about the
 * one project that happened to hit them, so asking again for the next project
 * would only collect the same refusal and spend the limiter. Everything else,
 * a name taken, a reserved slug, a build that rolled back, is about that
 * project alone and the list goes on. A stop never hides the rest: every
 * project not reached gets its own row saying it was not attempted and why.
 */
const STOP_CODES = new Set([
  "TOKEN_EXPIRED",
  "BAD_TOKEN",
  "AUTH_REQUIRED",
  "NOT_A_PROVISIONING_GRANT",
  "MEMBERSHIP_REVOKED",
  "WORKSPACE_NOT_FOUND",
  "CLI_PROJECT_CREATE_DISABLED",
  "PLATFORM_NOT_OPEN",
  "RATE_LIMITED",
  "PROJECT_LIMIT_EXCEEDED",
  "INSTALLATION_ABSENT",
  "INSTALLATION_ORG_UNSUPPORTED",
  "INSTALLATION_AMBIGUOUS",
]);

function refusalHint(code: string, ref: string, retryAfterSeconds?: number): string | undefined {
  if (code === "PROJECT_EXISTS") {
    return `${ref} already exists, so there was nothing to create and no token came back. Sign in to it with extension_auth (action: login).`;
  }
  if (code === "RATE_LIMITED") {
    return `${createRateLimitNote()}${
      retryAfterSeconds ? ` The platform says to wait ${retryAfterSeconds} seconds.` : ""
    } The grant will have expired by then, so the projects not created need a new extension_project_create call, and its approval, after the wait.`;
  }
  if (code === "TOKEN_EXPIRED") {
    return "The provisioning grant lives 15 minutes and ran out. Start a new extension_project_create call for the projects not created.";
  }
  if (code === "PROJECT_LIMIT_EXCEEDED") {
    return "The workspace is at its plan's project limit. Nothing more can be created in it until a project is removed or the plan changes.";
  }
  if (code === "RESERVED_PROJECT_SLUG") {
    return "That slug is reserved on extension.dev. Pick another name for this project.";
  }
  return undefined;
}

async function createOne(session: Session, entry: BatchEntry, installationId: string | undefined): Promise<{ row: Row; stop?: Stop; halt?: boolean }> {
  const url = `${session.apiBase}/api/cli/projects/create`;
  const body = {
    ...buildCreateBody({
      workspace: entry.workspace,
      projectSlug: entry.slug,
      owner: entry.owner,
      repoName: entry.repoName,
      installationId,
      displayName: entry.displayName,
      description: entry.description,
      installCommand: entry.installCommand,
      buildCommand: entry.buildCommand,
      outputDirectory: entry.outputDirectory,
      browsers: entry.browsers,
      outputDirectories: entry.outputDirectories,
    }),
    project: entry.ref,
  };
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${session.grant}`,
        "content-type": "application/json",
        ...identityHeaders(COMMAND),
      },
      body: JSON.stringify(body),
    });
  } catch (err: any) {
    /* @invariant A request that got no answer is "unconfirmed", never
     * "refused" and never retried. The platform may have created the project
     * before the connection died, and a second create racing the first is two
     * builds claiming one name. So the row says what is known, the slice ends,
     * and a second request in a row with no answer stops the list: the names
     * after it were never sent, and saying so is truer than marking each of
     * them unconfirmed one call at a time. */
    session.unanswered += 1;
    const message = `Could not reach ${url}: ${err?.message || err}`;
    return {
      row: {
        project: entry.ref,
        status: "unconfirmed",
        message,
        hint: `The request for ${entry.ref} left this machine and no answer came back, so the project may or may not exist. It is not retried, because a second create racing the first would be two builds claiming one name. Check the console at ${consoleBase()}; if it exists, sign in with extension_auth (action: login).`,
      },
      halt: true,
      ...(session.unanswered >= 2
        ? { stop: { code: "PLATFORM_UNREACHABLE", message } }
        : {}),
    };
  }
  session.unanswered = 0;
  const text = await res.text();
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(text);
  } catch {
    data = { message: text };
  }

  if (!res.ok) {
    const held = sawPlatformHold(res, data);
    const code = held
      ? "PLATFORM_NOT_OPEN"
      : String(data.code || "").trim() || `HTTP_${res.status}`;
    const message = String(
      data.message || (data as { error?: unknown }).error || text || "unknown error",
    ).slice(0, 500);
    const connectUrl = String(data.connectUrl || "").trim();
    /* @invariant The wait is read from the body or from the Retry-After
     * header, whichever the platform sent. Its two creation limiters answer
     * the same code with different bodies, and the one that counts creations
     * per approving account states the wait only in the header. */
    const retryAfterSeconds =
      Number(data.retryAfterSeconds || res.headers.get("retry-after") || 0) ||
      undefined;
    const hint = refusalHint(code, entry.ref, retryAfterSeconds);
    const row: Row = {
      project: entry.ref,
      status: "refused",
      httpStatus: res.status,
      code,
      message,
      ...(connectUrl ? { connectUrl } : {}),
      ...(retryAfterSeconds ? { retryAfterSeconds } : {}),
      ...(hint ? { hint } : {}),
    };
    return STOP_CODES.has(code)
      ? { row, stop: { code, message, body: data, held } }
      : { row };
  }

  session.lastBody = data;
  const finalWorkspace = String(data.workspaceSlug || entry.workspace).trim();
  const finalProject = String(data.projectSlug || entry.slug).trim();
  const consoleUrl = consoleProjectUrl(
    { workspace: finalWorkspace, project: finalProject },
    "",
  );
  const token = String(data.token || "").trim();
  const scoped =
    finalWorkspace.toLowerCase() === entry.workspace &&
    finalProject.toLowerCase() === entry.slug;
  /* @invariant A token is stored only under the name this call asked for. The
   * platform says which project it made, and a token is filed under that
   * answer; if the answer is not the listed project, filing it would put a
   * login on this machine for a project nobody named here. */
  if (data.tokenIssued === true && token && scoped) {
    const expiresAt = Number(data.expiresAt || 0);
    writeCredentialBatch([
      {
        version: 1,
        token,
        workspaceSlug: finalWorkspace,
        projectSlug: finalProject,
        expiresAt,
        api: session.apiBase,
        provider: "extensiondev",
      },
    ]);
    return {
      row: {
        project: entry.ref,
        status: "created",
        loggedIn: true,
        projectId: data.projectId ?? null,
        consoleUrl,
        expiresAt: expiresAt ? new Date(expiresAt * 1000).toISOString() : null,
      },
    };
  }
  const tokenCode = !scoped
    ? "PROJECT_NAME_MISMATCH"
    : String(data.tokenCode || "").trim() || "NO_TOKEN_IN_RESPONSE";
  return {
    row: {
      project: entry.ref,
      status: "created",
      loggedIn: false,
      projectId: data.projectId ?? null,
      consoleUrl,
      tokenCode,
      hint: scoped
        ? `${entry.ref} was created but the platform issued no token for it. Sign in with extension_auth (action: login).`
        : `The platform registered this project as ${finalWorkspace}/${finalProject}, not the ${entry.ref} that was asked for, so no login was stored. Sign in to the name it has with extension_auth (action: login).`,
    },
  };
}

function rowsInOrder(session: Session): Row[] {
  return session.entries.map(
    (entry) => session.rows.get(entry.ref) ?? { project: entry.ref, status: "pending" },
  );
}

function quoteList(refs: string[]): string {
  return `[${refs.map((ref) => `'${ref}'`).join(", ")}]`;
}

function finalEnvelope(session: Session): string {
  const stop = session.stop;
  for (const entry of session.entries) {
    if (session.rows.has(entry.ref)) continue;
    session.rows.set(entry.ref, {
      project: entry.ref,
      status: "not-attempted",
      code: stop?.code ?? "NOT_ATTEMPTED",
      message: stop
        ? `Not attempted: an earlier project in this list was refused with ${stop.code}, which applies to the whole approval.`
        : "Not attempted.",
    });
  }
  const rows = rowsInOrder(session);
  const created = rows.filter((row) => row.status === "created");
  const loggedIn = created.filter((row) => row.status === "created" && row.loggedIn);
  const needLogin = [
    ...created.filter((row) => row.status === "created" && !row.loggedIn),
    ...rows.filter((row) => row.status === "refused" && row.code === "PROJECT_EXISTS"),
  ].map((row) => row.project);
  const retry = rows
    .filter(
      (row) =>
        row.status === "not-attempted" ||
        (row.status === "refused" && row.code !== "PROJECT_EXISTS"),
    )
    .map((row) => row.project);
  const unconfirmed = rows
    .filter((row) => row.status === "unconfirmed")
    .map((row) => row.project);

  if (created.length === 0 && stop?.held) {
    return platformHoldEnvelope({
      command: COMMAND,
      name: "CreateHeld",
      body: stop.body,
      value: { workspace: session.workspace, projects: session.refs, results: rows },
    });
  }
  if (created.length === 0 && stop?.code === "CLI_PROJECT_CREATE_DISABLED") {
    return fail("CreateClosed", stop.message, "lane-closed", "E_PLATFORM", {
      hint: laneClosedHint(),
      value: { workspaceSlug: session.workspace, results: rows },
    });
  }

  const nextSteps = [
    ...(needLogin.length
      ? [`extension_auth (action: login, projects: ${quoteList(needLogin)})`]
      : []),
    ...(retry.length
      ? [
          `extension_project_create with projects limited to ${quoteList(retry)}, once what refused them is fixed (a new approval; a create list may only name projects that do not exist yet)`,
        ]
      : []),
    ...(unconfirmed.length
      ? [`check ${quoteList(unconfirmed)} in the console at ${consoleBase()} before creating them again`]
      : []),
    ...(loggedIn.length ? ["extension_publish (project: one of the logged-in projects)"] : []),
  ];
  const value = {
    workspaceSlug: session.workspace,
    results: rows,
    counts: {
      listed: rows.length,
      created: created.length,
      loggedIn: loggedIn.length,
      refused: rows.filter((row) => row.status === "refused").length,
      unconfirmed: unconfirmed.length,
      notAttempted: rows.filter((row) => row.status === "not-attempted").length,
    },
    ...(created.length
      ? {
          allowance: spendNarration({
            what: `Creating ${created.length} project${created.length === 1 ? "" : "s"}, including each first build,`,
            body: session.lastBody ?? undefined,
            api: session.apiBase,
          }),
        }
      : {}),
    nextSteps,
  };
  const spent =
    "The provisioning grant is spent or discarded and was never written to this machine.";
  if (created.length === rows.length) {
    return envelope({
      ok: true,
      command: COMMAND,
      status: "created",
      value,
      hint:
        needLogin.length === 0
          ? `All ${rows.length} projects exist, each first build was dispatched, and this machine is signed in to every one of them for 7 days. ${spent} Token-scoped tools take \`project\` to pick one.`
          : `All ${rows.length} projects exist and each first build was dispatched, but no token was stored for ${needLogin.join(", ")}. ${spent} Sign in to those with one batch login: ${nextSteps[0]}.`,
      ...(needLogin.length
        ? {
            warnings: [
              `Created without a stored login: ${needLogin.join(", ")}. Run ${nextSteps[0]}.`,
            ],
          }
        : {}),
    });
  }
  return envelope({
    ok: false,
    command: COMMAND,
    status: "batch-incomplete",
    error: {
      code: "E_PLATFORM",
      name: "BatchIncomplete",
      message: `${created.length} of ${rows.length} projects were created. Each project has its own row in results with the platform's code; nothing is retried automatically.${
        stop ? ` The list stopped at ${stop.code}: ${stop.message}` : ""
      }`,
    },
    value,
    hint: `${spent} ${
      stop?.code === "RATE_LIMITED" ? `${createRateLimitNote()} ` : ""
    }Next: ${nextSteps.join("; then ") || "read results"}.`,
  });
}

async function runSlice(session: Session, deviceCode: string, installationId: string | undefined): Promise<string> {
  if (session.busy) {
    return envelope({
      ok: true,
      command: COMMAND,
      status: "creating",
      value: {
        workspaceSlug: session.workspace,
        deviceCode,
        results: rowsInOrder(session),
      },
      hint: "Another call with this deviceCode is creating projects right now. Wait for it to answer, then call again with the same deviceCode and arguments if projects are still pending.",
    });
  }
  session.busy = true;
  let halted = false;
  try {
    const started = Date.now();
    let attempted = 0;
    for (const entry of session.entries) {
      if (session.rows.has(entry.ref)) continue;
      if (session.stop) break;
      if (Math.floor(Date.now() / 1000) >= session.grantExpiresAt - GRANT_EXPIRY_MARGIN_SECONDS) {
        session.stop = {
          code: "TOKEN_EXPIRED",
          message: "The provisioning grant expired; it lives fifteen minutes.",
        };
        break;
      }
      if (attempted > 0 && Date.now() - started >= SLICE_BUDGET_MS) break;
      attempted += 1;
      const outcome = await createOne(session, entry, installationId);
      session.rows.set(entry.ref, outcome.row);
      if (outcome.stop) session.stop = outcome.stop;
      if (outcome.halt) {
        halted = true;
        break;
      }
    }
  } finally {
    session.busy = false;
  }
  const remaining = session.entries.filter((entry) => !session.rows.has(entry.ref));
  if (remaining.length > 0 && !session.stop) {
    const done = session.entries.length - remaining.length;
    return envelope({
      ok: true,
      command: COMMAND,
      status: "creating",
      value: {
        workspaceSlug: session.workspace,
        deviceCode,
        results: rowsInOrder(session),
        remaining: remaining.map((entry) => entry.ref),
      },
      hint: `${done} of ${session.entries.length} projects handled so far; ${remaining.length} still to create. Call extension_project_create again with this same deviceCode and the same arguments to continue. No new approval is needed: the grant is held in this server's memory until ${new Date(session.grantExpiresAt * 1000).toISOString()} and is lost if the server restarts.${
        halted ? " The last request got no answer, so its project is marked unconfirmed and is not retried." : ""
      }`,
    });
  }
  sessions.delete(deviceCode);
  return finalEnvelope(session);
}

export async function createProjectBatch(args: BatchCreateArgs): Promise<string> {
  const parsed = parseBatchCreateArgs(args);
  if (!parsed.ok) {
    return fail("BadRequest", parsed.message, "bad-request", "E_BAD_REQUEST", {
      hint: parsed.hint,
    });
  }
  const installationId = String(args.installationId || "").trim();
  if (installationId && !/^\d+$/.test(installationId)) {
    return fail(
      "BadRequest",
      "installationId is optional, and when given it must be the numeric extension.dev GitHub App installation id. Omit it and the platform resolves it from the approving account.",
      "bad-request",
      "E_BAD_REQUEST",
    );
  }
  const refs = parsed.entries.map((entry) => entry.ref);

  const apiCheck = safeApiBase(resolveApiBase(args.api), args.api);
  if (!apiCheck.ok) {
    return fail("ConfigError", apiCheck.message, "bad-request", "E_BAD_REQUEST");
  }
  const apiBase = apiCheck.base;

  sweepSessions(Math.floor(Date.now() / 1000));
  let deviceCode = String(args.deviceCode || "").trim();
  const held = deviceCode ? sessions.get(deviceCode) : undefined;
  if (held) {
    if (held.apiBase !== apiBase || !sameProjectSet(held.refs, refs)) {
      return fail(
        "BadRequest",
        `This deviceCode belongs to an approval for ${quoteList(held.refs)}. Call again with that same list, or start a new call without deviceCode for a different one.`,
        "bad-request",
        "E_BAD_REQUEST",
      );
    }
    return runSlice(held, deviceCode, installationId || undefined);
  }

  let config;
  try {
    config = await fetchLoginConfig(apiBase);
  } catch (err: any) {
    return fail(
      "ConfigError",
      err?.message || "Could not load login config.",
      "create-failed",
      "E_PLATFORM",
    );
  }

  let interval = 5;
  let budgetMs = RESUME_BUDGET_MS;
  let start: Awaited<ReturnType<typeof requestDeviceCode>> | null = null;
  if (!deviceCode) {
    try {
      start = await requestDeviceCode({
        apiBase,
        path: config.deviceCodeUrl,
        projects: refs,
        intent: "create",
      });
    } catch (err: any) {
      const serverCode = String(err?.serverCode || "");
      const serverMessage =
        typeof err?.serverMessage === "string" ? err.serverMessage.trim() : "";
      if (serverCode === "CLI_PROJECT_CREATE_DISABLED") {
        return fail(
          "CreateStartError",
          serverMessage || "Headless project creation is not open on this host yet.",
          "lane-closed",
          "E_PLATFORM",
          { hint: laneClosedHint() },
        );
      }
      return fail(
        "CreateStartError",
        String(err?.message || "Could not start the device flow."),
        "create-failed",
        "E_PLATFORM",
        {
          hint: "No device code was issued and nothing was created. If this platform predates batch approval it refuses the list form; create the projects one extension_project_create call each (project, repo).",
        },
      );
    }
    deviceCode = start.deviceCode;
    interval = start.interval;
    budgetMs = FIRST_CALL_BUDGET_MS;
  }

  const poll = await pollDeviceGrant({
    apiBase,
    path: config.deviceTokenUrl,
    projects: refs,
    deviceCode,
    interval,
    budgetMs,
  });
  if (!poll.ok) {
    if (poll.reason === "pending") {
      return pendingEnvelope({
        deviceCode,
        refs,
        verificationUri: start?.verificationUri ?? config.verificationUri,
        userCode: start?.userCode,
        verificationUriComplete: start?.verificationUriComplete,
      });
    }
    const code = String(poll.code || "");
    if (code === "CLI_PROJECT_CREATE_DISABLED") {
      return fail(
        "CreateClosed",
        poll.message || "Headless project creation is not open yet.",
        "lane-closed",
        "E_PLATFORM",
        { hint: laneClosedHint() },
      );
    }
    if (poll.reason === "denied") {
      return fail(
        "CreateDenied",
        "Creating the projects was denied at extension.dev/device.",
        "create-denied",
        "E_AUTH_DENIED",
      );
    }
    if (poll.reason === "expired") {
      return fail(
        "CreateExpired",
        "The device code expired or was already redeemed. If an earlier call with this deviceCode had started creating projects and this server restarted since, the grant it held is gone: the projects it created still exist.",
        "create-expired",
        "E_AUTH_EXPIRED",
        {
          hint: `Check which of ${quoteList(refs)} exist in the console at ${consoleBase()}. Sign in to those with extension_auth (action: login, projects), and start a new extension_project_create call naming only the ones that do not exist yet.`,
        },
      );
    }
    return fail(
      "CreateAuthError",
      poll.message || "Device authorization failed.",
      "create-failed",
      "E_AUTH_FAILED",
      { value: { ...(code ? { code } : {}), projects: refs } },
    );
  }

  const grant = poll.data;
  const token = String(grant.token || "").trim();
  const grantWorkspace = String(grant.workspaceSlug || "").trim().toLowerCase();
  const grantSlugs = Array.isArray(grant.projectSlugs)
    ? (grant.projectSlugs as unknown[]).map((slug) => String(slug).toLowerCase())
    : null;
  /* @invariant The grant is used only when it is the one that was asked for:
   * a provisioning grant, for this workspace, for exactly this list. A grant
   * for a different or longer list is discarded unused, because creating
   * "the listed projects" under it would be acting on an approval this call
   * cannot describe. */
  if (
    String(grant.tokenKind || "") !== "provisioning" ||
    !grantSlugs ||
    grantWorkspace !== parsed.workspace ||
    !sameProjectSet(
      grantSlugs,
      parsed.entries.map((entry) => entry.slug),
    )
  ) {
    return fail(
      "CreateScopeError",
      `The approval did not come back as a provisioning grant for exactly ${quoteList(refs)}, so it was discarded and nothing was created. Run extension_project_create again.`,
      "create-failed",
      "E_AUTH_FAILED",
      {
        hint: "If one of these projects already exists, a create list is refused: sign in to existing projects with extension_auth (action: login, projects) and list only new ones here.",
      },
    );
  }

  const session: Session = {
    apiBase,
    workspace: parsed.workspace,
    refs,
    entries: parsed.entries,
    grant: token,
    grantExpiresAt:
      Number(grant.expiresAt || 0) || Math.floor(Date.now() / 1000) + 900,
    rows: new Map(),
    busy: false,
    stop: null,
    lastBody: null,
    unanswered: 0,
  };
  sessions.set(deviceCode, session);
  return runSlice(session, deviceCode, installationId || undefined);
}
