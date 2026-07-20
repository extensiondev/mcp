// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// MIT License (c) Cezar Augusto and the extension.dev collaborators

import fs from "node:fs";
import path from "node:path";
import { filterKeysForThisBrowser } from "browser-extension-manifest-fields";
import { isChromiumFamily, isGeckoFamily } from "../lib/browser-family";
import { listTemplates } from "../lib/templates-cache";

// Recognized MV3 API permissions across Chromium and Firefox. Not exhaustive of
// every experimental flag, but covers the stable surface; unknown values warn.
const KNOWN_PERMISSIONS = new Set<string>([
  "activeTab", "alarms", "background", "bookmarks", "browsingData",
  "certificateProvider", "clipboardRead", "clipboardWrite", "contentSettings",
  "contextMenus", "cookies", "debugger", "declarativeContent",
  "declarativeNetRequest", "declarativeNetRequestWithHostAccess",
  "declarativeNetRequestFeedback", "desktopCapture", "dns", "documentScan",
  "downloads", "downloads.open", "downloads.ui", "enterprise.deviceAttributes",
  "enterprise.hardwarePlatform", "enterprise.networkingAttributes",
  "enterprise.platformKeys", "favicon", "fileBrowserHandler",
  "fileSystemProvider", "fontSettings", "gcm", "geolocation", "history",
  "identity", "identity.email", "idle", "loginState", "management",
  "nativeMessaging", "notifications", "offscreen", "pageCapture", "power",
  "printerProvider", "printing", "printingMetrics", "privacy", "processes",
  "proxy", "readingList", "runtime", "scripting", "search", "sessions",
  "sidePanel", "storage", "system.cpu", "system.display", "system.memory",
  "system.storage", "tabCapture", "tabGroups", "tabs", "topSites", "tts",
  "ttsEngine", "unlimitedStorage", "vpnProvider", "wallpaper", "webAuthenticationProxy",
  "webNavigation", "webRequest", "webRequestBlocking", "webRequestAuthProvider",
  // Firefox-specific
  "browserSettings", "captivePortal", "contextualIdentities", "dns",
  "menus", "menus.overrideContext", "pkcs11", "theme", "webRequestFilterResponse",
]);

export const schema = {
  name: "extension_manifest_validate",
  description:
    "Validate a manifest.json file for correctness across browsers. Reports missing fields, invalid permissions, and cross-browser compatibility issues.",
  inputSchema: {
    type: "object" as const,
    properties: {
      manifestPath: {
        type: "string",
        description: "Path to manifest.json. Or pass projectPath and the manifest is located for you.",
      },
      projectPath: {
        type: "string",
        description:
          "Path to the extension project root; manifest.json is resolved from it (root or src/). Accepted in place of manifestPath.",
      },
      browsers: {
        type: "array",
        items: { type: "string" },
        default: ["chrome", "firefox"],
        description: "Browsers to validate against",
      },
      browser: {
        type: "string",
        description:
          "Single browser to validate against; alias for browsers:[browser] to match the other tools.",
      },
    },
    required: [],
  },
};

// Manifest fields whose value is a path to a bundled file. Globs, URLs, and
// data: refs are not local files and are skipped. Extension.js resolves these
// from a source root, so a miss is reported as a WARNING (verify with build),
// never a hard error, to avoid false blockers on layouts we don't fully model.
function collectPathRefs(m: Record<string, unknown>): string[] {
  const refs: string[] = [];
  const push = (v: unknown) => {
    if (typeof v === "string") refs.push(v);
  };
  const action = (m.action || m.browser_action) as Record<string, unknown> | undefined;
  if (action) {
    push(action.default_popup);
    if (typeof action.default_icon === "string") push(action.default_icon);
    else if (action.default_icon)
      Object.values(action.default_icon as Record<string, unknown>).forEach(push);
  }
  const bg = m.background as Record<string, unknown> | undefined;
  if (bg) {
    push(bg.service_worker);
    push(bg.page);
    if (Array.isArray(bg.scripts)) bg.scripts.forEach(push);
  }
  if (m.icons) Object.values(m.icons as Record<string, unknown>).forEach(push);
  const cs = m.content_scripts as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(cs)) {
    for (const c of cs) {
      if (Array.isArray(c.js)) c.js.forEach(push);
      if (Array.isArray(c.css)) c.css.forEach(push);
    }
  }
  push(m.options_page);
  const oui = m.options_ui as Record<string, unknown> | undefined;
  if (oui) push(oui.page);
  const sp = m.side_panel as Record<string, unknown> | undefined;
  if (sp) push(sp.default_path);
  const sa = m.sidebar_action as Record<string, unknown> | undefined;
  if (sa) push(sa.default_panel);
  const cuo = m.chrome_url_overrides as Record<string, unknown> | undefined;
  if (cuo) Object.values(cuo).forEach(push);
  return refs;
}

function fileResolvesSomewhere(ref: string, roots: string[]): boolean {
  if (!ref || ref.includes("*") || /^(https?:|data:)/i.test(ref)) return true;
  const clean = ref.replace(/^\.?\//, "");
  return roots.some((root) => {
    try {
      return fs.existsSync(path.resolve(root, clean));
    } catch {
      return false;
    }
  });
}

// Locate manifest.json from a project root (root first, then src/).
function findManifest(projectPath: string): string | null {
  for (const rel of ["manifest.json", path.join("src", "manifest.json")]) {
    const candidate = path.resolve(projectPath, rel);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  browserSupport: Record<string, { supported: boolean; issues: string[] }>;
  similarTemplates: Array<{ slug: string; surfaces: string[] }>;
}

// chrome.<ns> / browser.<ns> namespaces that need a manifest permission. Used
// but not declared = likely runtime failure; for HARD_APIS the namespace is
// `undefined` and crashes the context at load (the false-green blocker).
const API_PERMISSION: Record<string, string> = {
  storage: "storage", webNavigation: "webNavigation", history: "history",
  cookies: "cookies", bookmarks: "bookmarks", alarms: "alarms",
  contextMenus: "contextMenus", notifications: "notifications",
  downloads: "downloads", webRequest: "webRequest", tabGroups: "tabGroups",
  topSites: "topSites", idle: "idle", management: "management",
  scripting: "scripting", declarativeNetRequest: "declarativeNetRequest",
  sessions: "sessions", proxy: "proxy", tts: "tts", pageCapture: "pageCapture",
  desktopCapture: "desktopCapture", debugger: "debugger", geolocation: "geolocation",
};
const HARD_APIS = new Set([
  "history", "cookies", "bookmarks", "webNavigation", "downloads",
  "webRequest", "topSites", "management", "tabGroups", "sessions", "proxy",
  "debugger", "pageCapture", "desktopCapture",
]);

// Bounded scan of the project source for permission-gated API usage.
function scanApiUsage(roots: string[]): Set<string> {
  const used = new Set<string>();
  let filesRead = 0;
  const walk = (dir: string, depth: number): void => {
    if (depth > 6 || filesRead > 300) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name === "node_modules" || e.name === "dist" || e.name.startsWith("."))
        continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(full, depth + 1);
        continue;
      }
      if (!/\.(js|mjs|cjs|ts|tsx|jsx|svelte|vue)$/.test(e.name)) continue;
      if (filesRead++ > 300) return;
      let src: string;
      try {
        src = fs.readFileSync(full, "utf8");
      } catch {
        continue;
      }
      const re = /\b(?:chrome|browser)\.(\w+)/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(src))) {
        if (API_PERMISSION[m[1]]) used.add(m[1]);
      }
    }
  };
  for (const root of new Set(roots)) walk(root, 0);
  return used;
}

export async function handler(args: {
  manifestPath?: string;
  projectPath?: string;
  browser?: string;
  browsers?: string[];
}): Promise<string> {
  // Accept singular `browser` (every sibling tool uses it) as an alias for the
  // `browsers` array.
  if (!args.browsers && typeof (args as { browser?: string }).browser === "string") {
    args = { ...args, browsers: [(args as { browser: string }).browser] };
  }
  const browsers = args.browsers ?? ["chrome", "firefox"];
  const result: ValidationResult = {
    valid: true,
    errors: [],
    warnings: [],
    browserSupport: {},
    similarTemplates: [],
  };

  const manifestPath =
    args.manifestPath ??
    (args.projectPath ? findManifest(args.projectPath) : null);
  if (!manifestPath) {
    return JSON.stringify({
      valid: false,
      errors: [
        args.projectPath
          ? `No manifest.json found under ${args.projectPath} (looked in the root and src/).`
          : "Pass manifestPath (path to manifest.json) or projectPath (project root).",
      ],
      warnings: [],
      browserSupport: {},
      similarTemplates: [],
    });
  }
  const manifestDir = path.dirname(path.resolve(manifestPath));

  let manifest: Record<string, unknown>;
  try {
    const raw = fs.readFileSync(path.resolve(manifestPath), "utf8");
    manifest = JSON.parse(raw);
  } catch (err) {
    return JSON.stringify({
      valid: false,
      errors: [
        `Cannot read manifest: ${err instanceof Error ? err.message : err}`,
      ],
      warnings: [],
      browserSupport: {},
      similarTemplates: [],
    });
  }

  if (!manifest.name) {
    result.errors.push("Missing required field: name");
  }
  if (!manifest.version) {
    result.warnings.push(
      "Missing field: version (required for store submission)",
    );
  }

  const chromiumManifest = filterKeysForThisBrowser(manifest, "chrome");

  // Probe path-valued fields against disk so a manifest pointing at a missing
  // popup/script/icon no longer gets a clean bill of health. Reported as
  // warnings (Extension.js resolves from source roots we don't fully model).
  const roots = [
    manifestDir,
    path.join(manifestDir, "src"),
    ...(path.basename(manifestDir) === "src"
      ? [path.dirname(manifestDir)]
      : []),
  ];
  for (const ref of new Set(collectPathRefs(chromiumManifest))) {
    if (!fileResolvesSomewhere(ref, roots)) {
      result.warnings.push(
        `Referenced file "${ref}" was not found near the manifest — this is the kind of dangling reference extension_build fails on. Verify with extension_build.`,
      );
    }
  }

  // Code-vs-permission coherence: scan the source for permission-gated
  // chrome.*/browser.* usage and flag anything the manifest doesn't declare. A
  // HARD-gated API used without its permission is undefined at runtime and
  // crashes the context — the exact false-green case where validate said valid.
  const declaredPermSet = new Set<string>(
    [
      ...((chromiumManifest.permissions as string[] | undefined) ?? []),
      ...((chromiumManifest.optional_permissions as string[] | undefined) ?? []),
    ].filter((p) => typeof p === "string"),
  );
  for (const api of scanApiUsage(roots)) {
    const perm = API_PERMISSION[api];
    if (declaredPermSet.has(perm)) continue;
    const base = `Code calls chrome.${api} but "${perm}" is not in permissions`;
    if (HARD_APIS.has(api)) {
      result.errors.push(
        `${base} — chrome.${api} is undefined without it and will crash the context at runtime.`,
      );
    } else {
      result.warnings.push(
        `${base}; it may be undefined at runtime — add "${perm}" if you use it.`,
      );
    }
  }

  if (!chromiumManifest.manifest_version) {
    result.errors.push(
      'Missing manifest_version. Use "chromium:manifest_version": 3 and "firefox:manifest_version": 2 for cross-browser support.',
    );
  }

  // Flag permission strings that aren't recognized API permissions (likely
  // typos). Host/match patterns belong in host_permissions and are skipped
  // here; unknown-but-plausible values warn rather than error, since the API
  // surface grows over time.
  const declaredPerms = [
    ...((chromiumManifest.permissions as string[] | undefined) ?? []),
    ...((chromiumManifest.optional_permissions as string[] | undefined) ?? []),
  ].filter((p) => typeof p === "string");
  for (const perm of declaredPerms) {
    if (perm.includes("://") || perm.includes("*") || perm === "<all_urls>") {
      continue; // host/match pattern, not an API permission
    }
    if (!KNOWN_PERMISSIONS.has(perm)) {
      result.warnings.push(
        `Unrecognized permission "${perm}" — check for a typo (host/match patterns belong in host_permissions, not permissions).`,
      );
    }
  }

  for (const browser of browsers) {
    const isChromium = isChromiumFamily(browser);
    const isFirefox = isGeckoFamily(browser);
    const effective = filterKeysForThisBrowser(manifest, browser);
    const issues: string[] = [];

    if (isChromium) {
      const mv = effective.manifest_version as number;

      if (mv && mv < 3) {
        issues.push(
          "Manifest V2 is deprecated on Chromium. Use chromium:manifest_version: 3.",
        );
      }

      if (effective.side_panel) {
        const perms = (effective.permissions ?? []) as string[];

        if (!perms.includes("sidePanel")) {
          issues.push(
            'Side panel declared but "sidePanel" permission is missing.',
          );
        }
      }
      if (manifest["firefox:browser_action"] && !effective.action) {
        issues.push(
          'Firefox browser_action found but no chromium:action. Chromium MV3 uses "action" instead of "browser_action".',
        );
      }
    }

    if (isFirefox) {
      const contentScripts = effective.content_scripts as
        | Array<Record<string, unknown>>
        | undefined;

      if (contentScripts) {
        for (const cs of contentScripts) {
          if (cs.world === "MAIN" || cs["world"] === "MAIN") {
            issues.push(
              'content_scripts.world: "MAIN" is Chromium-only. Use "chromium:world": "MAIN" and provide a Firefox fallback.',
            );
          }
        }
      }
      if (chromiumManifest.side_panel && !effective.sidebar_action) {
        issues.push(
          "Chromium side_panel declared but no firefox:sidebar_action. Firefox uses sidebar_action for sidebars.",
        );
      }

      const bg = effective.background as Record<string, unknown> | undefined;

      if (bg) {
        if (bg.service_worker && !bg.scripts) {
          issues.push(
            'Background service_worker declared but no firefox:scripts. Firefox uses "scripts" (array) instead of "service_worker".',
          );
        }
      }
    }

    result.browserSupport[browser] = {
      supported: issues.length === 0,
      issues,
    };

    if (issues.length) {
      result.valid = false;
    }
  }

  const surfaces: string[] = [];
  if (chromiumManifest.content_scripts) surfaces.push("content");
  if (chromiumManifest.side_panel) surfaces.push("sidebar");
  if (chromiumManifest.action || manifest["firefox:browser_action"])
    surfaces.push("action");
  if ((chromiumManifest.chrome_url_overrides as Record<string, unknown>)?.newtab)
    surfaces.push("newtab");
  if (chromiumManifest.background) surfaces.push("background");

  // "background" is present in almost every template, so matching on it makes
  // every manifest look similar to the same alphabetical first five. Rank by
  // how many DISTINCTIVE surfaces overlap (content/sidebar/action/newtab) and
  // only fall back to background when nothing distinctive is declared.
  const distinctive = surfaces.filter((s) => s !== "background");
  const matchOn = distinctive.length ? distinctive : surfaces;
  if (matchOn.length) {
    try {
      const templates = await listTemplates();
      result.similarTemplates = templates
        .map((t) => ({
          slug: t.slug,
          surfaces: t.surfaces,
          score: t.surfaces.filter((s) => matchOn.includes(s)).length,
        }))
        .filter((t) => t.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 5)
        .map((t) => ({ slug: t.slug, surfaces: t.surfaces }));
    } catch {
    }
  }

  // Errors must make the headline honest: valid only when there are no errors
  // AND every target is supported (previously errors could coexist with valid).
  result.valid =
    result.errors.length === 0 &&
    Object.values(result.browserSupport).every((b) => b.supported);

  return JSON.stringify({
    ...result,
    buildBlocking: result.errors.length > 0,
  });
}
