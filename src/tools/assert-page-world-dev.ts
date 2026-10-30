// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import fs from "node:fs";

import { ENGINE_CONTROL_FILE } from "../lib/build-type";
import { engineManifestView } from "../lib/engine-manifest-view";
import { sourceManifest } from "../lib/manifest-by-browser";
import { readyContractPath } from "../lib/session-paths";
import { matchesResourcePattern } from "./assert-page-world-reads";

export type SessionKind = "dev" | "production";

export type SessionDecidedBy = "contract" | "control-file" | "markers" | "no-dev-signal";

export interface SessionRead {
  kind: SessionKind;
  decidedBy: SessionDecidedBy;
}

const DEV_ATTRIBUTE_PREFIX = "data-extjs-";

export function isDevRuntimeAttribute(name: string): boolean {
  return name.startsWith(DEV_ATTRIBUTE_PREFIX);
}

function contractCommand(projectPath: string, browser: string): string | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(readyContractPath(projectPath, browser), "utf8")) as unknown;
    const command = parsed && typeof parsed === "object" ? (parsed as { command?: unknown }).command : undefined;

    return typeof command === "string" ? command : null;
  } catch {
    return null;
  }
}

function listedResources(manifest: Record<string, unknown>): string[] {
  const raw = manifest.web_accessible_resources;
  if (!Array.isArray(raw)) return [];

  const out: string[] = [];

  for (const entry of raw) {
    if (typeof entry === "string") {
      out.push(entry);
    } else if (entry && typeof entry === "object") {
      const resources = (entry as { resources?: unknown }).resources;
      if (Array.isArray(resources)) out.push(...resources.map(String));
    }
  }

  return out;
}

export function readSessionKind(
  projectPath: string,
  browser: string,
  runningManifest: Record<string, unknown>,
  domAttributes: string[],
): SessionRead {
  const command = contractCommand(projectPath, browser);

  if (command === "dev") return { kind: "dev", decidedBy: "contract" };
  if (command === "start" || command === "preview") return { kind: "production", decidedBy: "contract" };

  if (listedResources(runningManifest).some((resource) => matchesResourcePattern(resource, ENGINE_CONTROL_FILE))) {
    return { kind: "dev", decidedBy: "control-file" };
  }

  if (domAttributes.some(isDevRuntimeAttribute)) return { kind: "dev", decidedBy: "markers" };

  return { kind: "production", decidedBy: "no-dev-signal" };
}

export function devRuntimeResourceTest(
  projectPath: string,
  browser: string,
  runningManifestIsSource: boolean,
): (resourcePath: string) => boolean {
  const source = runningManifestIsSource ? null : sourceManifest(projectPath);
  const declared = source ? listedResources(engineManifestView(source, browser)) : null;

  return (resourcePath) => {
    if (matchesResourcePattern(ENGINE_CONTROL_FILE, resourcePath)) return true;
    if (!declared) return false;

    return !declared.some((pattern) => matchesResourcePattern(pattern, resourcePath));
  };
}

export function sessionSentence(read: SessionRead): string {
  switch (read.decidedBy) {
    case "contract":
      return `the session's ready contract names the ${read.kind === "dev" ? "dev" : "production"} command`;
    case "control-file":
      return `the running manifest lists ${ENGINE_CONTROL_FILE} among its web_accessible_resources, the agent bridge a dev build carries`;
    case "markers":
      return `the page carries ${DEV_ATTRIBUTE_PREFIX}* attributes, the markers the dev runtime writes`;
    default:
      return "the session's ready contract names no command and the page carries no dev-runtime signal";
  }
}

export function devRuntimeTrailer(excluded: number, read: SessionRead): string {
  return `${excluded.toLocaleString("en-US")} dev-runtime ${excluded === 1 ? "hit was" : "hits were"} excluded from the verdict (labeled devRuntime in the evidence) because ${sessionSentence(read)}: the Extension.js dev runtime's ${DEV_ATTRIBUTE_PREFIX}* markers, the __EXTENSIONJS_* and __extjs* window globals it plants and the web_accessible_resources it adds are not in the shipped build; run the check on an extension_start session for the shipped answer.`;
}
