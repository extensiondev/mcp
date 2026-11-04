// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { captureCreationFunnelEvent } from "./funnel-telemetry";

export const DASHBOARD_URL_COMPOSED_EVENT = "mcp_dashboard_url_composed";

export const DASHBOARD_HOSTS: ReadonlyArray<{ store: string; host: string; test: RegExp }> = [
  { store: "chrome", host: "chrome.google.com", test: /^https:\/\/chrome\.google\.com\/webstore\/devconsole(?:[/?#]|$)/i },
  { store: "edge", host: "partner.microsoft.com", test: /^https:\/\/partner\.microsoft\.com(?:[/?#]|$)/i },
  { store: "firefox", host: "addons.mozilla.org", test: /^https:\/\/addons\.mozilla\.org\/developers(?:[/?#]|$)/i },
  { store: "safari", host: "appstoreconnect.apple.com", test: /^https:\/\/appstoreconnect\.apple\.com(?:[/?#]|$)/i },
];

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

function escaped(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function dashboardStoreOf(url: unknown): { store: string; host: string } | null {
  const value = typeof url === "string" ? url.trim() : "";
  if (!value) return null;

  const row = DASHBOARD_HOSTS.find((host) => host.test.test(value));

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

  composed.delete(url);
  composed.set(url, { url, ...known, match: new RegExp(`${escaped(url)}(?=$|[\\s.,;:!?)"'\\]>])`) });

  for (const oldest of composed.keys()) {
    if (composed.size <= COMPOSED_LIMIT) break;

    composed.delete(oldest);
  }

  return url;
}

export function composedDashboardUrls(): string[] {
  return [...composed.keys()];
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
  if (composed.size === 0) return [];

  const texts: string[] = [];
  strings(frame.value, SCAN_DEPTH, texts);
  strings(frame.hint, 1, texts);
  strings(frame.warnings, 2, texts);
  strings(frame.error, 3, texts);
  if (!texts.length) return [];

  return [...composed.values()].filter((row) => texts.some((text) => text.includes(row.url) && row.match.test(text)));
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
