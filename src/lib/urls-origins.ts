// VENDORED MIRROR of `@extensiondev/urls/origins` (packages/extensiondev-urls).
// The MCP publishes STANDALONE from its own repo (its CI does a plain checkout +
// `pnpm install` with no monorepo workspace), so it cannot carry a `workspace:*`
// dependency on the private urls package. This is a byte-for-byte copy of that
// module's body; keep the two in sync (the apps import the canonical one).
//
// Origin resolution: the *host* half of every cross-app link, in one place.
//
// Callers stay rename-free. Each runtime names its env vars differently
// (Next: NEXT_PUBLIC_WWW_*, Vite console: APP_*, Vite templates: VITE_*, MCP:
// EXTENSION_DEV_*), so this module never reads process.env / import.meta.env
// itself. The caller reads its own vars and passes the values in; this module
// owns the DEFAULTS and the local-dev derivation so those two facts live once.

/** The set of app/service origins the fleet links between. */
export interface Origins {
  www: string;
  console: string;
  inspect: string;
  templates: string;
  intelligence: string;
  /** Public release-state JSON host (registry.extension.land). */
  registry: string;
  /** Content-addressed template corpus host (media.extension.land). */
  media: string;
}

/** Production origins. The prod fallback for every resolver in the fleet. */
export const PROD_ORIGINS: Origins = {
  www: "https://www.extension.dev",
  console: "https://console.extension.dev",
  inspect: "https://inspect.extension.dev",
  templates: "https://templates.extension.dev",
  intelligence: "https://intelligence.extension.dev",
  registry: "https://registry.extension.land",
  media: "https://media.extension.land",
};

// Local-dev origins mirror the Caddy hostname proxy (repo-root Caddyfile).
// HARD GOTCHA (see the localhost-subdomain-proxy note): hosts MUST be
// `<prefix>.extension.localhost`, never `<prefix>.localhost` -- browsers treat
// `localhost` as a public suffix, so a `Domain=localhost` cookie is stored
// host-only and never reaches the sibling app. `www` stays bare `localhost`
// because GitHub OAuth callbacks are port-insensitive only for `localhost`.
export const DEV_LOCALHOST_ORIGINS: Origins = {
  www: "http://localhost:3100",
  console: "http://console.extension.localhost",
  inspect: "http://inspect.extension.localhost",
  templates: "http://templates.extension.localhost",
  intelligence: "http://intelligence.extension.localhost",
  registry: "https://registry.extension.land",
  media: "https://media.extension.land",
};

function strip(value: string | undefined | null): string {
  return String(value ?? "").trim().replace(/\/+$/, "");
}

/**
 * True for `localhost`, `127.0.0.1`, `[::1]`, or any `*.extension.localhost`
 * host -- the shapes the dev proxy serves. Anything unparseable is treated as
 * not-local so an odd value falls back to prod rather than leaking a dev host.
 */
export function isLocalOrigin(url: string | undefined | null): boolean {
  const raw = strip(url);
  if (!raw) return false;
  let host: string;
  try {
    host = new URL(raw).hostname;
  } catch {
    return false;
  }
  return (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host === "[::1]" ||
    host === "extension.localhost" ||
    host.endsWith(".extension.localhost")
  );
}

/**
 * Resolve the full origin set from a caller's overrides.
 *
 * Precedence per origin: explicit override -> derived base (dev vs prod) ->
 * prod. The base is chosen by whether the environment looks local: if any of
 * `www`/`console`/`hint` points at a local host, unset origins derive from the
 * Caddy dev map instead of prod. This is what lets an operator set only
 * `EXTENSION_DEV_API_URL=http://localhost:3100` and still get a console link at
 * `console.extension.localhost` rather than one that silently points at prod.
 */
export function resolveOrigins(
  overrides: Partial<Origins> = {},
  opts: { hint?: string } = {},
): Origins {
  const devLike =
    isLocalOrigin(overrides.www) ||
    isLocalOrigin(overrides.console) ||
    isLocalOrigin(opts.hint);
  const base = devLike ? DEV_LOCALHOST_ORIGINS : PROD_ORIGINS;
  const pick = (key: keyof Origins): string => strip(overrides[key]) || base[key];
  return {
    www: pick("www"),
    console: pick("console"),
    inspect: pick("inspect"),
    templates: pick("templates"),
    intelligence: pick("intelligence"),
    registry: pick("registry"),
    media: pick("media"),
  };
}
