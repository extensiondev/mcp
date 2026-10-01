// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import fs from "node:fs";
import path from "node:path";
import { filterKeysForThisBrowser } from "browser-extension-manifest-fields";
import { isChromiumFamily, isGeckoFamily } from "../lib/browser-family";
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
      Object.values(pa.default_icon as Record<string, unknown>).forEach(push);
  }
  return refs;
}

/* @invariant A web-accessible resource the manifest names and the tree lacks
   is a runtime 404, not a build failure: the engine builds it and its
   runtime-risk scan reports it, so it is a warning here, where a blocking
   error would refuse a build the engine runs (ledger entry 22). */
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

function scanApiUsage(roots: string[], excluded: string[] = []): Set<string> {
  const used = new Set<string>();
  const skip = new Set(excluded.map((d) => path.resolve(d)));
  let filesRead = 0;
  const walk = (dir: string, depth: number): void => {
    if (depth > 6 || filesRead > 300) return;
    if (skip.has(path.resolve(dir))) return;
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
  if (!args.browsers && typeof (args as { browser?: string }).browser === "string") {
    args = { ...args, browsers: [(args as { browser: string }).browser] };
  }
  const explicitBrowsers = Array.isArray(args.browsers) && args.browsers.length > 0;
  const browsers = args.browsers ?? ["chrome", "firefox", "edge"];
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
    result.warnings.push(
      "Missing field: version (required for store submission)",
    );
  }

  const chromiumManifest = filterKeysForThisBrowser(manifest, "chrome");

  /* @invariant The engine serves public/ at the dist root, so an icon the
     manifest names as images/icon.png may live at public/images/icon.png and
     build fine; a check that never looked there called shipped icons dangling
     (ledger entry 22). */
  const projectRoot =
    path.basename(manifestDir) === "src" ? path.dirname(manifestDir) : manifestDir;
  const roots = [
    manifestDir,
    path.join(manifestDir, "src"),
    ...(projectRoot !== manifestDir ? [projectRoot] : []),
    path.join(manifestDir, "public"),
    path.join(projectRoot, "public"),
  ];
  for (const ref of new Set(collectPathRefs(chromiumManifest))) {
    if (!fileResolvesSomewhere(ref, roots)) {
      result.errors.push(
        `Referenced file "${ref}" was not found near the manifest. extension_build fails on this dangling reference.`,
      );
    }
  }
  for (const ref of new Set(collectWebAccessibleRefs(chromiumManifest))) {
    if (!fileResolvesSomewhere(ref, roots)) {
      result.warnings.push(
        `web_accessible_resources names "${ref}", which was not found near the manifest. The build ships without it and the browser answers 404 when the extension or a page asks for it.`,
      );
    }
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

  const effectiveByBrowser = new Map<string, Record<string, unknown>>();
  for (const b of browsers) {
    effectiveByBrowser.set(b, filterKeysForThisBrowser(manifest, b));
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
  const usedApis = scanApiUsage(
    roots,
    roots.map((r) => path.join(r, "extensions")),
  );
  for (const api of usedApis) {
    const perm = API_PERMISSION[api];
    if (declaredPermSet.has(perm)) continue;
    const base = `Code calls chrome.${api} but "${perm}" is not in permissions`;
    if (HARD_APIS.has(api)) {
      result.errors.push(
        `${base}, chrome.${api} is undefined without it and will crash the context at runtime.`,
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
      effectiveByBrowser.get(browser) ?? filterKeysForThisBrowser(manifest, browser);
    const issues: string[] = [];

    if (isFirefox && (effective.manifest_version as number) === 2) {
      const porting: string[] = [];
      const bg2 = effective.background as Record<string, unknown> | undefined;
      if (bg2 && Array.isArray(bg2.scripts))
        porting.push("background.scripts to a single chromium:service_worker");
      if (effective.browser_action)
        porting.push("browser_action to chromium:action");
      if (
        Array.isArray(effective.web_accessible_resources) &&
        effective.web_accessible_resources.some((e) => typeof e === "string")
      )
        porting.push("web_accessible_resources strings to [{resources, matches}] objects");
      const perms2 = (effective.permissions as string[] | undefined) ?? [];
      if (perms2.some((p) => typeof p === "string" && (p.includes("://") || p === "<all_urls>")))
        porting.push("host patterns out of permissions into host_permissions");
      if (perms2.includes("webRequestBlocking"))
        porting.push("webRequestBlocking to declarativeNetRequest rules");
      if (porting.length) {
        result.warnings.push(
          `${browser} stays on Manifest V2 here, and Firefox still runs it. To also target Chromium, which only loads MV3, the keys to port are: ${porting.join("; ")}. Keep both by prefixing the Chromium variants with chromium:.`,
        );
      }
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
        issues.push(
          'Firefox browser_action found but no chromium:action. Chromium MV3 uses "action" instead of "browser_action".',
        );
      }

      if (browser === "edge") {
        for (const key of CHROME_DESKTOP_ONLY_KEYS) {
          if (effective[key] !== undefined) {
            result.warnings.push(
              `Manifest key "${key}" works on Chrome but is inert on Edge (it is a Chrome-only surface). The edge build ships it as a no-op; move it under "chromium:${key}" only if you also target Chrome, or remove it.`,
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
      if (chromiumManifest.side_panel && !effective.sidebar_action) {
        result.warnings.push(
          "Chromium side_panel declared but no firefox:sidebar_action: the Firefox build ships without a sidebar. If you want one there, Firefox uses sidebar_action.",
        );
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
      for (const key of CHROMIUM_ONLY_KEYS) {
        if (effective[key] !== undefined) {
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
          issues.push(
            'Background service_worker declared but no firefox:scripts. Firefox uses "scripts" (array) instead of "service_worker".',
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
    surfaces.push("sidebar");
  if (chromiumManifest.action || manifest["firefox:browser_action"])
    surfaces.push("action");
  if ((chromiumManifest.chrome_url_overrides as Record<string, unknown>)?.newtab)
    surfaces.push("newtab");
  if (chromiumManifest.devtools_page) surfaces.push("devtools");
  if (chromiumManifest.options_ui || chromiumManifest.options_page)
    surfaces.push("options");
  if (chromiumManifest.background) surfaces.push("background");

  const distinctive = surfaces.filter((s) => s !== "background");
  const matchOn = distinctive.length ? distinctive : surfaces;
  if (matchOn.length) {
    try {
      const templates = await listTemplates();
      /* @invariant Overlap alone ranked four-surface AI chat templates beside
         a one-surface devtools template for a devtools extension, since each
         shared one surface (ledger entry 17). The ratio of shared surfaces to
         the union rewards the template that is about the same thing. */
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
