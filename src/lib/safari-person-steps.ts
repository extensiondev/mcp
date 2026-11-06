// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import fs from "node:fs";
import path from "node:path";

import { readBuiltManifest } from "./project-manifest";
import { engineProjectRoot } from "./session-paths";

export type SafariPromptKind = "camera" | "microphone" | "geolocation";

export interface SafariPersonStep {
  prompt: SafariPromptKind;
  askedBy: string;
  step: string;
}

const MAX_FILES = 200;
const MAX_FILE_BYTES = 8 * 1024 * 1024;

function builtScripts(distPath: string): string[] {
  const out: string[] = [];
  const queue = [distPath];

  while (queue.length > 0 && out.length < MAX_FILES) {
    const dir = queue.shift()!;
    let entries: fs.Dirent[];

    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const file = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        if (entry.name !== "node_modules") queue.push(file);
      } else if (/\.m?js$/.test(entry.name)) {
        out.push(file);
      }
    }
  }

  return out.slice(0, MAX_FILES);
}

function readBounded(file: string): string {
  try {
    if (fs.statSync(file).size > MAX_FILE_BYTES) return "";

    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

function stepFor(prompt: SafariPromptKind, askedBy: string): SafariPersonStep {
  const access = prompt === "geolocation" ? "location" : prompt;

  return {
    prompt,
    askedBy,
    step: `When the extension first asks for ${access} access, Safari shows its ${prompt} permission prompt and ignores synthetic clicks on it (an AX click, AXPress or a CGEvent click leaves it open), so a person clicks Allow there (${askedBy}).`,
  };
}

export function safariPersonSteps(projectPath: string, browser: string, distPath: string | null): SafariPersonStep[] {
  const found = new Map<SafariPromptKind, string>();
  const manifest = readBuiltManifest(projectPath, browser)?.manifest ?? {};
  const declared = [manifest.permissions, manifest.optional_permissions]
    .flatMap((list) => (Array.isArray(list) ? list : []))
    .filter((entry): entry is string => typeof entry === "string");

  for (const permission of declared) {
    if (permission === "geolocation" || permission === "camera" || permission === "microphone") {
      found.set(permission, `manifest permission "${permission}"`);
    }
  }

  const root = distPath ?? path.join(engineProjectRoot(projectPath), "dist", browser);

  for (const file of builtScripts(root)) {
    const source = readBounded(file);
    if (!source) continue;

    const name = path.relative(root, file);

    if (/\bgetUserMedia\s*\(|\bgetDisplayMedia\s*\(/.test(source)) {
      const audioOnly = /\baudio\s*:/.test(source) && !/\bvideo\s*:/.test(source);
      const prompt: SafariPromptKind = audioOnly ? "microphone" : "camera";
      if (!found.has(prompt)) found.set(prompt, `${name} calls getUserMedia`);
    }

    if (/navigator\.geolocation\b/.test(source) && !found.has("geolocation")) found.set("geolocation", `${name} reads navigator.geolocation`);
  }

  return [...found.entries()].map(([prompt, askedBy]) => stepFor(prompt, askedBy));
}
