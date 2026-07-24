// VENDORED MIRROR of `@extensiondev/urls/paths` (packages/extensiondev-urls).
// See ./urls-origins.ts for why the MCP vendors instead of depending on the
// workspace package. Keep in sync with the canonical module.
//
// Pure, environment-free route builders: the single source of truth for the
// *path* half of every cross-app link in the fleet. No origins live here (see
// ./urls-origins) so these functions are safe to call from any runtime, and
// they encode the SAME path shapes the apps actually serve, so a link the MCP
// hands back can never drift from a route the app router recognizes.
//
// Route sources this mirrors (keep in sync if the app routers change):
//   console:   apps/console.extension.dev/src/app/routes.ts
//   templates: apps/templates.extension.dev/src/lib/template-paths.ts
//   inspect:   apps/inspect.extension.dev/src/app/paths.ts
//   www:       apps/www.extension.dev/src/middleware.ts (NON_DASHBOARD_TOP)

/** A project is addressed by its workspace slug + project slug across the fleet. */
export interface ProjectRef {
  workspace: string;
  project: string;
}

const seg = (value: string): string => encodeURIComponent(String(value));

/** Join a base with a sub-path, tolerating leading/trailing slashes. */
function join(base: string, sub?: string): string {
  if (!sub) return base;
  return `${base}/${sub.replace(/^\/+/, "")}`;
}

// ---------------------------------------------------------------------------
// console.extension.dev -- the authenticated dashboard (Vite SPA, react-router)
// Routes are /:username/:reponame/... where username = workspace, reponame =
// project. Ordered per apps/console.extension.dev/src/app/routes.ts.
// ---------------------------------------------------------------------------

/** `/:workspace` (or a sub-page like `settings` / `settings/:section`). */
export function consoleWorkspacePath(workspace: string, page = ""): string {
  return join(`/${seg(workspace)}`, page);
}

/**
 * `/:workspace/:project/<page>`. Pass a page tail from `ConsoleProjectPage`
 * (e.g. `ConsoleProjectPage.builds`) rather than hand-typing it, so a route
 * rename is a one-line change here instead of a scattered string edit.
 */
export function consoleProjectPath(ref: ProjectRef, page = ""): string {
  return join(`/${seg(ref.workspace)}/${seg(ref.project)}`, page);
}

/**
 * Named project-page tails. Values are the exact segments under
 * `/:username/:reponame/` in console's route table; deep pages take ids.
 */
export const ConsoleProjectPage = {
  overview: "",
  onboard: "onboard",
  activity: "activity",
  builds: "builds",
  build: (buildId: string, browser?: string): string =>
    browser ? `builds/${seg(buildId)}/${seg(browser)}` : `builds/${seg(buildId)}`,
  releases: "releases",
  releasesNew: "releases/new",
  release: (releaseId: string): string => `releases/${seg(releaseId)}`,
  stores: "stores",
  storesNew: "stores/new",
  store: (store: string): string => `stores/${seg(store)}`,
  storeSubmissions: (store: string): string => `stores/${seg(store)}/submissions`,
  storeSubmissionNew: (store: string): string => `stores/${seg(store)}/submissions/new`,
  storeSubmission: (store: string, submissionId: string): string =>
    `stores/${seg(store)}/submissions/${seg(submissionId)}`,
  projectSettings: "project-settings",
  projectSettingsSection: (section: string): string => `project-settings/${seg(section)}`,
  /** Where CLI/MCP tokens are minted and revoked. */
  accessTokens: "settings/access-tokens",
} as const;

// ---------------------------------------------------------------------------
// www.extension.dev -- public entry / creation routes (Next.js App Router).
// These stay on www (NON_DASHBOARD_TOP); console redirects its own copies here.
// ---------------------------------------------------------------------------

export type QueryValue = string | number | boolean | null | undefined;

function withQuery(path: string, query?: Record<string, QueryValue>): string {
  if (!query) return path;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === null || value === undefined || value === "") continue;
    params.set(key, String(value));
  }
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}

/**
 * `/new?...` -- project creation. The public deep-link contract: external
 * READMEs use `extension.dev/new?template=<slug>`, which www normalizes to
 * `/import` preserving every param. Do not change the `template` key.
 */
export function wwwNewPath(query?: Record<string, QueryValue>): string {
  return withQuery("/new", query);
}

/** `/import?...` -- the ported import/deploy flow templates' Deploy buttons target. */
export function wwwImportPath(query?: Record<string, QueryValue>): string {
  return withQuery("/import", query);
}

/** `/device` -- CLI/MCP device-code consent. Lives on www, never console. */
export function wwwDevicePath(): string {
  return "/device";
}

/** `/templates` and `/templates/:slug` -- externally linkable gallery entry on www. */
export function wwwTemplatesPath(slug?: string): string {
  return slug ? `/templates/${seg(slug)}` : "/templates";
}

// ---------------------------------------------------------------------------
// templates.extension.dev -- gallery detail tabs (Vite SPA, react-router).
// Mirrors apps/templates.extension.dev/src/lib/template-paths.ts.
// ---------------------------------------------------------------------------

export type TemplateTab = "preview" | "instructions" | "source";

/** `/:slug` for the default `preview` tab, else `/:slug/<tab>`. */
export function templateTabPath(slug: string, tab: TemplateTab = "preview"): string {
  return tab === "preview" ? `/${seg(slug)}` : `/${seg(slug)}/${tab}`;
}

// ---------------------------------------------------------------------------
// inspect.extension.dev -- preview/details/source/trace tabs (path-as-tab SPA).
// Mirrors apps/inspect.extension.dev/src/app/paths.ts.
// ---------------------------------------------------------------------------

export type InspectTab = "preview" | "details" | "source" | "trace";

/** `/` for the default `preview` tab, else `/details` / `/source` / `/trace`. */
export function inspectTabPath(tab: InspectTab = "preview"): string {
  return tab === "preview" ? "/" : `/${tab}`;
}
