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

function readText(distPath: string, rel: string): string | null {
  try {
    return fs.readFileSync(path.join(distPath, rel), "utf8");
  } catch {
    return null;
  }
}

/* @invariant THE SCAN SAYS WHAT IT DID NOT READ. An unreadable script used
   to read as "" and a permission used only there was reported unused with
   the fix "Remove ..."; scripts past the byte cap were silently skipped
  . */
export interface ReviewReport {
  risks: ReviewRisk[];
  unreadable: string[];
  notScanned: string[];
  manifestUnreadable?: string;
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
export function reviewRisks(input: Parameters<typeof reviewRisksReport>[0]): ReviewRisk[] {
  return reviewRisksReport(input).risks;
}

export function reviewRisksReport(input: {
  distPath: string;
  browser: string;
  manifest: Record<string, unknown>;
  files: Array<{ path: string; type?: string }>;
  development?: boolean;
}): ReviewReport {
  const risks: ReviewRisk[] = [];
  const unreadable: string[] = [];
  const notScanned: string[] = [];
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
    if (scanned >= MAX_SCAN_BYTES) {
      notScanned.push(file.path);
      continue;
    }
    const text = readText(input.distPath, file.path);
    if (text === null) {
      unreadable.push(file.path);
      continue;
    }
    scanned += text.length;
    source += `\n${text}`;
    for (const [label, pattern] of REMOTE_CODE_PATTERNS) {
      if (pattern.test(text)) note(label, file.path);
    }
  }
  for (const file of pages) {
    const html = readText(input.distPath, file.path);
    if (html === null) {
      unreadable.push(file.path);
      continue;
    }
    if (REMOTE_SCRIPT_TAG.test(html)) {
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
        message: "The Firefox manifest has no browser_specific_settings.gecko.data_collection_permissions. AMO requires it for new add-ons and for updates of existing ones, and the platform's own Firefox preflight repeats the warning on every submission.",
        fix: 'Add "browser_specific_settings": { "gecko": { "data_collection_permissions": { "required": ["none"] } } }, or list what the extension does collect.',
      });
    }
  }

  const complete = unreadable.length === 0 && notScanned.length === 0;
  if (source && complete && !development) {
    const unused = strings(input.manifest.permissions).filter((perm) => {
      const apis = API_PERMISSIONS[perm];
      if (!apis) return false;
      if (MANIFEST_KEY_USES[perm]?.(input.manifest)) return false;
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

  return { risks, unreadable, notScanned };
}

export function reviewCoverageNotes(report: ReviewReport): string[] {
  const notes: string[] = [];
  if (report.manifestUnreadable) {
    notes.push(`Store review scan skipped: the built manifest could not be parsed (${report.manifestUnreadable}).`);
  }
  if (report.unreadable.length) {
    notes.push(
      `Store review scan could not read ${report.unreadable.length} shipped file${report.unreadable.length === 1 ? "" : "s"} (${report.unreadable.slice(0, 5).join(", ")}${report.unreadable.length > 5 ? ", ..." : ""}), so remote-code and unused-permission findings are incomplete and no permission is reported unused.`,
    );
  }
  if (report.notScanned.length) {
    notes.push(
      `Store review scan stopped at ${MAX_SCAN_BYTES / (1024 * 1024)} MB of script; ${report.notScanned.length} script${report.notScanned.length === 1 ? " was" : "s were"} not scanned for remote code (${report.notScanned.slice(0, 5).join(", ")}${report.notScanned.length > 5 ? ", ..." : ""}) and no permission is reported unused.`,
    );
  }
  return notes;
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
  return files.some((f) => /hot-update\./.test(f.path) || /(^|\/)extension-js(-devtools)?\//.test(f.path));
}

/* @invariant A SOURCE MAP IS NOT A DEV BUILD. A production build with
   sourcemaps used to switch the code checks off and read clean; the dev signal is the hot-update runtime or the engine's own
   companion files, which only a dev session writes into dist. */
export function hasSourceMaps(files: Array<{ path: string }>): boolean {
  return files.some((f) => f.path.endsWith(".map"));
}

const MANIFEST_KEY_USES: Record<string, (manifest: Record<string, unknown>) => boolean> = {
  sidePanel: (m) => m.side_panel != null,
  declarativeNetRequest: (m) => Array.isArray((m.declarative_net_request as { rule_resources?: unknown } | undefined)?.rule_resources),
  declarativeNetRequestWithHostAccess: (m) => Array.isArray((m.declarative_net_request as { rule_resources?: unknown } | undefined)?.rule_resources),
};

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
  return reviewDistReport(distPath, browser).risks;
}

export function reviewDistReport(distPath: string, browser: string): ReviewReport {
  let manifest: Record<string, unknown>;
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(distPath, "manifest.json"), "utf8"));
  } catch (err) {
    return {
      risks: [],
      unreadable: [],
      notScanned: [],
      manifestUnreadable: err instanceof Error ? err.message : String(err),
    };
  }
  return reviewRisksReport({ distPath, browser, manifest, files: listFiles(distPath) });
}
