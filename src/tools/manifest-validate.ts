// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import fs from "node:fs";
import path from "node:path";

import { engineManifestView } from "../lib/engine-manifest-view";
import { CHROMIUM_FAMILY, GECKO_FAMILY, WEBKIT_FAMILY, isChromiumFamily, isGeckoFamily } from "../lib/browser-family";
import { listTemplates } from "../lib/templates-cache";
import { envelope } from "../lib/envelope";

const COMMAND = "extension_manifest_validate";

const CHROMIUM_ONLY_KEYS = [
  "version_name",
  "minimum_chrome_version",
  "key",
  "update_url",
  "offline_enabled",
  "side_panel",
  "declarative_net_request",
  "cross_origin_embedder_policy",
  "cross_origin_opener_policy",
];

const CHROME_DESKTOP_ONLY_KEYS = [
  "file_browser_handlers",
  "file_system_provider_capabilities",
  "input_components",
  "chrome_os_system_extension",
];

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
  "browserSettings", "captivePortal", "contextualIdentities", "dns",
  "menus", "menus.overrideContext", "pkcs11", "theme", "webRequestFilterResponse",
]);

export const schema = {
  name: "extension_manifest_validate",
  description:
    "Validate a manifest.json across browsers. This reports missing fields, invalid permissions, dangling file references, and cross-browser compatibility issues. Read buildBlocking for the errors that make extension_build refuse.",
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
        default: ["chrome", "firefox", "edge"],
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
      {Object.values(action.default_icon as Record<string, unknown>).forEach(push);}
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

  const dnr = m.declarative_net_request as Record<string, unknown> | undefined;

  if (dnr && Array.isArray(dnr.rule_resources)) {
    for (const r of dnr.rule_resources) {
      if (r && typeof r === "object") push((r as Record<string, unknown>).path);
    }
  }

  const storage = m.storage as Record<string, unknown> | undefined;
  if (storage) push(storage.managed_schema);

  push(m.devtools_page);
  const pa = m.page_action as Record<string, unknown> | undefined;

  if (pa) {
    push(pa.default_popup);

    if (typeof pa.default_icon === "string") push(pa.default_icon);
    else if (pa.default_icon)
      {Object.values(pa.default_icon as Record<string, unknown>).forEach(push);}
  }

  return refs;
}

function collectWebAccessibleRefs(m: Record<string, unknown>): string[] {
  const refs: string[] = [];
  const war = m.web_accessible_resources;
  if (!Array.isArray(war)) return refs;

  for (const entry of war) {
    if (typeof entry === "string") refs.push(entry);
    else if (entry && typeof entry === "object") {
      const resources = (entry as Record<string, unknown>).resources;

      if (Array.isArray(resources)) {
        for (const r of resources) if (typeof r === "string") refs.push(r);
      }
    }
  }

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

const SCAN_FILE_CAP = 300;

function scanApiUsage(
  roots: string[],
  excluded: string[] = [],
): { used: Set<string>; filesRead: number; capped: boolean; unreadable: string[] } {
  const used = new Set<string>();
  const unreadable: string[] = [];
  const skip = new Set(excluded.map((d) => path.resolve(d)));
  const seen = new Set<string>();
  let filesRead = 0;
  let capped = false;

  const walk = (dir: string, depth: number): void => {
    if (depth > 6 || capped) return;
    if (skip.has(path.resolve(dir))) return;

    let entries: fs.Dirent[];

    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    const files = entries.filter((e) => !e.isDirectory() && /\.(js|mjs|cjs|ts|tsx|jsx|svelte|vue)$/.test(e.name));
    const dirs = entries
      .filter((e) => e.isDirectory() && e.name !== "node_modules" && e.name !== "dist" && !e.name.startsWith("."))
      .sort((a, b) => (a.name === "src" ? -1 : b.name === "src" ? 1 : a.name.localeCompare(b.name)));

    for (const e of files) {
      const full = path.join(dir, e.name);
      if (seen.has(full)) continue;

      seen.add(full);

      if (filesRead >= SCAN_FILE_CAP) {
        capped = true;

        return;
      }

      filesRead++;
      let src: string;

      try {
        src = fs.readFileSync(full, "utf8");
      } catch {
        unreadable.push(full);
        continue;
      }

      const re = /\b(?:chrome|browser)\.(\w+)/g;
      let m: RegExpExecArray | null;

      while ((m = re.exec(src))) {
        if (API_PERMISSION[m[1]]) used.add(m[1]);
      }
    }

    for (const e of dirs) walk(path.join(dir, e.name), depth + 1);
  };

  for (const root of new Set(roots)) walk(root, 0);

  return { used, filesRead, capped, unreadable };
}

const DEFAULT_BROWSERS = ["chrome", "firefox", "edge"];
const DEFAULT_TARGET = "chrome";
const KNOWN_TARGETS = [...CHROMIUM_FAMILY, ...GECKO_FAMILY, ...WEBKIT_FAMILY];

export async function handler(args: {
  manifestPath?: string;
  projectPath?: string;
  browser?: string;
  browsers?: string[];
}): Promise<string> {
  if (!args.browsers && typeof (args as { browser?: string }).browser === "string") {
    args = { ...args, browsers: [(args as { browser: string }).browser] };
  }

  const explicitBrowsers = Array.isArray(args.browsers) && args.browsers.length > 0;
  const browsers = explicitBrowsers ? (args.browsers as string[]) : DEFAULT_BROWSERS;
  const unknownTargets = browsers.filter((b) => !KNOWN_TARGETS.includes(b));

  if (unknownTargets.length) {
    const errors = unknownTargets.map((b) => {
      const guess = KNOWN_TARGETS.find((k) => k === String(b).toLowerCase());

      return `"${b}" is not a known browser target${guess ? ` (did you mean "${guess}"?)` : ""}. Known targets: ${KNOWN_TARGETS.join(", ")}.`;
    });

    return envelope({
      ok: false,
      command: COMMAND,
      status: "unknown-browser",
      error: { code: "E_BAD_REQUEST", message: errors[0] },
      value: { valid: false, errors, browserSupport: {}, similarTemplates: [] },
      warnings: [],
    });
  }

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
    const errors = [
      args.projectPath
        ? `No manifest.json found under ${args.projectPath} (looked in the root and src/).`
        : "Pass manifestPath (path to manifest.json) or projectPath (project root).",
    ];

    return envelope({
      ok: false,
      command: COMMAND,
      status: "manifest-not-found",
      error: { code: "E_MANIFEST_NOT_FOUND", message: errors[0] },
      value: {
        valid: false,
        errors,
        browserSupport: {},
        similarTemplates: [],
      },
      warnings: [],
    });
  }

  const manifestDir = path.dirname(path.resolve(manifestPath));

  let manifest: Record<string, unknown>;

  try {
    const raw = fs.readFileSync(path.resolve(manifestPath), "utf8");
    manifest = JSON.parse(raw);
  } catch (err) {
    const errors = [
      `Cannot read manifest: ${err instanceof Error ? err.message : err}`,
    ];

    return envelope({
      ok: false,
      command: COMMAND,
      status: "manifest-unreadable",
      error: { code: "E_BAD_MANIFEST", message: errors[0] },
      value: {
        valid: false,
        errors,
        browserSupport: {},
        similarTemplates: [],
      },
      warnings: [],
    });
  }

  if (!manifest.name) {
    result.errors.push("Missing required field: name");
  }

  if (!manifest.version) {
    result.errors.push(
      'Missing field: version. Chrome refuses to load a manifest without it ("Required value \'version\' is missing"), and every store upload needs it.',
    );
  }

  const chromiumManifest = engineManifestView(manifest, "chrome");

  const projectRoot =
    path.basename(manifestDir) === "src" ? path.dirname(manifestDir) : manifestDir;
  const roots = [
    manifestDir,
    path.join(manifestDir, "src"),
    ...(projectRoot !== manifestDir ? [projectRoot] : []),
    path.join(manifestDir, "public"),
    path.join(projectRoot, "public"),
  ];
  const effectiveByBrowser = new Map<string, Record<string, unknown>>();

  for (const b of browsers) {
    effectiveByBrowser.set(b, engineManifestView(manifest, b));
  }

  const missingRefs = new Map<string, string[]>();
  const missingWar = new Map<string, string[]>();

  for (const [b, view] of effectiveByBrowser) {
    for (const ref of new Set(collectPathRefs(view))) {
      if (fileResolvesSomewhere(ref, roots)) continue;

      missingRefs.set(ref, [...(missingRefs.get(ref) ?? []), b]);
    }

    for (const ref of new Set(collectWebAccessibleRefs(view))) {
      if (fileResolvesSomewhere(ref, roots)) continue;

      missingWar.set(ref, [...(missingWar.get(ref) ?? []), b]);
    }
  }

  for (const [ref, where] of missingRefs) {
    result.errors.push(
      `Referenced file "${ref}" was not found near the manifest (${where.join(", ")} view). extension_build fails on this dangling reference.`,
    );
  }

  for (const [ref, where] of missingWar) {
    result.warnings.push(
      `web_accessible_resources names "${ref}", which was not found near the manifest (${where.join(", ")} view). The build ships without it and the browser answers 404 when the extension or a page asks for it.`,
    );
  }

  const defaultLocale = manifest.default_locale;

  if (typeof defaultLocale === "string" && defaultLocale) {
    const hasCatalog = roots.some((root) =>
      fs.existsSync(
        path.resolve(root, "_locales", defaultLocale, "messages.json"),
      ),
    );

    if (!hasCatalog) {
      result.errors.push(
        `default_locale "${defaultLocale}" is declared but _locales/${defaultLocale}/messages.json was not found. The build fails on this; add the catalog or remove default_locale.`,
      );
    }
  }

  const iconMap = chromiumManifest.icons as Record<string, unknown> | undefined;

  if (!iconMap || typeof iconMap["128"] !== "string") {
    result.warnings.push(
      'No 128x128 icon declared ("128" key in icons). The Chrome Web Store requires one for a store listing, and Edge Add-ons expects it too.',
    );
  }

  const declaredPermSet = new Set<string>();

  for (const view of [chromiumManifest, ...effectiveByBrowser.values()]) {
    for (const p of [
      ...((view.permissions as string[] | undefined) ?? []),
      ...((view.optional_permissions as string[] | undefined) ?? []),
    ]) {
      if (typeof p === "string") declaredPermSet.add(p);
    }
  }

  const scan = scanApiUsage(
    roots,
    roots.map((r) => path.join(r, "extensions")),
  );
  const usedApis = scan.used;

  if (scan.capped) {
    result.warnings.push(
      `The permission scan read ${scan.filesRead} source files and stopped at its cap, so files it did not reach were not checked for undeclared chrome.* APIs. Validate a narrower projectPath, or move unrelated code out of the manifest's tree.`,
    );
  }

  if (scan.unreadable.length) {
    result.warnings.push(
      `${scan.unreadable.length} source file${scan.unreadable.length === 1 ? "" : "s"} could not be read and ${scan.unreadable.length === 1 ? "was" : "were"} not scanned for undeclared APIs: ${scan.unreadable.slice(0, 5).map((f) => path.relative(projectRoot, f)).join(", ")}${scan.unreadable.length > 5 ? ", ..." : ""}.`,
    );
  }

  for (const api of usedApis) {
    const perm = API_PERMISSION[api];
    if (declaredPermSet.has(perm)) continue;

    const base = `Code calls chrome.${api} but "${perm}" is not in permissions`;

    if (HARD_APIS.has(api)) {
      result.warnings.push(
        `${base}; chrome.${api} is undefined without it and the call crashes its context at runtime. Found by a text search over the project's source files (comments and strings count), so confirm the call is live before adding "${perm}".`,
      );
    } else {
      result.warnings.push(
        `${base}; it may be undefined at runtime, add "${perm}" if you use it.`,
      );
    }
  }

  if (!chromiumManifest.manifest_version) {
    result.errors.push(
      'Missing manifest_version. Use "chromium:manifest_version": 3 and "firefox:manifest_version": 2 for cross-browser support.',
    );
  } else if (
    chromiumManifest.manifest_version !== 2 &&
    chromiumManifest.manifest_version !== 3
  ) {
    result.errors.push(
      `manifest_version must be 2 or 3, got ${JSON.stringify(chromiumManifest.manifest_version)}. No browser installs this manifest.`,
    );
  }

  const declaredPerms = [
    ...((chromiumManifest.permissions as string[] | undefined) ?? []),
    ...((chromiumManifest.optional_permissions as string[] | undefined) ?? []),
  ].filter((p) => typeof p === "string");

  for (const perm of declaredPerms) {
    if (perm.includes("://") || perm.includes("*") || perm === "<all_urls>") {
      continue;
    }

    if (!KNOWN_PERMISSIONS.has(perm)) {
      result.warnings.push(
        `Unrecognized permission "${perm}", check for a typo (host/match patterns belong in host_permissions, not permissions).`,
      );
    }
  }

  for (const browser of browsers) {
    const isChromium = isChromiumFamily(browser);
    const isFirefox = isGeckoFamily(browser);
    const effective =
      effectiveByBrowser.get(browser) ?? engineManifestView(manifest, browser);
    const issues: string[] = [];

    /* @invariant
     * The Chromium view already resolves chromium: keys at any nesting, so a
     * manifest that ships its own service worker or action is not told to port.
     */
    const chromiumBg = chromiumManifest.background as Record<string, unknown> | undefined;
    const chromiumHasWorker = typeof chromiumBg?.service_worker === "string";
    const firefoxBg = effective.background as Record<string, unknown> | undefined;
    const firefoxScriptsOnly = Array.isArray(firefoxBg?.scripts) && !chromiumHasWorker;

    if (isFirefox && (effective.manifest_version as number) === 2) {
      const porting: string[] = [];

      if (firefoxScriptsOnly)
        {porting.push("background.scripts to a single chromium:service_worker");}

      if (effective.browser_action && !chromiumManifest.action)
        {porting.push("browser_action to chromium:action");}

      if (
        Array.isArray(effective.web_accessible_resources) &&
        effective.web_accessible_resources.some((e) => typeof e === "string")
      )
        {porting.push("web_accessible_resources strings to [{resources, matches}] objects");}

      const perms2 = (effective.permissions as string[] | undefined) ?? [];

      if (perms2.some((p) => typeof p === "string" && (p.includes("://") || p === "<all_urls>")))
        {porting.push("host patterns out of permissions into host_permissions");}

      if (perms2.includes("webRequestBlocking"))
        {porting.push("webRequestBlocking to declarativeNetRequest rules");}

      if (porting.length) {
        result.warnings.push(
          `${browser} stays on Manifest V2 here, and Firefox still runs it. To also target Chromium, which only loads MV3, the keys to port are: ${porting.join("; ")}. Keep both by prefixing the Chromium variants with chromium:.`,
        );
      }
    }

    if (isFirefox && (effective.manifest_version as number) === 3 && firefoxScriptsOnly) {
      result.warnings.push(
        `${browser}: background.scripts is declared and no service worker for Chromium. Firefox MV3 runs it, but Chromium MV3 only runs background.service_worker; to also target Chromium, declare chromium:service_worker next to firefox:scripts.`,
      );
    }

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
        result.warnings.push(
          `${browser}: firefox:browser_action is declared and no action for Chromium, so the ${browser} build ships no toolbar action; Chromium MV3 reads "action" (chromium:action). The build itself is not refused.`,
        );
      }

      if (browser === "edge") {
        for (const key of CHROME_DESKTOP_ONLY_KEYS) {
          if (effective[key] !== undefined) {
            result.warnings.push(
              `Manifest key "${key}" works on Chrome but is inert on Edge (it is a Chrome-only surface). The edge build ships it as a no-op; move it under "chrome:${key}" (the engine applies a chrome: key to Chrome only, while chromium: covers Edge too), or remove it.`,
            );
          }
        }
      }
    }

    if (isFirefox) {
      const contentScripts = effective.content_scripts as
        | Array<Record<string, unknown>>
        | undefined;

      if (contentScripts?.some((cs) => cs.world === "MAIN")) {
        const note =
          'content_scripts.world: "MAIN" needs Firefox 128 or later (earlier Firefox runs the script in the isolated world). If you depend on it, set browser_specific_settings.gecko.strict_min_version to "128.0".';

        if (!result.warnings.includes(note)) {
          result.warnings.push(note);
        }
      }

      const sidePanelPath = (chromiumManifest.side_panel as Record<string, unknown> | undefined)?.default_path;
      const unprefixedSidePanel = typeof (manifest.side_panel as Record<string, unknown> | undefined)?.default_path === "string";

      if (chromiumManifest.side_panel && !effective.sidebar_action) {
        if (unprefixedSidePanel && typeof sidePanelPath === "string") {
          result.warnings.push(
            `${browser}: side_panel is folded into sidebar_action by the engine for Gecko builds, so the ${browser} build ships the sidebar at ${sidePanelPath}. Declare firefox:sidebar_action to shape it yourself, or prefix the key chromium:side_panel to leave Firefox without one.`,
          );
        } else {
          result.warnings.push(
            `${browser}: chromium:side_panel is declared and no firefox:sidebar_action, so the ${browser} build ships without a sidebar. Firefox uses sidebar_action.`,
          );
        }
      }

      const bss = effective.browser_specific_settings as
        | Record<string, unknown>
        | undefined;
      const geckoId = (bss?.gecko as Record<string, unknown> | undefined)?.id;

      if (typeof geckoId !== "string" || !geckoId) {
        result.warnings.push(
          'Firefox: no browser_specific_settings.gecko.id. A temporary add-on without one gets a new internal id on every launch, so storage and the moz-extension:// origin do not survive a relaunch, and a store upload needs the id. Set firefox:browser_specific_settings.gecko.id (any "name@domain" string).',
        );
      }

      const dataCollection = (bss?.gecko as Record<string, unknown> | undefined)
        ?.data_collection_permissions;

      if (!dataCollection || typeof dataCollection !== "object") {
        result.warnings.push(
          'Firefox: no browser_specific_settings.gecko.data_collection_permissions. AMO requires it for new add-ons and the Firefox build warns on every run; the minimal form is firefox:browser_specific_settings.gecko.data_collection_permissions: {"required": ["none"]}.',
        );
      }

      const gecko = bss?.gecko as Record<string, unknown> | undefined;
      const minVersion = gecko?.strict_min_version;
      const minMajor = typeof minVersion === "string" ? Number.parseInt(minVersion, 10) : Number.NaN;
      const androidMin = (bss?.gecko_android as Record<string, unknown> | undefined)?.strict_min_version;
      const androidMajor = typeof androidMin === "string" ? Number.parseInt(androidMin, 10) : Number.NaN;

      /* @invariant
       * Measured with the bundled addons-linter (2026-10-09): no minimum at
       * all draws nothing, a minimum below 140 draws the unsupported-key
       * warning, and 140 or 141 without a gecko_android minimum of 142 draws
       * the Android one.
       */
      if (dataCollection && typeof dataCollection === "object" && Number.isFinite(minMajor)) {
        if (minMajor < 140) {
          result.warnings.push(
            `Firefox: data_collection_permissions is read by Firefox 140 and later, and strict_min_version is "${minVersion}", so AMO's linter reports the key as unsupported. Raise firefox:browser_specific_settings.gecko.strict_min_version to "140.0", or remove it.`,
          );
        } else if (minMajor < 142 && !(androidMajor >= 142)) {
          result.warnings.push(
            `Firefox: strict_min_version "${minVersion}" covers data_collection_permissions on desktop, but Firefox for Android reads it from 142, so AMO's linter warns for Android. Add firefox:browser_specific_settings.gecko_android.strict_min_version "142.0".`,
          );
        }
      }

      for (const key of CHROMIUM_ONLY_KEYS) {
        if (effective[key] !== undefined) {
          if (key === "side_panel" && unprefixedSidePanel) continue;

          result.warnings.push(
            `Firefox: manifest key "${key}" is Chromium-only and is ignored or refused by Firefox. Move it under "chromium:${key}".`,
          );
        }
      }

      const warEntries = effective.web_accessible_resources;

      if (
        Array.isArray(warEntries) &&
        warEntries.some(
          (entry) =>
            entry &&
            typeof entry === "object" &&
            (entry as Record<string, unknown>).extension_ids !== undefined,
        )
      ) {
        result.warnings.push(
          'Firefox: web_accessible_resources[].extension_ids is Chromium-only; Firefox accepts only "matches" there.',
        );
      }

      const bg = effective.background as Record<string, unknown> | undefined;

      if (bg) {
        if (bg.service_worker && !bg.scripts) {
          result.warnings.push(
            `${browser}: background.service_worker is declared and no firefox:background.scripts; the engine rewrites it to scripts: ["${String(bg.service_worker)}"] for Gecko builds, so the build is sound. Declare firefox:background.scripts to shape the Firefox background yourself.`,
          );
        }
      }
    }

    const effectivePerms = new Set<string>(
      [
        ...((effective.permissions as string[] | undefined) ?? []),
        ...((effective.optional_permissions as string[] | undefined) ?? []),
      ].filter((p) => typeof p === "string"),
    );

    for (const api of usedApis) {
      const perm = API_PERMISSION[api];
      if (effectivePerms.has(perm)) continue;

      if (!declaredPermSet.has(perm)) continue;

      const ns = isFirefox ? "browser" : "chrome";
      issues.push(
        `Code calls ${ns}.${api} but the ${browser} build's permissions do not include "${perm}" (it is declared only under another target's prefixed key, e.g. chromium:permissions). An unguarded call crashes this target at runtime. If every call sits behind a feature check (typeof ${ns}.${api} !== "undefined"), the build is sound: pass skipValidation: true to extension_build, or grant "${perm}" to this target too.`,
      );
    }

    if (WEBKIT_FAMILY.has(browser)) {
      result.warnings.push(
        `${browser}: checked as its Chromium source manifest only; Safari-specific rules (the Xcode conversion) are not checked here.`,
      );
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

  if (chromiumManifest.side_panel || manifest["firefox:sidebar_action"])
    {surfaces.push("sidebar");}

  if (chromiumManifest.action || manifest["firefox:browser_action"])
    {surfaces.push("action");}

  if ((chromiumManifest.chrome_url_overrides as Record<string, unknown>)?.newtab)
    {surfaces.push("newtab");}

  if (chromiumManifest.devtools_page) surfaces.push("devtools");

  if (chromiumManifest.options_ui || chromiumManifest.options_page)
    {surfaces.push("options");}

  if (chromiumManifest.background) surfaces.push("background");

  const distinctive = surfaces.filter((s) => s !== "background");
  const matchOn = distinctive.length ? distinctive : surfaces;

  if (matchOn.length) {
    try {
      const templates = await listTemplates();
      result.similarTemplates = templates
        .map((t) => {
          const shared = t.surfaces.filter((s) => matchOn.includes(s)).length;
          const union = new Set([...t.surfaces, ...matchOn]).size;

          return {
            slug: t.slug,
            surfaces: t.surfaces,
            score: union ? shared / union : 0,
          };
        })
        .filter((t) => t.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 5)
        .map((t) => ({ slug: t.slug, surfaces: t.surfaces }));
    } catch {
    }
  }

  for (const [browser, support] of Object.entries(result.browserSupport)) {
    if (support.supported) continue;

    const issues = support.issues?.length
      ? support.issues.join("; ")
      : `${browser} is not supported by this manifest.`;

    if (explicitBrowsers) {
      result.errors.push(`${browser}: ${issues}`);
    } else if (browser === DEFAULT_TARGET) {
      result.errors.push(`${browser} (the default build target): ${issues}`);
    } else {
      result.warnings.push(
        `${browser} (not requested, checked by default): ${issues}`,
      );
    }
  }

  result.valid = result.errors.length === 0;

  return envelope({
    ok: result.valid,
    command: COMMAND,
    status: result.valid ? "valid" : "invalid",
    value: {
      ...result,
      buildBlocking: result.errors.length > 0,
    },
    warnings: result.warnings,
  });
}
