// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import fs from "node:fs";
import path from "node:path";

const DOM_HIT_CAP = 20;
const GLOB_FILE_CAP = 2000;

interface DomHit {
  tag: string;
  attribute: string;
  value: string;
}

interface GlobalRef {
  name: string;
  where: string;
  value: string;
}

export interface PageWorldRead {
  dom: { bytes: number; elements: number; shadowRoots: number; occurrences: number; hits: DomHit[] };
  ownNames: string[];
  symbols: string[];
  refs: GlobalRef[];
}

export function pageWorldReadScript(extensionId: string): string {
  return `(() => {
  const id = ${JSON.stringify(extensionId)};
  const root = document.documentElement;
  const html = root ? root.outerHTML : "";
  const dom = { bytes: html.length, elements: 0, shadowRoots: 0, occurrences: html.split(id).length - 1, hits: [] };
  const trim = (value) => {
    const text = String(value).replace(/\\s+/g, " ").trim();
    return text.length > 160 ? text.slice(0, 160) + "…" : text;
  };
  const push = (tag, attribute, value) => {
    if (dom.hits.length < ${DOM_HIT_CAP}) dom.hits.push({ tag, attribute, value: trim(value) });
  };
  const scan = (start) => {
    const walker = document.createTreeWalker(start, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
    for (let node = walker.currentNode; node; node = walker.nextNode()) {
      if (node.nodeType === 3) {
        if (node.data && node.data.includes(id)) {
          push(node.parentElement ? node.parentElement.tagName.toLowerCase() : "#document", "#text", node.data);
        }
        continue;
      }
      if (node.nodeType !== 1) continue;
      dom.elements += 1;
      const tag = node.tagName.toLowerCase();
      for (const attribute of node.attributes) {
        if (attribute.value.includes(id)) push(tag, attribute.name, attribute.value);
      }
      if (node.shadowRoot) {
        dom.shadowRoots += 1;
        scan(node.shadowRoot);
      }
    }
  };
  if (root) scan(root);
  const ownNames = Object.getOwnPropertyNames(window);
  const symbols = Object.getOwnPropertySymbols(window).map((symbol) => symbol.description === undefined ? String(symbol) : symbol.description);
  const refs = [];
  const stringForm = (value) => {
    if (typeof value === "string") return value;
    if (typeof value === "function") {
      try { return Function.prototype.toString.call(value); } catch { return ""; }
    }
    if (value && typeof value === "object") {
      try {
        const parts = [];
        for (const key of Object.keys(value).slice(0, 200)) {
          const inner = value[key];
          if (typeof inner === "string") parts.push(key + "=" + inner);
        }
        return parts.join(" ");
      } catch { return ""; }
    }
    return "";
  };
  for (const name of ownNames) {
    if (name.includes(id)) {
      refs.push({ name, where: "name", value: trim(name) });
      continue;
    }
    let descriptor;
    try { descriptor = Object.getOwnPropertyDescriptor(window, name); } catch { continue; }
    if (!descriptor || !("value" in descriptor)) continue;
    const text = stringForm(descriptor.value);
    const at = text.indexOf(id);
    if (at >= 0) refs.push({ name, where: "value", value: trim(text.slice(Math.max(0, at - 60), at + id.length + 60)) });
  }
  return { dom, ownNames, symbols, refs };
})()`;
}

export function resourceProbeScript(probes: Array<{ index: number; url: string }>): string {
  return `(async () => {
  const probes = ${JSON.stringify(probes)};
  const out = [];
  for (const probe of probes) {
    try {
      const response = await fetch(probe.url, { method: "GET", cache: "no-store", credentials: "omit" });
      out.push({ index: probe.index, ok: response.ok, status: response.status });
    } catch (error) {
      out.push({ index: probe.index, ok: false, error: String((error && error.message) || error) });
    }
  }
  return out;
})()`;
}

export const BASELINE_SCRIPT = "Object.getOwnPropertyNames(window)";

export interface ResourceProbe {
  index: number;
  path: string;
  matches: string[];
  pattern?: string;
}

export interface SkippedResource {
  index: number;
  reason: string;
}

function hasGlob(pattern: string): boolean {
  return /[*?[{]/.test(pattern);
}

function globToRegExp(pattern: string): RegExp {
  const source = pattern
    .replace(/^\/+/, "")
    .split("*")
    .map((part) => part.split("?").map((piece) => piece.replace(/[.+^${}()|[\]\\]/g, "\\$&")).join("."))
    .join(".*");

  return new RegExp(`^${source}$`);
}

function resolveGlob(distDir: string, pattern: string): string | null {
  const matcher = globToRegExp(pattern);
  const queue = [""];
  let seen = 0;

  while (queue.length && seen < GLOB_FILE_CAP) {
    const relative = queue.shift()!;
    let entries: fs.Dirent[];

    try {
      entries = fs.readdirSync(path.join(distDir, relative), { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      seen += 1;

      if (entry.isDirectory()) {
        queue.push(child);
      } else if (matcher.test(child)) {
        return child;
      }
    }
  }

  return null;
}

export function staticResources(
  manifest: Record<string, unknown>,
  distDir: string | null,
): { probes: ResourceProbe[]; skipped: SkippedResource[] } {
  const probes: ResourceProbe[] = [];
  const skipped: SkippedResource[] = [];
  const raw = manifest.web_accessible_resources;
  if (!Array.isArray(raw)) return { probes, skipped };

  raw.forEach((entry, index) => {
    const block = typeof entry === "string" ? { resources: [entry], matches: ["<all_urls>"] } : entry;

    if (!block || typeof block !== "object") {
      skipped.push({ index, reason: `web_accessible_resources[${index}] is not a string or an object, so no path can be read from it` });

      return;
    }

    const record = block as Record<string, unknown>;

    if (record.use_dynamic_url === true) {
      skipped.push({ index, reason: `web_accessible_resources[${index}] declares use_dynamic_url: true, so its url changes per session and cannot be guessed` });

      return;
    }

    const resources = Array.isArray(record.resources) ? record.resources.map(String) : [];
    const matches = Array.isArray(record.matches) ? record.matches.map(String) : [];

    if (resources.length === 0) {
      skipped.push({ index, reason: `web_accessible_resources[${index}] lists no resources` });

      return;
    }

    if (matches.length === 0) {
      skipped.push({ index, reason: `web_accessible_resources[${index}] names no matches, so no web page can fetch it` });

      return;
    }

    const concrete = resources.find((resource) => !hasGlob(resource));

    if (concrete) {
      probes.push({ index, path: concrete.replace(/^\/+/, ""), matches });

      return;
    }

    for (const pattern of resources) {
      const resolved = distDir ? resolveGlob(distDir, pattern) : null;

      if (resolved) {
        probes.push({ index, path: resolved, matches, pattern });

        return;
      }
    }

    skipped.push({
      index,
      reason: `web_accessible_resources[${index}] lists only globs (${resources.join(", ")}) that could not be resolved to a file ${distDir ? `under ${distDir}` : "because the manifest read is the source one, not a build"}`,
    });
  });

  return { probes, skipped };
}
