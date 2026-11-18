// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import fs from "node:fs";
import path from "node:path";

export const WASM_GRANT = "'wasm-unsafe-eval'";
export const WASM_POLICY_KEY = "content_security_policy.extension_pages";
export const WASM_POLICY = `script-src 'self' ${WASM_GRANT}; object-src 'self'`;
export const WASM_POLICY_BLOCK = `"content_security_policy": { "extension_pages": "${WASM_POLICY}" }`;
export const CONTENT_SCRIPT_SENTENCE = "A content script compiles under the host page's policy, which this grant does not change.";

export const WASM_WARNING_PREFIX = "WebAssembly: ";
export const UNSAFE_EVAL_PHRASE = `${WASM_POLICY_KEY} carries 'unsafe-eval'`;

export function isWasmPolicyLine(line: string): boolean {
  return line.startsWith(WASM_WARNING_PREFIX) || line.includes(UNSAFE_EVAL_PHRASE);
}

export function scriptSources(policy: string): string[] {
  const directives = new Map<string, string[]>();

  for (const part of policy.split(";")) {
    const [name, ...sources] = part.split(/\s/).filter(Boolean);

    if (name && !directives.has(name.toLowerCase())) directives.set(name.toLowerCase(), sources.map((source) => source.toLowerCase()));
  }

  return directives.get("script-src") ?? directives.get("default-src") ?? [];
}

export interface WasmPolicyRead {
  policy: string | null;
  granted: boolean;
  unsafeEval: boolean;
}

/* @invariant
 * MDN (Content Security Policy for WebExtensions, read 2026-11-18): Manifest
 * V3 in Chrome 103 and Firefox 102 or later compiles WebAssembly only with
 * 'wasm-unsafe-eval' in script-src, and permits only 'self', 'none' and
 * 'wasm-unsafe-eval' there. Firefox Manifest V2 still compiles without it.
 */
export function wasmPolicyOf(view: Record<string, unknown>): WasmPolicyRead {
  const raw = view.content_security_policy;
  const pages = raw && typeof raw === "object" ? (raw as Record<string, unknown>).extension_pages : raw;
  const policy = typeof pages === "string" ? pages : null;
  const sources = policy ? scriptSources(policy) : [];

  return { policy, granted: sources.includes(WASM_GRANT), unsafeEval: sources.includes("'unsafe-eval'") };
}

export function needsWasmGrant(view: Record<string, unknown>): boolean {
  return view.manifest_version === 3;
}

const NAME_CHARS = /[\w@.-]/;
const WASM_CALL = /\bWebAssembly\s?\.\s?(instantiateStreaming|instantiate|compileStreaming|compile|Module)\b/;
const MODULE_SPECIFIER = /\b(?:from|import|require)\s?\(?\s?["']([^"'\n]{1,200})["']/g;

function wasmFileNamed(source: string): string | null {
  let at = source.indexOf(".wasm");

  while (at !== -1) {
    const after = source[at + 5];

    if (after === undefined || !/\w/.test(after)) {
      let start = at;

      while (start > 0 && at - start < 60 && NAME_CHARS.test(source[start - 1]!)) start--;

      return source.slice(start, at + 5);
    }

    at = source.indexOf(".wasm", at + 5);
  }

  return null;
}

export function wasmSignIn(source: string): string | null {
  const file = wasmFileNamed(source);

  if (file) return file === ".wasm" ? "names a .wasm file" : `names ${file}`;

  const call = WASM_CALL.exec(source);

  if (call) return `calls WebAssembly.${call[1]}`;

  for (const match of source.matchAll(MODULE_SPECIFIER)) {
    if (/wasm/i.test(match[1]!)) return `imports ${match[1]}`;
  }

  return null;
}

const DEPENDENCY_CAP = 60;
const DEPENDENCY_DEPTH = 2;
const DEPENDENCY_ENTRIES = 400;

function shippedWasm(dir: string): string | null {
  let budget = DEPENDENCY_ENTRIES;
  const queue: Array<{ dir: string; depth: number }> = [{ dir, depth: 0 }];

  for (let at = 0; at < queue.length; at++) {
    const here = queue[at]!;
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
        if (here.depth < DEPENDENCY_DEPTH && entry.name !== "node_modules" && !entry.name.startsWith(".")) queue.push({ dir: file, depth: here.depth + 1 });
      } else if (entry.name.endsWith(".wasm")) {
        return path.relative(dir, file).split(path.sep).join("/");
      }
    }
  }

  return null;
}

export function dependencyWasm(projectRoot: string): Array<{ name: string; file: string }> {
  let dependencies: Record<string, unknown>;

  try {
    dependencies = (JSON.parse(fs.readFileSync(path.join(projectRoot, "package.json"), "utf8")) as { dependencies?: Record<string, unknown> }).dependencies ?? {};
  } catch {
    return [];
  }

  const found: Array<{ name: string; file: string }> = [];

  for (const name of Object.keys(dependencies).slice(0, DEPENDENCY_CAP)) {
    const file = shippedWasm(path.join(projectRoot, "node_modules", name));

    if (file) found.push({ name, file });
  }

  return found;
}

export interface WasmSeen {
  files: string[];
  references: Array<{ file: string; sign: string }>;
}

export function wasmEvidence(projectRoot: string, seen: WasmSeen): string[] {
  const relative = (file: string): string => path.relative(projectRoot, file).split(path.sep).join("/") || file;
  const evidence: string[] = [];

  if (seen.files.length) evidence.push(`the project holds ${seen.files.slice(0, 2).map(relative).join(" and ")}`);

  for (const dependency of dependencyWasm(projectRoot).slice(0, 2)) evidence.push(`the dependency ${dependency.name} ships ${dependency.file}`);

  for (const reference of seen.references.slice(0, 2)) evidence.push(`${relative(reference.file)} ${reference.sign}`);

  return evidence.slice(0, 3);
}

const URL_IN_TEXT = /https?:\/\/[^\s"'`<>)\\]+/g;
const LOADER_OPTION = /\b(locateFile|wasmUrl|wasmURL|wasmPath|wasmPaths|wasmBinaryFile|wasmBaseUrl|corePath|coreURL|wasmUri)\b["']?\]?\s?([:=(])/g;
const LOCAL_HOST = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])([:/]|$)/;
const LOADER_REACH = 140;

export interface RemoteWasm {
  address: string;
  option?: string;
}

function loaderOptionBefore(before: string): string | null {
  if (!/["'`]$/.test(before)) return null;

  const last = [...before.matchAll(LOADER_OPTION)].pop();

  if (!last) return null;

  const between = (last[2] === "(" ? "(" : "") + before.slice(last.index + last[0].length, -1);

  if (/["'`;}\n]/.test(between) || between.replace(/\([^()]{0,60}\)/, "").includes(",")) return null;

  return last[1]!;
}

export function remoteWasmIn(text: string): RemoteWasm[] {
  const found = new Map<string, RemoteWasm>();

  for (const match of text.matchAll(URL_IN_TEXT)) {
    const address = match[0].split("${")[0]!;

    if (LOCAL_HOST.test(address) || found.has(address)) continue;

    const resource = address.split(/[?#]/)[0]!;

    if (resource.endsWith(".wasm")) {
      found.set(address, { address });
      continue;
    }

    const option = loaderOptionBefore(text.slice(Math.max(0, match.index - LOADER_REACH), match.index));

    if (option) found.set(address, { address, option });
  }

  return [...found.values()];
}
