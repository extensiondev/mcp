// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { PROD_ORIGINS } from "@extension.dev/urls/origins";

import { sanitizeMcpProperties } from "./analytics-scrub";
import { mcpOrigins } from "./registry";
import { sessionId, telemetryDisabled } from "./session-identity";
import { resolvedTemplateCommit } from "./template-artifact-source";

const DEFAULT_POSTHOG_HOST = "https://us.i.posthog.com";

/* @invariant This is the extension.dev PLATFORM project key, not the
 * Extension.js CLI one.
 *
 * `phc_Np5x...` belongs to "Extension.js Open Source Metrics" in a different
 * PostHog organization; it is deliberate where it ships and it is the wrong
 * destination here. A creation funnel whose web half lands in project 16972 and
 * whose tool half lands in 228739 is two funnels that can never be joined, so
 * the entry property would scope a denominator nobody can read. `phc_` project
 * keys are public write-only ingestion tokens by design, and this exact string
 * already ships in the code.extension.dev browser bundle, so shipping it in a
 * published package adds no disclosure.
 */
const PLATFORM_PROJECT_KEY = "phc_t8hwHt3uJdjxil8TUA9AIWUFeWyJtTxhfXV58bPiV6T";

export const DRAFT_SEEDED_EVENT = "draft_seeded";
export const FUNNEL_ENTRY = "mcp";
export const FUNNEL_SOURCE = "@extension.dev/mcp";
export const FUNNEL_EMITTED_FROM = "node";

export type SeedSource = "template" | "fork" | "blank-init";

export type CreationFunnelProperties = Record<
  string,
  string | number | boolean | null
>;

export type CreationFunnelPayload = {
  api_key: string;
  event: string;
  distinct_id: string;
  timestamp: string;
  properties: Record<string, string | number | boolean | null>;
};

export function posthogHost(): string {
  return (
    String(process.env.EXTENSION_DEV_POSTHOG_HOST || "").trim() ||
    DEFAULT_POSTHOG_HOST
  );
}

function trimSlashes(value: string): string {
  return String(value || "").replace(/\/+$/, "");
}

/* @invariant The environment is read from the origin this install talks to,
 * never from NODE_ENV.
 *
 * The web lane learned that a mode string every build sets to "production"
 * separates nothing, so it picks the project key by environment instead. The
 * tool lane has no deploy environment at all: it runs on a developer's machine.
 * The only honest signal is which fleet it is pointed at, and pointing it
 * elsewhere is exactly what EXTENSION_DEV_API_URL does, so our own local runs
 * fall out of the production key by construction.
 */
export function funnelEnvironment(): string {
  return trimSlashes(mcpOrigins().www) === trimSlashes(PROD_ORIGINS.www)
    ? "production"
    : "development";
}

export function posthogKeyForEnvironment(environment: unknown): string {
  if (String(environment || "").trim() === "production") {
    return (
      String(process.env.EXTENSION_DEV_POSTHOG_KEY || "").trim() ||
      PLATFORM_PROJECT_KEY
    );
  }
  return String(
    process.env.EXTENSION_DEV_POSTHOG_KEY_NONPRODUCTION || "",
  ).trim();
}

export function shouldSendCreationFunnelEvent(): boolean {
  if (telemetryDisabled()) return false;
  if (!posthogKeyForEnvironment(funnelEnvironment())) return false;
  if (!sessionId()) return false;
  return typeof fetch === "function";
}

export function seedRef(slug: unknown, commit: unknown): string {
  return `${String(slug || "").trim()}@${String(commit || "").trim()}`;
}

/* @invariant One shape, two lanes, or the sum is a lie.
 *
 * These properties are Joan's `captureCreationFunnelEvent` in
 * code.extension.dev/src/workspace/funnel-telemetry.ts, key for key:
 * seed_source, seed_ref, seed_slug, session_id, entry, environment, source,
 * emitted_from and `$process_person_profile: false`. Only `entry`, `source` and
 * `emitted_from` differ in value, which is the whole point: one funnel, two
 * named denominators, summable because nothing else moved. Adding a property
 * here that the web lane does not send, or renaming one it does, forks the
 * funnel silently, and a silently forked funnel gets summed anyway.
 *
 * The distinct id is the PROCESS SESSION id and never the install id. The
 * install id persists across runs and would make a person count out of a
 * session count, which is the defect the preview disclosure already taught us
 * once. These rows are sessions from birth and may never be quoted as users.
 *
 * `draft_id` is null on this lane on purpose: a scaffolded directory is not a
 * draft row and inventing an id for it would put a key in the funnel that joins
 * to nothing.
 */
export function creationFunnelPayload(
  event: string,
  properties: CreationFunnelProperties,
  now: Date = new Date(),
): CreationFunnelPayload | null {
  if (!shouldSendCreationFunnelEvent()) return null;
  const environment = funnelEnvironment();
  const session = sessionId();
  return {
    api_key: posthogKeyForEnvironment(environment),
    event,
    distinct_id: session,
    timestamp: now.toISOString(),
    properties: {
      draft_id: null,
      ...sanitizeMcpProperties(properties),
      source: FUNNEL_SOURCE,
      entry: FUNNEL_ENTRY,
      session_id: session,
      environment,
      emitted_from: FUNNEL_EMITTED_FROM,
      $process_person_profile: false,
    },
  };
}

/* @invariant THIS CAPTURE HAS NO DURABLE ROW BEHIND IT ON THIS LANE.
 *
 * The web lane writes the draft row, the checkpoint and the provenance stamp
 * BEFORE it captures, so a dropped capture loses no fact and the board's
 * durable-rows-first rule holds. `extension_create` writes to the caller's disk
 * and talks to no endpoint of ours, and the one durable tool-lane record we do
 * keep, agent-sessions, is fixed at four fields by its own invariant and has no
 * room for a seed ref. So this event is the ONLY record that a tool-lane start
 * happened, which makes it a convenience view over nothing. Read it to compare
 * templates against each other; do not quote it as a company number under the
 * analytics tier rule until a durable seed row exists to back it.
 *
 * Never awaited by a tool handler and never able to fail one: the commit
 * resolution behind `seed_ref` is a network read with a pinned fallback, and no
 * scaffold may wait on it or die with it.
 */
export async function captureCreationFunnelEvent(
  event: string,
  properties: CreationFunnelProperties,
  fetchImpl: typeof fetch = fetch,
): Promise<CreationFunnelPayload | null> {
  try {
    const payload = creationFunnelPayload(event, properties);
    if (!payload) return null;
    await fetchImpl(`${posthogHost()}/capture/`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }).catch(() => undefined);
    return payload;
  } catch {
    return null;
  }
}

export async function captureTemplateSeed(
  input: { slug: string; source?: SeedSource },
  fetchImpl: typeof fetch = fetch,
): Promise<CreationFunnelPayload | null> {
  try {
    const slug = String(input?.slug || "").trim();
    if (!slug) return null;
    if (!shouldSendCreationFunnelEvent()) return null;
    const commit = await resolvedTemplateCommit();
    return await captureCreationFunnelEvent(
      DRAFT_SEEDED_EVENT,
      {
        seed_source: input.source ?? "template",
        seed_ref: seedRef(slug, commit),
        seed_slug: slug,
      },
      fetchImpl,
    );
  } catch {
    return null;
  }
}
