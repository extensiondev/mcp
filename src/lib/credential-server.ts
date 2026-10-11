// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { DEV_LOCALHOST_ORIGINS, PROD_ORIGINS } from "@extension.dev/urls/origins";

const LOCAL_WWW = new URL(DEV_LOCALHOST_ORIGINS.www);
const LOCAL_ALIAS_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const LOCAL_PROXY_HOSTS = new Set(["extension.localhost", "www.extension.localhost"]);
const PROD_WWW = new URL(PROD_ORIGINS.www);
const PROD_APEX_HOST = PROD_WWW.hostname.replace(/^www\./, "");

/* @invariant ONE FLEET IS ONE SERVER, WHATEVER NAME REACHES IT.
 *
 * Logins are filed per server, so two names for the same www would file the
 * same login twice and read it as missing through the other name. The local
 * fleet answers on localhost:3100, 127.0.0.1:3100 and, through the local
 * proxy, www.extension.localhost, which is where its own approval pages send
 * people; production answers on the apex, which redirects to www. Each set
 * folds to the one origin the platform names itself by.
 */
function canonicalOrigin(parsed: URL): string {
  const host = parsed.hostname.toLowerCase();
  const port = parsed.port || (parsed.protocol === "https:" ? "443" : "80");
  const localPort = LOCAL_WWW.port || "80";

  if (LOCAL_ALIAS_HOSTS.has(host) && port === localPort) return LOCAL_WWW.origin;
  if (LOCAL_PROXY_HOSTS.has(host) && !parsed.port) return LOCAL_WWW.origin;
  if (host === PROD_APEX_HOST && parsed.protocol === PROD_WWW.protocol) return PROD_WWW.origin;

  return parsed.origin;
}

function normalize(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, "");

  try {
    const parsed = new URL(trimmed);

    return `${canonicalOrigin(parsed)}${parsed.pathname}`.replace(/\/+$/, "").toLowerCase();
  } catch {
    return trimmed.toLowerCase();
  }
}

export const DEFAULT_SERVER = normalize(PROD_ORIGINS.www);

export function serverOf(api?: string | null): string {
  const raw = String(api ?? "").trim();

  return raw ? normalize(raw) : DEFAULT_SERVER;
}

export function targetServer(api?: string | null): string {
  return serverOf(String(api ?? "").trim() || process.env.EXTENSION_DEV_API_URL);
}

export function loginKey(workspaceSlug: string, projectSlug: string, api?: string | null): string {
  const ref = `${workspaceSlug}/${projectSlug}`.toLowerCase();
  const server = serverOf(api);

  return server === DEFAULT_SERVER ? ref : `${server} ${ref}`;
}
