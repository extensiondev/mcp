// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { scratchOfCall } from "./call-memory";
import { requestCredential } from "./credential-scope";
import { captureCreationFunnelEvent } from "./funnel-telemetry";

export const DASHBOARD_URL_COMPOSED_EVENT = "mcp_dashboard_url_composed";

export const DASHBOARD_HOSTS: ReadonlyArray<{ store: string; host: string; paths: readonly string[] }> = [
  { store: "chrome", host: "chrome.google.com", paths: ["/webstore/devconsole"] },
  { store: "edge", host: "partner.microsoft.com", paths: ["/dashboard/microsoftedge"] },
  { store: "firefox", host: "addons.mozilla.org", paths: ["/developers"] },
  { store: "safari", host: "appstoreconnect.apple.com", paths: ["/apps", "/access/integrations/api"] },
];

const ENCODED_SEPARATOR = /%2f|%5c/i;

const COMPOSED_LIMIT = 64;
const SCAN_DEPTH = 8;

type ComposedUrl = { url: string; store: string; host: string; match: RegExp };

type Frame = {
  command: string;
  status: string;
  value?: unknown;
  hint?: string;
  warnings?: string[];
  error?: unknown;
};

export type DashboardUrlProperties = {
  tool: string;
  status: string;
  stores: string;
  dashboard_hosts: string;
  count: number;
  composed_by: "mcp";
};

type Capture = (event: string, properties: DashboardUrlProperties) => Promise<unknown>;

const composed = new Map<string, ComposedUrl>();

/* @invariant AN ADDRESS COMPOSED DURING A CALL IS KEPT FOR THAT CALL ONLY.
 * The Chrome item address carries the caller's publisher and item ids, and a
 * hosted function answers many callers from one process, so an address a tool
 * composes inside a call memory scope sits on that call's scratch and ends
 * with it. Outside a call (the constants composed when a module loads, and a
 * person's own machine, which runs no call scope) the map is this module's,
 * and a reader sees both. A hosted request outside a call keeps nothing.
 */
function composedHere(): Map<string, ComposedUrl> {
  return scratchOfCall<ComposedUrl>("dashboard-urls") ?? (requestCredential() ? new Map() : composed);
}

function everyComposed(): ComposedUrl[] {
  const call = scratchOfCall<ComposedUrl>("dashboard-urls");

  return call ? [...composed.values(), ...call.values()] : [...composed.values()];
}

function escaped(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function dashboardStoreOf(url: unknown): { store: string; host: string } | null {
  let parsed: URL;

  try {
    parsed = new URL(typeof url === "string" ? url.trim() : "");
  } catch {
    return null;
  }

  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.port) return null;

  const host = parsed.hostname.toLowerCase();
  const pathname = parsed.pathname.toLowerCase();
  if (ENCODED_SEPARATOR.test(pathname)) return null;

  const row = DASHBOARD_HOSTS.find((known) => known.host === host && known.paths.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`)));

  return row ? { store: row.store, host: row.host } : null;
}

/* @invariant A DASHBOARD ADDRESS THIS SERVER COMPOSES IS COUNTED WHERE IT
 * IS SAID. The release DX meter (www release-dx-meter.ts, 2026-10-28) counts
 * a store answer carrying a store dashboard address as one round trip the
 * person has to make, but it sees only the addresses www sent; the Chrome
 * devconsole, the Partner Center product and key pages, the AMO key page and
 * the App Store Connect key page this server composes itself never reach it.
 * Every composer passes its address through composedDashboardUrl, the
 * envelope scans each answer for exactly those strings (whole, or ending a
 * sentence, never as a prefix of an address the platform sent), and one
 * mcp_dashboard_url_composed event per answer names the tool, the status,
 * the stores and the hosts, so scripts/release-dx-read.mjs can add the
 * MCP's own round trips to the platform's. */
export function composedDashboardUrl(url: string): string {
  const known = dashboardStoreOf(url);
  if (!known) return url;

  const held = composedHere();

  held.delete(url);
  held.set(url, { url, ...known, match: new RegExp(`${escaped(url)}(?=$|[\\s.,;:!?)"'\\]>])`) });

  for (const oldest of held.keys()) {
    if (held.size <= COMPOSED_LIMIT) break;

    held.delete(oldest);
  }

  return url;
}

export function composedDashboardUrls(): string[] {
  return everyComposed().map((row) => row.url);
}

function strings(value: unknown, depth: number, out: string[]): void {
  if (typeof value === "string") {
    if (value.includes("https://")) out.push(value);

    return;
  }

  if (depth <= 0 || !value || typeof value !== "object") return;

  for (const entry of Array.isArray(value) ? value : Object.values(value as Record<string, unknown>)) {
    strings(entry, depth - 1, out);
  }
}

export function composedDashboardUrlsIn(frame: Frame): ComposedUrl[] {
  const rows = everyComposed();
  if (rows.length === 0) return [];

  const texts: string[] = [];
  strings(frame.value, SCAN_DEPTH, texts);
  strings(frame.hint, 1, texts);
  strings(frame.warnings, 2, texts);
  strings(frame.error, 3, texts);
  if (!texts.length) return [];

  return rows.filter((row) => texts.some((text) => text.includes(row.url) && row.match.test(text)));
}

export function dashboardUrlProperties(frame: Frame, found: ComposedUrl[]): DashboardUrlProperties {
  const stores = [...new Set(found.map((row) => row.store))];
  const hosts = [...new Set(found.map((row) => row.host))];

  return {
    tool: frame.command,
    status: frame.status,
    stores: stores.join(","),
    dashboard_hosts: hosts.join(","),
    count: found.length,
    composed_by: "mcp",
  };
}

export function meterComposedDashboardUrls(frame: Frame, capture: Capture = captureCreationFunnelEvent): Promise<DashboardUrlProperties | null> {
  try {
    const found = composedDashboardUrlsIn(frame);
    if (!found.length) return Promise.resolve(null);

    const properties = dashboardUrlProperties(frame, found);

    return capture(DASHBOARD_URL_COMPOSED_EVENT, properties).then(
      () => properties,
      () => properties,
    );
  } catch {
    return Promise.resolve(null);
  }
}
