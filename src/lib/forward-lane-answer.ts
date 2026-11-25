// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { readCarriedMemory, type CarriedMemory } from "./call-memory";
import { envelope } from "./envelope";

type Args = Record<string, unknown>;

export const LANE_FUNCTION_SECONDS = 60;
export const FORWARD_TIMEOUT_MS = 70_000;
export const ACT_SETTLE_WINDOW_MS = 65_000;
export const IN_FLIGHT_RECHECK_MS = 5_000;
export const MEMORY_KEY = "memory";
export const HOSTED_WAIT_KEY = "hostedWait";
export const LOCAL_TOOLS_STILL_WORK = "The local tools keep working without the hosted lane.";

const LOST_STATUSES = new Set([502, 504]);

export type LaneRead =
  | { kind: "answer"; body: Args }
  | { kind: "lost"; httpStatus: number; reason: string }
  | { kind: "unreadable"; httpStatus: number; said: string; retryAfterSeconds: number | null };

export interface HostedWait {
  askedSeconds: number;
  grantedSeconds: number;
  notice: string;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function isRow(value: unknown): value is Args {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function firstLine(raw: string): string {
  return (
    raw
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .pop() ?? ""
  ).slice(0, 120);
}

/* @invariant A LANE ANSWER IS READ BY ITS HTTP STATUS BEFORE ITS BODY. The
 * lane answers every tool outcome and every refusal of its own as a JSON
 * envelope, so a body that is not one came from the edge in front of it: a
 * 504 or 502 means the function ran out of time or died, and what it had
 * already asked the platform to do may have happened; a 413 means the body
 * never reached the function; a 503 means the lane is off or not deployed.
 * Each is told apart here, and none is flattened into "could not read".
 */
export async function readLane(res: Response): Promise<LaneRead> {
  const raw = await res.text().catch(() => "");
  let body: unknown = null;

  try {
    body = JSON.parse(raw);
  } catch {
    body = null;
  }

  const readable = isRow(body) && typeof body.ok === "boolean" && typeof body.status === "string";
  const said = readable ? text(((body as Args).error as Args | undefined)?.message) : firstLine(raw);

  if (LOST_STATUSES.has(res.status)) return { kind: "lost", httpStatus: res.status, reason: said };

  if (res.status === 413 || res.status === 503 || !readable) {
    const retryAfter = Number(res.headers.get("retry-after"));

    return { kind: "unreadable", httpStatus: res.status, said, retryAfterSeconds: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null };
  }

  return { kind: "answer", body: body as Args };
}

export function recordToRead(command: string, args: Args): string {
  const project = text(args.project);
  const named = project ? `, project: '${project}'` : "";

  if (command === "extension_submit" || command === "extension_submit_check" || command === "extension_approvals_request" || command === "extension_publish") return `extension_submit_read (action: 'status'${named})`;
  if (command === "extension_builds") return `extension_builds_read (action: 'list'${named})`;
  if (command === "extension_shares") return `extension_shares_read (action: 'list'${named})`;
  if (command === "extension_approvals") return `extension_approvals_read (action: 'status'${named})`;
  if (command === "extension_workspace" || command === "extension_workspace_create" || command === "extension_project_create") return "extension_workspace_read (action: 'projects')";

  return `extension_release_status${project ? ` (project: '${project}')` : ""}`;
}

function refusal(command: string, status: string, code: "E_PLATFORM" | "E_NETWORK" | "E_BAD_REQUEST", message: string, hint: string, value: Args): string {
  return envelope({ ok: false, command, status, error: { code, message }, hint, value: { hosted: true, ...value } });
}

export function lostAnswer(args: { command: string; sent: Args; key: string; reads: boolean; resource: string; httpStatus: number; reason: string }): string {
  const { command, key, resource, httpStatus, reason } = args;
  const how = httpStatus ? `answered ${httpStatus}${reason ? ` (${reason})` : ""}` : `did not answer${reason ? ` (${reason})` : ""}`;

  if (args.reads) {
    if (!httpStatus) {
      return refusal(command, "offline", "E_NETWORK", `Platform tools need the network to reach ${new URL(resource).host}; it ${how} twice.`, `Nothing was changed: this call only reads. Try again shortly. ${LOCAL_TOOLS_STILL_WORK}`, { lane: resource });
    }

    return refusal(command, "platform-unavailable", "E_PLATFORM", `The hosted lane at ${resource} ${how} twice for this read.`, `Nothing was changed: this call only reads. Try again shortly. ${LOCAL_TOOLS_STILL_WORK}`, { lane: resource, httpStatus });
  }

  const read = recordToRead(command, args.sent);

  return refusal(
    command,
    "act-unconfirmed",
    "E_PLATFORM",
    `The hosted lane at ${resource} ${how} before ${command} reported an outcome, so the act may have run.`,
    `Read its record first with ${read}, and send the act again only if the record shows it did not run. The call carried idempotency key ${key}, which the lane holds until the act reports back.`,
    { lane: resource, ...(httpStatus ? { httpStatus } : {}), idempotencyKey: key, mayHaveRun: true, readFirst: read },
  );
}

export function unreadableAnswer(args: { command: string; resource: string; read: Extract<LaneRead, { kind: "unreadable" }>; sentBytes: number; factsBytes: number }): string {
  const { command, resource, read, sentBytes, factsBytes } = args;

  if (read.httpStatus === 413) {
    const kb = Math.ceil(sentBytes / 1024);
    const facts = factsBytes ? ` ${Math.ceil(factsBytes / 1024)} KB of it is what this server read from the project folder (STORE.md, icons, screenshots, the share record).` : "";

    return refusal(
      command,
      "payload-too-large",
      "E_BAD_REQUEST",
      `The hosted lane refused this call's body as too large (413): ${kb} KB was sent.${facts}`,
      `Nothing ran. ${factsBytes ? "Send fewer or smaller listing images, or name one browser per call. " : "Send smaller arguments. "}${LOCAL_TOOLS_STILL_WORK}`,
      { lane: resource, httpStatus: 413, sentBytes, ...(factsBytes ? { localFactsBytes: factsBytes } : {}) },
    );
  }

  if (read.httpStatus === 503) {
    return refusal(
      command,
      "hosted-off",
      "E_PLATFORM",
      `The hosted lane at ${resource} answered 503${read.said ? `: ${read.said}` : ", so it is switched off or not deployed"}`,
      `Nothing ran. Try again ${read.retryAfterSeconds ? `in ${read.retryAfterSeconds} s` : "shortly"}. ${LOCAL_TOOLS_STILL_WORK}`,
      { lane: resource, httpStatus: 503, ...(read.retryAfterSeconds ? { retryAfterSeconds: read.retryAfterSeconds } : {}) },
    );
  }

  return refusal(
    command,
    "platform-unavailable",
    "E_PLATFORM",
    `The hosted lane at ${resource} answered ${read.httpStatus} with a body that is not one of its answers${read.said ? ` (${read.said})` : ""}.`,
    `Try again shortly. ${LOCAL_TOOLS_STILL_WORK}`,
    { lane: resource, httpStatus: read.httpStatus },
  );
}

export function hostedWaitOf(body: Args): HostedWait | null {
  const wait = isRow(body.value) ? body.value[HOSTED_WAIT_KEY] : null;
  if (!isRow(wait) || typeof wait.askedSeconds !== "number" || typeof wait.grantedSeconds !== "number") return null;

  return { askedSeconds: wait.askedSeconds, grantedSeconds: wait.grantedSeconds, notice: text(wait.notice) };
}

export function withoutHostedWait(body: Args): Args {
  const wait = hostedWaitOf(body);
  if (!wait || !isRow(body.value)) return body;

  const { [HOSTED_WAIT_KEY]: _cut, ...value } = body.value;
  const warnings = Array.isArray(body.warnings) ? body.warnings.filter((line) => line !== wait.notice) : body.warnings;

  return { ...body, value, ...(warnings !== undefined ? { warnings } : {}) };
}

/* @invariant A CUT WAIT IS SAID ONCE. The lane writes its notice into
 * value.hostedWait, into warnings and at times into the hint, about 450
 * bytes each time. The agent reads it once, in warnings; value.hostedWait
 * keeps the seconds asked and granted (ledger 959).
 */
export function withOneNotice(body: Args): Args {
  const wait = hostedWaitOf(body);
  if (!wait || !isRow(body.value)) return body;

  const { notice: _said, ...seconds } = body.value[HOSTED_WAIT_KEY] as Args;
  const value = { ...body.value, [HOSTED_WAIT_KEY]: seconds };
  if (!wait.notice) return { ...body, value };

  const hint = typeof body.hint === "string" && body.hint.includes(wait.notice) ? body.hint.replace(wait.notice, "").replace(/ {2,}/g, " ").trim() : body.hint;
  const warnings = [...(Array.isArray(body.warnings) ? body.warnings.filter((line) => line !== wait.notice) : []), wait.notice];

  return { ...body, value, warnings, ...(hint !== undefined ? { hint } : {}) };
}

/* @invariant A WAIT THAT TOOK SEVERAL LANE CALLS IS REPORTED WHOLE. The
 * lane cuts a long wait at its function's limit and the forwarder asks
 * again with the seconds still owed, so the last answer knows only its own
 * leg. The seconds the person actually waited are counted here, from the
 * first send, and written over the last leg's figure in value.waited and in
 * the sentence that names it.
 */
export function withWholeWait(body: Args, seconds: number): Args {
  const waited = isRow(body.value) ? body.value.waited : null;
  if (!isRow(waited) || typeof waited.seconds !== "number" || waited.seconds >= seconds) return body;

  const said = new RegExp(`\\bThe ${waited.seconds}( ?)s wait\\b`);
  const hint = typeof body.hint === "string" ? body.hint.replace(said, (_all, gap: string) => `The ${seconds}${gap}s wait`) : body.hint;

  return { ...body, value: { ...(body.value as Args), waited: { ...waited, seconds } }, ...(hint !== undefined ? { hint } : {}) };
}

const carried = new Map<string, CarriedMemory>();

/* @invariant THE FORWARDER IS THE PROCESS THAT SEES BOTH CALLS, SO IT KEEPS
 * WHAT THE HOSTED TOOLS REMEMBER. The lane keeps no state between calls: what
 * a tool put on its shelves comes back beside the answer, is kept here per
 * lane for as long as this server runs, and is carried into the next call.
 * It never reaches the agent, and it is never written to disk.
 */
export function carriedMemory(resource: string): CarriedMemory {
  return carried.get(resource) ?? {};
}

export function carriedRow(shelf: string, key: string): unknown {
  if (!key) return null;

  for (const memory of carried.values()) {
    const row = (memory[shelf] ?? []).find(([name]) => name === key);
    if (row) return row[1];
  }

  return null;
}

export function takeMemory(resource: string, body: Args): Args {
  if (!(MEMORY_KEY in body)) return body;

  const { [MEMORY_KEY]: memory, ...answer } = body;
  const kept = Object.fromEntries(Object.entries(readCarriedMemory(memory)).filter(([, rows]) => rows.length > 0));

  if (Object.keys(kept).length) carried.set(resource, kept);
  else carried.delete(resource);

  return answer;
}

export function forgetCarriedMemory(): void {
  carried.clear();
}

const ACTIVE_BUILD_WORDS = new Set(["building", "pending", "queued", "in_progress", "running", "requested", "waiting"]);
const FAILED_BUILD_WORDS = /fail|error|cancel|timed_out/;

export const FOLLOW_READ_TOOL = "extension_builds";

/* @invariant A BUILD ACT THE LANE CUT IS FOLLOWED HERE BY READS, NEVER BY
 * SENDING THE ACT AGAIN. The hosted lane ends every wait within its
 * function's limit, but this process has no limit of its own: a build act
 * that came back dispatched, its run still going, its wait cut, and the get
 * it names to follow it, is followed here. The get goes out as a read with
 * the seconds still owed until the build settles or the asked wait ends,
 * and the act answers once with what the record reads (ledger 1201).
 */
export function buildFollowOf(body: Args): Args | null {
  if (body.ok !== true || !text(body.status).endsWith("-dispatched") || !hostedWaitOf(body) || !isRow(body.value)) return null;

  const follow = isRow(body.value.follow) ? body.value.follow : null;
  const get = follow && isRow(follow.get) ? follow.get : null;
  const outcome = isRow(body.value.outcome) ? body.value.outcome : null;

  if (!get || text(get.action) !== "get" || !text(get.buildId) || !ACTIVE_BUILD_WORDS.has(text(outcome?.status).toLowerCase())) return null;

  return get;
}

export function followSettled(read: Args | null): boolean {
  const value = read && isRow(read.value) ? read.value : null;

  return read?.ok === true && text(read.status) === "read" && isRow(value?.waited) && value.waited.settled === true;
}

export function followedBuildAnswer(act: Args, read: Args | null, waitedSeconds: number): Args {
  const asked = hostedWaitOf(act)?.askedSeconds ?? waitedSeconds;
  const cutless = withoutHostedWait(act);
  const value = isRow(cutless.value) ? cutless.value : {};
  const outcome = isRow(value.outcome) ? value.outcome : {};
  const readValue = read && isRow(read.value) ? read.value : {};
  const build = isRow(readValue.build) ? readValue.build : null;
  const recordSays = text(build?.status);
  const kept = `This server kept waiting on the build here, past the hosted lane's limit, for ${waitedSeconds} s of the ${asked} s asked.`;

  if (!followSettled(read)) {
    return {
      ...cutless,
      value: { ...value, outcome: { ...outcome, ...(recordSays ? { status: recordSays } : {}), waitedSeconds }, waited: { seconds: waitedSeconds, settled: false } },
      hint: `${kept}${recordSays ? ` Its record still reads ${recordSays}.` : ""} ${text(act.hint)}`.trim(),
    };
  }

  const failed = Boolean(readValue.failures) || FAILED_BUILD_WORDS.test(`${recordSays} ${text(build?.conclusion)}`.toLowerCase());
  const status = recordSays || (failed ? "failed" : "success");
  const named = text(build?.buildId) || "this build";

  return {
    ...cutless,
    ok: !failed,
    status: failed ? "build-failed" : "built",
    value: { ...value, outcome: { ...outcome, status, recorded: true, waitedSeconds }, waited: { seconds: waitedSeconds, settled: true }, ...(build ? { build } : {}) },
    ...(failed ? { error: { code: "E_PLATFORM", name: "BuildFailed", message: `The platform's record of ${named} reads ${status} after this act.` } } : {}),
    hint: `${kept} The build settled and its record reads ${status}. ${text(read?.hint)}`.trim(),
  };
}
