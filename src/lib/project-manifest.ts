// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import fs from "node:fs";
import path from "node:path";

/* @invariant One candidate list for the whole package. The built manifest is
   the one a running browser loaded, so dist wins over src, and the ordering
   below was already copied three times inside tools/open.ts alone. A reader
   that consults a different list than the writer answers a different question
   about the same extension. */
export function manifestCandidates(
  projectPath: string,
  browser: string,
): string[] {
  return [
    path.join(projectPath, "dist", browser, "manifest.json"),
    path.join(projectPath, "dist", "manifest.json"),
    path.join(projectPath, "src", "manifest.json"),
    path.join(projectPath, "manifest.json"),
  ];
}

export interface ReadManifest {
  file: string;
  manifest: Record<string, unknown>;
}

export function readBuiltManifest(
  projectPath: string,
  browser: string,
): ReadManifest | null {
  for (const file of manifestCandidates(projectPath, browser)) {
    try {
      const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
      if (manifest && typeof manifest === "object") {
        return { file, manifest: manifest as Record<string, unknown> };
      }
    } catch {
      continue;
    }
  }
  return null;
}

export type BackgroundKind = "service_worker" | "scripts" | "page" | "none";

export interface DeclaredBackground {
  kind: BackgroundKind;
  ref?: string;
}

export function declaredBackground(
  manifest: Record<string, unknown>,
): DeclaredBackground {
  const background = manifest.background;
  if (!background || typeof background !== "object") return { kind: "none" };
  const block = background as Record<string, unknown>;
  if (typeof block.service_worker === "string" && block.service_worker) {
    return { kind: "service_worker", ref: block.service_worker };
  }
  if (Array.isArray(block.scripts) && block.scripts.length > 0) {
    return { kind: "scripts", ref: block.scripts.map(String).join(", ") };
  }
  if (typeof block.page === "string" && block.page) {
    return { kind: "page", ref: block.page };
  }
  return { kind: "none" };
}

export interface DeclaredContentScript {
  index: number;
  matches: string[];
  js: string[];
}

export function declaredContentScripts(
  manifest: Record<string, unknown>,
): DeclaredContentScript[] {
  const raw = manifest.content_scripts;
  if (!Array.isArray(raw)) return [];
  const out: DeclaredContentScript[] = [];
  raw.forEach((entry, index) => {
    if (!entry || typeof entry !== "object") return;
    const block = entry as Record<string, unknown>;
    out.push({
      index,
      matches: Array.isArray(block.matches) ? block.matches.map(String) : [],
      js: Array.isArray(block.js) ? block.js.map(String) : [],
    });
  });
  return out;
}
