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
import { isDevelopmentBuild } from "./build-type";
import { ENTERPRISE_CHANNEL_SENTENCE, adminInstallOnlyOf } from "./firefox-enterprise";
import { declaredIcon128, readPngSize } from "./store-listing-media";
import { STORE_SECTIONS, SUBSECTION_KEYS } from "./store-md-declarations";
import { STORE_MD_FILENAME } from "./store-md";
import { REVIEWER_NOTE_BUILD_SHAPE, reviewerNoteBuildSentence } from "./store-md-toolchain";
import { CONTENT_SCRIPT_SENTENCE, WASM_GRANT, WASM_POLICY_BLOCK, WASM_POLICY_KEY, needsWasmGrant, remoteWasmIn, wasmPolicyOf } from "./wasm-policy";

export type ReviewRiskCode =
  | "BROAD_HOST_ACCESS"
  | "CSP_UNSAFE_EVAL"
  | "REMOTE_CODE"
  | "WASM_GRANT_MISSING"
  | "FIREFOX_DATA_COLLECTION_MISSING"
  | "FIREFOX_ENTERPRISE_CHANNEL"
  | "ICON_128_MISSING"
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

const REMOTE_WASM_LABEL = "a WebAssembly binary loaded from";

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

const ICON_SKIPPED_FOLDERS = new Set(["node_modules", "dist"]);
const ICON_SEARCH_DEPTH = 5;
const ICON_SEARCH_ENTRIES = 3000;
const ICON_PLACEHOLDER = "icons/icon-128.png";

function isPng128(file: string): boolean {
  const head = Buffer.alloc(24);
  let handle: number | null = null;

  try {
    handle = fs.openSync(file, "r");
    fs.readSync(handle, head, 0, 24, 0);
  } catch {
    return false;
  } finally {
    if (handle !== null) fs.closeSync(handle);
  }

  const size = readPngSize(head);

  return size?.width === 128 && size.height === 128;
}

function png128Under(dir: string): string | null {
  let budget = ICON_SEARCH_ENTRIES;
  const queue: Array<{ dir: string; depth: number }> = [{ dir, depth: 0 }];

  for (let at = 0; at < queue.length; at++) {
    const here = queue[at];
    let entries: fs.Dirent[];

    try {
      entries = fs.readdirSync(here.dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (--budget < 0) return null;

      const file = path.join(here.dir, entry.name);

      if (entry.isDirectory()) {
        if (here.depth < ICON_SEARCH_DEPTH && !entry.name.startsWith(".") && !ICON_SKIPPED_FOLDERS.has(entry.name)) queue.push({ dir: file, depth: here.depth + 1 });
      } else if (entry.isFile() && /\.png$/i.test(entry.name) && isPng128(file)) {
        return path.relative(dir, file).split(path.sep).join("/");
      }
    }
  }

  return null;
}

export function icon128Fix(sourceManifest: string | null | undefined, declared = ""): string {
  if (!sourceManifest) return 'Add a 128x128 PNG to the project, declare it as "icons": { "128": "<path>" } in the manifest and build again.';

  const held = png128Under(path.dirname(sourceManifest));

  if (held) return `${held} under the manifest's folder is 128x128: add "icons": { "128": "${held}" } to the manifest and build again.`;

  return `No 128x128 PNG is under the manifest's folder, and the artwork is the owner's. Until they supply it, save a plain placeholder PNG there as ${declared || ICON_PLACEHOLDER}, ${declared ? "" : `add "icons": { "128": "${ICON_PLACEHOLDER}" } to the manifest, `}build again and tell the owner it is a placeholder to replace before submitting.`;
}

export interface ReviewReport {
  risks: ReviewRisk[];
  unreadable: string[];
  notScanned: string[];
  manifestUnreadable?: string;
  wasmGranted?: boolean;
}

export function reviewRisks(input: Parameters<typeof reviewRisksReport>[0]): ReviewRisk[] {
  return reviewRisksReport(input).risks;
}

export function reviewRisksReport(input: {
  distPath: string;
  browser: string;
  manifest: Record<string, unknown>;
  files: Array<{ path: string; type?: string }>;
  development?: boolean;
  sourceManifest?: string | null;
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

  const icon = declaredIcon128(input.manifest).replace(/^\.?\//, "");

  if (!icon || !fs.existsSync(path.join(input.distPath, icon))) {
    risks.push({
      code: "ICON_128_MISSING",
      message: `${icon ? `The manifest's icons["128"] names ${icon}, which is not in the build` : 'The manifest declares no 128x128 icon ("128" in icons)'}. The Chrome Web Store requires one for a listing, and Edge Add-ons expects it too.`,
      fix: icon128Fix(input.sourceManifest, icon),
    });
  }

  const scripts = input.files.filter((f) => /\.(m?js|cjs)$/.test(f.path) && !f.path.endsWith(".map"));
  const pages = input.files.filter((f) => /\.html?$/.test(f.path));
  const hits = new Map<string, Set<string>>();
  const remoteWasm = new Map<string, string>();

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

    for (const found of remoteWasmIn(text)) {
      remoteWasm.set(found.address, found.option ? `${found.address} (${found.option})` : found.address);
      note(REMOTE_WASM_LABEL, file.path);
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
    const addresses = [...remoteWasm.values()];
    const labels = [...hits.keys()].map((label) =>
      label === REMOTE_WASM_LABEL ? `${label} ${addresses.slice(0, 3).join(", ")}${addresses.length > 3 ? `, and ${addresses.length - 3} more` : ""}` : label,
    );
    const calls = labels.length > (addresses.length ? 1 : 0);
    risks.push({
      code: "REMOTE_CODE",
      message: `The package contains ${labels.join(", ")}. ${addresses.length ? "Stores treat a .wasm fetched from another origin as remotely hosted code. " : ""}Manifest V3 stores reject extensions that run code they did not ship${calls ? ", and reviewers flag these patterns even inside a bundled library" : ""}.`,
      fix: [
        addresses.length ? 'Ship the .wasm in the package and load it by a packaged URL (new URL("<file>.wasm", import.meta.url) or chrome.runtime.getURL).' : "",
        calls ? `Remove the ${addresses.length ? "other " : ""}call, or confirm it only ever runs code that ships in the package and be ready to say so in review.` : "",
      ].filter(Boolean).join(" "),
      files: [...new Set([...hits.values()].flatMap((set) => [...set]))].slice(0, 10),
    });
  }

  const policy = wasmPolicyOf(input.manifest);
  const governed = needsWasmGrant(input.manifest);
  const binaries = input.files.filter((f) => f.path.endsWith(".wasm")).map((f) => f.path);

  if (governed && policy.unsafeEval) {
    risks.push({
      code: "CSP_UNSAFE_EVAL",
      message: `${WASM_POLICY_KEY} carries 'unsafe-eval'. Manifest V3 permits only 'self', 'none' and ${WASM_GRANT} in script-src, and reviewers read it as leave to run code the package did not ship.`,
      fix: `For WebAssembly write ${WASM_GRANT} in its place, the narrow grant that compiles a module and nothing else; otherwise remove it.`,
    });
  } else if (governed && !policy.granted && binaries.length) {
    risks.push({
      code: "WASM_GRANT_MISSING",
      message: `The build ships ${binaries.slice(0, 2).join(" and ")}${binaries.length > 2 ? ` and ${binaries.length - 2} more .wasm` : ""} and the manifest has no ${WASM_GRANT} in ${WASM_POLICY_KEY}, so extension pages and the background service worker or script cannot compile it.`,
      fix: `${policy.policy ? `Add ${WASM_GRANT} to script-src in ${WASM_POLICY_KEY} of the source manifest` : `Add ${WASM_POLICY_BLOCK} to the source manifest`} and build again. ${CONTENT_SCRIPT_SENTENCE}`,
      files: binaries.slice(0, 10),
    });
  }

  if (isGeckoFamily(input.browser)) {
    const gecko = (input.manifest.browser_specific_settings as Record<string, unknown> | undefined)
      ?.gecko as Record<string, unknown> | undefined;

    if (!gecko || !("data_collection_permissions" in gecko)) {
      risks.push({
        code: "FIREFOX_DATA_COLLECTION_MISSING",
        message: "The Firefox manifest has no browser_specific_settings.gecko.data_collection_permissions. AMO requires it for new add-ons and for updates.",
        fix: 'Ask the owner what the extension collects and write "browser_specific_settings": { "gecko": { "data_collection_permissions": ... } } with the categories they state (https://extensionworkshop.com/documentation/develop/firefox-builtin-data-consent/). Do not fill it in for them or suggest a value. This rule is about the declaration alone.',
      });
    }

    if (adminInstallOnlyOf(input.manifest) === true) {
      risks.push({
        code: "FIREFOX_ENTERPRISE_CHANNEL",
        message: `The Firefox manifest's ${ENTERPRISE_CHANNEL_SENTENCE}`,
        fix: "Keep the key only for a version deployed through Firefox enterprise policies; for a listed or unlisted upload, remove it and build again.",
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

  return { risks, unreadable, notScanned, wasmGranted: policy.granted && !policy.unsafeEval };
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

const MANIFEST_KEY_USES: Record<string, (manifest: Record<string, unknown>) => boolean> = {
  sidePanel: (m) => m.side_panel != null,
  declarativeNetRequest: (m) => Array.isArray((m.declarative_net_request as { rule_resources?: unknown } | undefined)?.rule_resources),
  declarativeNetRequestWithHostAccess: (m) => Array.isArray((m.declarative_net_request as { rule_resources?: unknown } | undefined)?.rule_resources),
};

export function reviewRiskWarnings(risks: ReviewRisk[]): string[] {
  return risks.map((risk) => `Store review: ${risk.message} ${risk.fix}`);
}

export function reviewRiskPointer(risks: ReviewRisk[]): string[] {
  if (!risks.length) return [];

  return [
    `Store review: value.reviewRisks carries ${risks.length} risk${risks.length === 1 ? "" : "s"} to fix or justify before a store submission (${risks.map((risk) => risk.code).join(", ")}).`,
  ];
}

const JUSTIFICATION_HEADING = SUBSECTION_KEYS.find((key) => key.field === "permissionJustifications")!.heading;
const REVIEWER_NOTES_HEADING = SUBSECTION_KEYS.find((key) => key.field === "reviewerNotes")!.heading;
const CERTIFICATION_NOTES_HEADING = SUBSECTION_KEYS.find((key) => key.field === "certificationNotes")!.heading;
const JUSTIFICATION_BULLETS = `a "${JUSTIFICATION_HEADING}" bullet under "${STORE_SECTIONS.chrome}"`;
const JUSTIFIED = "each permission, host permission and content script match the manifest declares";

export function wasmGrantLine(report: ReviewReport): string | null {
  if (!report.wasmGranted) return null;

  return `${STORE_MD_FILENAME}: the manifest grants ${WASM_GRANT}, the narrow grant for WebAssembly, and reviewers ask what compiles under it. Say which module does and that its binary ships in the package, in "${REVIEWER_NOTES_HEADING}" under "${STORE_SECTIONS.firefox}" and "${CERTIFICATION_NOTES_HEADING}" under "${STORE_SECTIONS.edge}".`;
}

export function reviewerNotesContent(root: string): string {
  const built = reviewerNoteBuildSentence(root);
  const line = built ? `"${built}"` : `"${REVIEWER_NOTE_BUILD_SHAPE}" with the versions extension_build answers in value.toolchain`;

  return `Under ${REVIEWER_NOTES_HEADING} write ${line} and say that the source is attached or where it is: the engine bundles the package's scripts, and Firefox reviewers rebuild bundled, minified or generated code from source.`;
}

export function storeMdLine(root: string, risks: ReviewRisk[]): string | null {
  if (!fs.existsSync(path.join(root, STORE_MD_FILENAME))) {
    return `No ${STORE_MD_FILENAME} is in ${root}. Write it there now from the manifest and the code, one section per store: ${STORE_SECTIONS.chrome} with a ${JUSTIFICATION_HEADING} bullet per declared permission, host permission and content script match, ${STORE_SECTIONS.firefox} with ${REVIEWER_NOTES_HEADING}, ${STORE_SECTIONS.edge} (extension_docs_search "${STORE_MD_FILENAME}" has the rest). ${reviewerNotesContent(root)} Leave only its data-use and privacy rows unanswered for the owner, and show them what the code stores and sends.`;
  }

  if (!risks.length) return null;

  return `${STORE_MD_FILENAME}: check that ${JUSTIFICATION_BULLETS} covers ${JUSTIFIED}.`;
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

export function reviewDistReport(distPath: string, browser: string, sourceManifest?: string | null): ReviewReport {
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

  return reviewRisksReport({ distPath, browser, manifest, files: listFiles(distPath), sourceManifest });
}
