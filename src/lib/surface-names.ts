// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

export const SURFACE_NAME_ALIASES: Readonly<Record<string, string>> = { sidebar: "side-panel" };

export function canonicalSurfaceName(name: string): string {
  return SURFACE_NAME_ALIASES[name] ?? name;
}

const URL_OVERRIDE_KEYS = ["newtab", "history", "bookmarks"] as const;

const RESERVED_NAME_EXEMPTIONS: ReadonlySet<string> = new Set(["_locales", "_platform_specific", "__MACOSX"]);

const CHROMIUM_CLEANED_METADATA = /^_metadata\/(?:verified_contents\.json|computed_hashes\.json|generated_indexed_rulesets(?:\/.*)?)$/;

function refusesInstall(manifest: Record<string, any>, paths: readonly string[]): boolean {
  const overrides = manifest.chrome_url_overrides;
  if (overrides && URL_OVERRIDE_KEYS.filter((key) => overrides[key] !== undefined).length >= 2) return true;

  return paths.some((raw) => {
    const trimmed = raw.replace(/^(?:\.\/|\/)+/, "");
    if (CHROMIUM_CLEANED_METADATA.test(trimmed)) return false;

    const name = trimmed.split("/")[0] ?? "";

    return name.startsWith("_") && !RESERVED_NAME_EXEMPTIONS.has(name);
  });
}

export function renderableSurfaces(manifest: Record<string, any>, paths: readonly string[] = []): string[] {
  if (refusesInstall(manifest, paths)) return [];

  const surfaces = new Set<string>();
  if (manifest.action?.default_popup ?? manifest.browser_action?.default_popup) surfaces.add("popup");
  if (manifest.chrome_url_overrides?.newtab) surfaces.add("newtab");
  if (manifest.chrome_url_overrides?.history) surfaces.add("history");
  if (manifest.chrome_url_overrides?.bookmarks) surfaces.add("bookmarks");
  if (manifest.options_ui?.page ?? manifest.options_page) surfaces.add("options");
  if (manifest.background?.page) surfaces.add("background-page");
  if (manifest.background?.service_worker) surfaces.add("background-worker");
  if (manifest.sandbox?.pages?.length) surfaces.add("sandbox-page");
  if (manifest.side_panel?.default_path ?? manifest.sidebar_action?.default_panel) surfaces.add("side-panel");
  if (manifest.devtools_page) surfaces.add("devtools");

  return [...surfaces];
}

export function renderableContentScripts(manifest: Record<string, any>, paths: readonly string[] = []): Array<{ matches: string[]; js: string[]; css: string[] }> {
  if (refusesInstall(manifest, paths) || !Array.isArray(manifest.content_scripts)) return [];

  const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);

  return manifest.content_scripts
    .filter((script: unknown) => script && typeof script === "object")
    .map((script: Record<string, unknown>) => ({ matches: strings(script.matches), js: strings(script.js), css: strings(script.css) }));
}
