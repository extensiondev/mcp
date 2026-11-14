// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { isEnvelope } from "./envelope";

type Args = Record<string, unknown>;

export const PREFLIGHT_HEADER = "x-extensiondev-preflight";
export const PREFLIGHT_TIMEOUT_MS = 5_000;
export const LANE_READ_KEY = "hostedLane";
export const CLOSED_STATUSES: readonly string[] = ["lane-closed", "hosted-off"];

const PREFLIGHT_STATUSES = ["lane-ready", "lane-closed", "preflight-partial"] as const;
const CLOSED_MAX = 12;

export interface ClosedSwitch {
  switch: string;
  closes: string;
}

export interface LanePreflight {
  status: (typeof PREFLIGHT_STATUSES)[number];
  closed: ClosedSwitch[];
}

function isRow(value: unknown): value is Args {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function line(value: unknown, max: number): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "";
}

/* @invariant ONE QUESTION WITH NO CREDENTIAL SAYS WHICH SWITCH KEEPS THE
 * LANE SHUT. A closed lane used to read as "switched off or not deployed",
 * and the person could not tell their login from the platform's own
 * switches. The lane answers a preflight before its own switch and with no
 * bearer, so the forwarder asks it once when an answer says the lane is
 * closed, and once for an auth status, and names each closed switch by its
 * variable. Nothing of the login is sent, a redirect is never followed, and
 * a lane that does not answer the preflight (an older one, or none) is read
 * as no answer: the call's own answer stands as it was.
 */
export async function readLanePreflight(resource: string, forwarderVersion: string, fetchImpl?: typeof fetch): Promise<LanePreflight | null> {
  try {
    const res = await (fetchImpl ?? globalThis.fetch)(resource, {
      method: "POST",
      headers: { accept: "application/json", "x-extensiondev-forwarder": forwarderVersion, [PREFLIGHT_HEADER]: "1" },
      redirect: "manual",
      signal: AbortSignal.timeout(PREFLIGHT_TIMEOUT_MS),
    });
    const body: unknown = res.status === 200 ? await res.json().catch(() => null) : null;
    const status = isRow(body) ? PREFLIGHT_STATUSES.find((known) => known === body.status) : undefined;
    const value = isRow(body) && isRow(body.value) ? body.value : null;

    if (!status || !value || !Array.isArray(value.closed)) return null;

    const closed = value.closed
      .filter(isRow)
      .map((entry) => ({ switch: line(entry.switch, 64), closes: line(entry.closes, 200) }))
      .filter((entry) => /^[A-Z][A-Z0-9_]*$/.test(entry.switch))
      .slice(0, CLOSED_MAX);

    return { status, closed };
  } catch {
    return null;
  }
}

export function preflightSentence(read: LanePreflight): string {
  const named = read.closed.map((entry) => (entry.closes ? `${entry.switch} (closes ${entry.closes})` : entry.switch)).join(", ");

  if (named) return `The lane's preflight names what is closed: ${named}. ${read.closed.length === 1 ? "That switch is" : "Those switches are"} extension.dev's, not this machine's, and this login is fine.`;
  if (read.status === "lane-ready") return "The lane's preflight reads every switch open now, so call again.";

  return "The lane's preflight could not read the platform's switches, so it names none.";
}

export function withLanePreflight(body: Args, resource: string, read: LanePreflight, say: boolean): Args {
  const value = { ...(isRow(body.value) ? body.value : {}), [LANE_READ_KEY]: { lane: resource, status: read.status, closed: read.closed } };

  return { ...body, value, ...(say ? { hint: [typeof body.hint === "string" ? body.hint : "", preflightSentence(read)].filter(Boolean).join(" ") } : {}) };
}

export function readAnswer(answer: string): Args | null {
  try {
    const parsed: unknown = JSON.parse(answer);

    return isEnvelope(parsed) ? (parsed as unknown as Args) : null;
  } catch {
    return null;
  }
}
