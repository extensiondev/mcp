// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import fs from "node:fs";
import path from "node:path";

import { sourceManifest } from "./manifest-by-browser";

type Manifest = Record<string, unknown>;

export interface CodeSite {
  file: string;
  line: number;
  call: string;
}

export interface CodeFacts {
  manifestFound: boolean;
  permissions: string[];
  hostPermissions: string[];
  optionalPermissions: string[];
  contentScriptMatches: string[];
  dataCollection: unknown;
  dataCollectionDeclared: boolean;
  surfaces: string[];
  network: CodeSite[];
  remoteCode: CodeSite[];
  hosts: string[];
  filesScanned: number;
  scanCapped: boolean;
  scanned: string[];
}

const SKIP_DIRS = new Set(["node_modules", "dist", ".git", "build", "coverage", ".turbo", ".next", "store"]);
const SPECIAL_FOLDERS = ["pages", "scripts", "public"];
const SOURCE_EXT = new Set([".js", ".mjs", ".cjs", ".jsx", ".ts", ".mts", ".cts", ".tsx", ".vue", ".svelte", ".html"]);
const MAX_FILES = 2_000;
const MAX_BYTES = 1024 * 1024;
const MAX_SITES = 20;

const NETWORK_CALLS: Array<[RegExp, string]> = [
  [/\bfetch\s*\(/, "fetch"],
  [/\bnew\s+XMLHttpRequest\b/, "XMLHttpRequest"],
  [/\bnew\s+WebSocket\s*\(/, "WebSocket"],
  [/\bnavigator\.sendBeacon\s*\(/, "navigator.sendBeacon"],
  [/\bnew\s+EventSource\s*\(/, "EventSource"],
];

const REMOTE_CODE_CALLS: Array<[RegExp, string]> = [
  [/(^|[^.\w])eval\s*\(/, "eval"],
  [/\bnew\s+Function\s*\(/, "new Function"],
  [/\bimportScripts\s*\(\s*["'`]https?:/, "importScripts of a remote URL"],
  [/\bimport\s*\(\s*["'`]https?:/, "import() of a remote URL"],
  [/<script[^>]*\ssrc\s*=\s*["']https?:/i, "a remote <script src>"],
];

const URL_HOST = /\bhttps?:\/\/([a-z0-9.-]+\.[a-z]{2,})(?::\d+)?/gi;
const IGNORED_HOSTS = /(^|\.)(w3\.org|schema\.org|example\.(com|org|net)|localhost)$/i;

const BARE = /^(?:[a-z-]+:)?/;

function keyed(manifest: Manifest, key: string): unknown[] {
  return Object.entries(manifest)
    .filter(([name]) => name.replace(BARE, "") === key)
    .flatMap(([, value]) => (Array.isArray(value) ? value : []));
}

const strings = (values: unknown[]): string[] => [...new Set(values.filter((value): value is string => typeof value === "string" && value.trim() !== ""))];

function geckoSettings(manifest: Manifest): Record<string, unknown> | null {
  for (const [name, value] of Object.entries(manifest)) {
    if (name.replace(BARE, "") !== "browser_specific_settings" || !value || typeof value !== "object") continue;

    const gecko = (value as Record<string, unknown>).gecko;
    if (gecko && typeof gecko === "object") return gecko as Record<string, unknown>;
  }

  return null;
}

function surfacesOf(manifest: Manifest): string[] {
  const has = (key: string) => Object.keys(manifest).some((name) => name.replace(BARE, "") === key);
  const named: Array<[string, string]> = [
    ["background", "a background script"],
    ["action", "a toolbar button"],
    ["browser_action", "a toolbar button"],
    ["page_action", "an address bar button"],
    ["options_ui", "an options page"],
    ["options_page", "an options page"],
    ["side_panel", "a side panel"],
    ["sidebar_action", "a sidebar"],
    ["devtools_page", "a DevTools page"],
    ["chrome_url_overrides", "a replaced browser page"],
    ["content_scripts", "content scripts"],
    ["commands", "keyboard shortcuts"],
    ["omnibox", "an address bar keyword"],
  ];

  return [...new Set(named.filter(([key]) => has(key)).map(([, words]) => words))];
}

/* @invariant A CODE FACT DESCRIBES WHAT SHIPS, SO THE SCAN READS WHAT
 * EXTENSION.JS BUILDS. With the manifest in src/, the engine builds src/ and
 * the project root's special folders pages/ and scripts/, and copies
 * public/ as it is; a tools/ or demo script beside them never reaches the
 * package, and on Rebeccat it was quoted as the extension's network calls.
 * With the manifest at the root, the root is the source and is read whole,
 * less the folders no build ships. The answer names the folders it read.
 */
export function scanRoots(projectPath: string): string[] {
  const root = path.resolve(projectPath);

  if (!fs.existsSync(path.join(root, "src", "manifest.json"))) return [root];

  return [path.join(root, "src"), ...SPECIAL_FOLDERS.map((name) => path.join(root, name)).filter((dir) => fs.existsSync(dir))];
}

function sourceFiles(roots: string[]): { files: string[]; capped: boolean } {
  const files: string[] = [];
  const stack = [...roots].reverse();

  while (stack.length) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];

    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith(".") && entry.isDirectory()) continue;

      const full = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name) && !/^(tests?|__tests__|e2e|spec)$/.test(entry.name)) stack.push(full);

        continue;
      }

      if (!SOURCE_EXT.has(path.extname(entry.name).toLowerCase()) || /\.(test|spec)\.[a-z]+$/.test(entry.name) || /\.d\.ts$/.test(entry.name)) continue;
      if (files.length >= MAX_FILES) return { files, capped: true };

      files.push(full);
    }
  }

  return { files: files.sort(), capped: false };
}

function stripLineComment(line: string): string {
  return /^\s*(\/\/|\*|\/\*)/.test(line) ? "" : line;
}

export function codeFactsOf(projectPath: string): CodeFacts {
  const root = path.resolve(projectPath);
  const manifest = sourceManifest(root);
  const gecko = manifest ? geckoSettings(manifest) : null;
  const roots = scanRoots(root);
  const scan = sourceFiles(roots);
  const network: CodeSite[] = [];
  const remoteCode: CodeSite[] = [];
  const hosts = new Set<string>();

  for (const file of scan.files) {
    let body: string;

    try {
      if (fs.statSync(file).size > MAX_BYTES) continue;

      body = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }

    const relative = path.relative(root, file).split(path.sep).join("/");

    body.split("\n").forEach((raw, index) => {
      const line = stripLineComment(raw);
      if (!line) return;

      for (const [pattern, call] of NETWORK_CALLS) if (pattern.test(line)) network.push({ file: relative, line: index + 1, call });
      for (const [pattern, call] of REMOTE_CODE_CALLS) if (pattern.test(line)) remoteCode.push({ file: relative, line: index + 1, call });
      for (const match of line.matchAll(URL_HOST)) if (!IGNORED_HOSTS.test(match[1]!)) hosts.add(match[1]!.toLowerCase());
    });
  }

  return {
    manifestFound: Boolean(manifest),
    permissions: manifest ? strings(keyed(manifest, "permissions")) : [],
    hostPermissions: manifest ? strings(keyed(manifest, "host_permissions")) : [],
    optionalPermissions: manifest ? strings([...keyed(manifest, "optional_permissions"), ...keyed(manifest, "optional_host_permissions")]) : [],
    contentScriptMatches: manifest ? strings(keyed(manifest, "content_scripts").flatMap((script) => (script && typeof script === "object" && Array.isArray((script as Record<string, unknown>).matches) ? ((script as Record<string, unknown>).matches as unknown[]) : []))) : [],
    dataCollection: gecko && "data_collection_permissions" in gecko ? gecko.data_collection_permissions : null,
    dataCollectionDeclared: Boolean(gecko && "data_collection_permissions" in gecko),
    surfaces: manifest ? surfacesOf(manifest) : [],
    network,
    remoteCode,
    hosts: [...hosts].sort(),
    filesScanned: scan.files.length,
    scanCapped: scan.capped,
    scanned: roots.map((dir) => (dir === root ? "the project root" : `${path.relative(root, dir)}/`)),
  };
}

const listed = (values: string[]): string => values.join(", ");

function sitesSentence(kind: string, sites: CodeSite[]): string {
  const shown = sites.slice(0, MAX_SITES).map((site) => `${site.file}:${site.line} (${site.call})`);
  const more = sites.length > MAX_SITES ? `, and ${sites.length - MAX_SITES} more` : "";

  return `The source has ${sites.length} ${kind} ${sites.length === 1 ? "site" : "sites"}: ${shown.join(", ")}${more}.`;
}

function scannedSentence(facts: CodeFacts): string {
  return `${facts.filesScanned} source ${facts.filesScanned === 1 ? "file" : "files"} under ${listed(facts.scanned)} ${facts.filesScanned === 1 ? "was" : "were"} read${facts.scanCapped ? `, the first ${MAX_FILES} only` : ""}, what the build ships; tests, dist and node_modules were not.`;
}

export function networkFacts(facts: CodeFacts): string[] {
  return [
    facts.network.length ? sitesSentence("network call", facts.network) : "The source has no fetch, XMLHttpRequest, WebSocket, sendBeacon or EventSource call.",
    facts.hosts.length ? `URLs in the source name these hosts: ${listed(facts.hosts)}.` : "No URL in the source names a host.",
    scannedSentence(facts),
  ];
}

export function accessFacts(facts: CodeFacts): string[] {
  if (!facts.manifestFound) return ["No manifest.json was found at src/manifest.json or manifest.json."];

  return [
    facts.permissions.length ? `The manifest asks for these permissions: ${listed(facts.permissions)}.` : "The manifest asks for no permissions.",
    facts.hostPermissions.length ? `The manifest asks for these host permissions: ${listed(facts.hostPermissions)}.` : "The manifest declares no host permissions.",
    ...(facts.optionalPermissions.length ? [`The manifest lists these as optional: ${listed(facts.optionalPermissions)}.`] : []),
    facts.contentScriptMatches.length ? `Content scripts run on: ${listed(facts.contentScriptMatches)}.` : "The manifest declares no content scripts.",
  ];
}

export function remoteCodeFacts(facts: CodeFacts): string[] {
  return [
    facts.remoteCode.length ? sitesSentence("eval, new Function or remote script", facts.remoteCode) : "The source has no eval, no new Function, and no script loaded from a remote URL.",
    scannedSentence(facts),
  ];
}

export function dataCollectionFacts(facts: CodeFacts): string[] {
  if (!facts.manifestFound) return ["No manifest.json was found at src/manifest.json or manifest.json."];

  return [
    facts.dataCollectionDeclared
      ? `The manifest declares browser_specific_settings.gecko.data_collection_permissions as ${JSON.stringify(facts.dataCollection)}.`
      : "The manifest declares no browser_specific_settings.gecko.data_collection_permissions.",
  ];
}
