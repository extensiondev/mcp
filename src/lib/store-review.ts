// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import fs from "node:fs";
import path from "node:path";
import { isGeckoFamily } from "./browser-family";

export type ReviewRiskCode =
  | "BROAD_HOST_ACCESS"
  | "REMOTE_CODE"
  | "FIREFOX_DATA_COLLECTION_MISSING"
  | "UNUSED_PERMISSION";

export interface ReviewRisk {
  code: ReviewRiskCode;
  message: string;
  fix: string;
  files?: string[];
  permissions?: string[];
}

const BROAD_PATTERNS = new Set([
  "<all_urls>",
  "*://*/*",
  "http://*/*",
  "https://*/*",
  "*://*/",
]);

const API_PERMISSIONS: Record<string, string[]> = {
  alarms: ["alarms"],
  bookmarks: ["bookmarks"],
  contextMenus: ["contextMenus", "menus"],
  menus: ["menus", "contextMenus"],
  cookies: ["cookies"],
  declarativeNetRequest: ["declarativeNetRequest"],
  downloads: ["downloads"],
  history: ["history"],
  identity: ["identity"],
  idle: ["idle"],
  management: ["management"],
  notifications: ["notifications"],
  offscreen: ["offscreen"],
  scripting: ["scripting"],
  sidePanel: ["sidePanel"],
  storage: ["storage"],
  tabGroups: ["tabGroups"],
  tabs: ["tabs"],
  topSites: ["topSites"],
  tts: ["tts"],
  webNavigation: ["webNavigation"],
  webRequest: ["webRequest"],
};

const REMOTE_CODE_PATTERNS: Array<[string, RegExp]> = [
  ["eval()", /\beval\s*\(/],
  ["new Function()", /\bnew\s+Function\s*\(/],
  ["importScripts from a URL", /importScripts\(\s*["'`]https?:/],
  ["import() from a URL", /\bimport\(\s*["'`]https?:/],
];

const REMOTE_SCRIPT_TAG = /<script[^>]+src\s*=\s*["']https?:/i;

const MAX_SCAN_BYTES = 8 * 1024 * 1024;

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function hostPatterns(manifest: Record<string, unknown>): string[] {
  const found = new Set<string>();
  for (const pattern of strings(manifest.host_permissions)) found.add(pattern);
  for (const perm of strings(manifest.permissions)) {
    if (perm.includes("://") || perm === "<all_urls>") found.add(perm);
  }
  const scripts = Array.isArray(manifest.content_scripts) ? manifest.content_scripts : [];
  for (const entry of scripts) {
    for (const match of strings((entry as Record<string, unknown>)?.matches)) found.add(match);
  }
  return [...found];
}

function readText(distPath: string, rel: string): string {
  try {
    return fs.readFileSync(path.join(distPath, rel), "utf8");
  } catch {
    return "";
  }
}

/* @invariant
 * THESE ARE THE THINGS A STORE REVIEWER REJECTS OR QUESTIONS, READ OFF THE
 * BUILT PACKAGE, AND THEY NEVER BLOCK A BUILD.
 *
 * Each finding names what a reviewer will see and the one change that removes
 * it. They are warnings because each has a legitimate use a scan cannot see:
 * a password manager needs every site, a bundled library can carry an eval it
 * never calls, and an API can be reached through a wrapper this scan does not
 * follow. The scan reads only the built files, never the network, and stops at
 * MAX_SCAN_BYTES of script so a huge bundle cannot stall the build result.
 */
export function reviewRisks(input: {
  distPath: string;
  browser: string;
  manifest: Record<string, unknown>;
  files: Array<{ path: string; type?: string }>;
  development?: boolean;
}): ReviewRisk[] {
  const risks: ReviewRisk[] = [];
  const development = input.development ?? isDevelopmentBuild(input.files);

  const broad = hostPatterns(input.manifest).filter((p) => BROAD_PATTERNS.has(p));
  if (broad.length) {
    risks.push({
      code: "BROAD_HOST_ACCESS",
      message: `The extension asks for access to every website (${broad.join(", ")}). Chrome Web Store and AMO reviewers ask why, and the review takes longer.`,
      fix: "List only the sites the extension works on, or use activeTab so access is granted per click; if every site is the point, say why in the listing.",
      permissions: broad,
    });
  }

  const scripts = input.files.filter((f) => /\.(m?js|cjs)$/.test(f.path) && !f.path.endsWith(".map"));
  const pages = input.files.filter((f) => /\.html?$/.test(f.path));
  const hits = new Map<string, Set<string>>();
  const note = (label: string, file: string) => {
    if (!hits.has(label)) hits.set(label, new Set());
    hits.get(label)!.add(file);
  };
  let scanned = 0;
  let source = "";
  for (const file of scripts) {
    if (scanned >= MAX_SCAN_BYTES) break;
    const text = readText(input.distPath, file.path);
    scanned += text.length;
    source += `\n${text}`;
    for (const [label, pattern] of REMOTE_CODE_PATTERNS) {
      if (pattern.test(text)) note(label, file.path);
    }
  }
  for (const file of pages) {
    if (REMOTE_SCRIPT_TAG.test(readText(input.distPath, file.path))) {
      note("a <script> loaded from a URL", file.path);
    }
  }
  if (hits.size && !development) {
    const labels = [...hits.keys()];
    risks.push({
      code: "REMOTE_CODE",
      message: `The package contains ${labels.join(", ")}. Manifest V3 stores reject extensions that run code they did not ship, and reviewers flag these patterns even inside a bundled library.`,
      fix: "Remove the call, or confirm it only ever runs code that ships in the package and be ready to say so in review.",
      files: [...new Set([...hits.values()].flatMap((set) => [...set]))].slice(0, 10),
    });
  }

  if (isGeckoFamily(input.browser)) {
    const gecko = (input.manifest.browser_specific_settings as Record<string, unknown> | undefined)
      ?.gecko as Record<string, unknown> | undefined;
    if (!gecko || !("data_collection_permissions" in gecko)) {
      risks.push({
        code: "FIREFOX_DATA_COLLECTION_MISSING",
        message: "The Firefox manifest has no browser_specific_settings.gecko.data_collection_permissions. AMO requires it for new add-ons and for updates.",
        fix: 'Add "browser_specific_settings": { "gecko": { "data_collection_permissions": { "required": ["none"] } } }, or list what the extension does collect.',
      });
    }
  }

  if (source && scanned < MAX_SCAN_BYTES && !development) {
    const unused = strings(input.manifest.permissions).filter((perm) => {
      const apis = API_PERMISSIONS[perm];
      if (!apis) return false;
      return !apis.some((api) => new RegExp(`\\.${api}\\b`).test(source));
    });
    if (unused.length) {
      risks.push({
        code: "UNUSED_PERMISSION",
        message: `The manifest asks for ${unused.join(", ")}, but no shipped script uses ${unused.length === 1 ? "that API" : "those APIs"}. Reviewers reject permissions an extension does not need.`,
        fix: `Remove ${unused.join(", ")} from permissions, or keep ${unused.length === 1 ? "it" : "them"} if the call happens in code this scan cannot see.`,
        permissions: unused,
      });
    }
  }

  return risks;
}

/* @invariant
 * A DEV BUILD IS NOT WHAT A STORE RECEIVES, SO ITS CODE IS NOT JUDGED.
 *
 * Measured 2026-10-05 on seven published extensions' dev dists: every one
 * tripped eval() or new Function() from the hot-reload runtime and most showed
 * a `management` permission the dev session injects, while a production build
 * of an official template tripped neither. So on a dev build the code checks
 * are skipped and only the manifest checks (host access, Firefox data
 * collection) still run.
 */
export function isDevelopmentBuild(files: Array<{ path: string }>): boolean {
  return files.some((f) => f.path.endsWith(".map") || /hot-update\./.test(f.path));
}

export function reviewRiskWarnings(risks: ReviewRisk[]): string[] {
  return risks.map((risk) => `Store review: ${risk.message} ${risk.fix}`);
}

function listFiles(dir: string, base = ""): Array<{ path: string }> {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: Array<{ path: string }> = [];
  for (const entry of entries) {
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...listFiles(path.join(dir, entry.name), rel));
    else out.push({ path: rel });
  }
  return out;
}

export function reviewDist(distPath: string, browser: string): ReviewRisk[] {
  let manifest: Record<string, unknown>;
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(distPath, "manifest.json"), "utf8"));
  } catch {
    return [];
  }
  return reviewRisks({ distPath, browser, manifest, files: listFiles(distPath) });
}
