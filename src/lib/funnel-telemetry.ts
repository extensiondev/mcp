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
