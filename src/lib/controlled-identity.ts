// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import fs from "node:fs";
import path from "node:path";

import { unpackedExtensionId } from "./extension-identity";
import { browserArtifactsDir } from "./session-paths";

import type { ReadyContract } from "./types";

/* @invariant A CONTROLLED RUN NAMES THE ID THE BROWSER LOADED. An unpacked
 * extension's id is the hash of the folder Chrome registered (its real path),
 * and allowControl loads a copy of the build from
 * dist/extension-js/<browser>/controlled, the engine's browserArtifactsDir, so
 * the controlled run and the plain dist/<browser> run are two extensions to
 * the browser. On 2026-10-21 the answer said nothing about it. On 2026-10-30
 * (soccer-broadcast, ledger 276) the answer hashed .extension-js/<browser>/
 * controlled, a folder that never exists, for the copy, and took the
 * contract's extensionId as the loaded id while that contract was the first
 * write of the run, whose id the engine derives from dist/<browser> before
 * the copy is prepared; the warning named the plain id twice and the debug
 * port was searched for an id the browser never loaded. The copy's id now
 * comes from the engine's own folder, and a contract id the browser has not
 * answered that equals the plain build's id is replaced by the copy's.
 */
const ANSWERED_SOURCES = new Set(["browser", "packager"]);
const ID_SHAPE = /^[a-p]{32}$/;

export type ControlledIdentity = {
  plainId: string;
  plainIds: string[];
  copyId: string | null;
  copyPath: string | null;
  startingUrl?: string;
  rewroteStartingUrl: boolean;
};

export type LoadedIdSource = "browser" | "contract" | "copy-folder";

export type LoadedId = {
  extensionId: string | undefined;
  source: LoadedIdSource | null;
  replacedPlainId: boolean;
};

export function registeredDirectoryPath(dir: string): string {
  const absolute = path.resolve(dir);
  if (process.platform === "win32") return absolute;

  const missing: string[] = [];
  let current = absolute;

  for (;;) {
    try {
      return path.join(fs.realpathSync.native(current), ...[...missing].reverse());
    } catch {
    }

    const parent = path.dirname(current);
    if (parent === current) return absolute;

    missing.push(path.basename(current));
    current = parent;
  }
}

export function registeredExtensionId(dir: string): string {
  return unpackedExtensionId(registeredDirectoryPath(dir));
}

function idsOf(dir: string): string[] {
  return [...new Set([registeredExtensionId(dir), unpackedExtensionId(dir)])];
}

export function controlledCopyPath(projectPath: string, browser: string): string {
  return path.join(browserArtifactsDir(projectPath, browser), "controlled");
}

export function controlledIdentity(args: {
  projectPath: string;
  browser: string;
  outputPath: string | null | undefined;
  allowControl: boolean;
  startingUrl?: string;
}): ControlledIdentity {
  const plainDist = args.outputPath
    ? path.resolve(args.projectPath, args.outputPath)
    : path.join(args.projectPath, "dist", args.browser);
  const plainIds = idsOf(plainDist);
  const plainId = plainIds[0]!;

  if (!args.allowControl) {
    return { plainId, plainIds, copyId: null, copyPath: null, startingUrl: args.startingUrl, rewroteStartingUrl: false };
  }

  const copyPath = controlledCopyPath(args.projectPath, args.browser);
  const copyId = registeredExtensionId(copyPath);
  const startingUrl = args.startingUrl;
  const named = startingUrl ? plainIds.find((id) => startingUrl.includes(id)) : undefined;

  if (startingUrl && named) {
    return { plainId, plainIds, copyId, copyPath, startingUrl: startingUrl.split(named).join(copyId), rewroteStartingUrl: true };
  }

  return { plainId, plainIds, copyId, copyPath, startingUrl, rewroteStartingUrl: false };
}

export function resolveLoadedId(
  identity: ControlledIdentity,
  contract: Pick<ReadyContract, "extensionId" | "extensionIdSource"> | null,
): LoadedId {
  const stamped = String(contract?.extensionId ?? "").trim().toLowerCase();
  const valid = ID_SHAPE.test(stamped) ? stamped : undefined;

  if (!identity.copyId) {
    return { extensionId: valid, source: valid ? "contract" : null, replacedPlainId: false };
  }

  const source = String(contract?.extensionIdSource ?? "").trim().toLowerCase();

  if (valid && ANSWERED_SOURCES.has(source)) {
    return { extensionId: valid, source: "browser", replacedPlainId: false };
  }

  if (valid && !identity.plainIds.includes(valid)) {
    return { extensionId: valid, source: "contract", replacedPlainId: false };
  }

  return { extensionId: identity.copyId, source: "copy-folder", replacedPlainId: valid !== undefined };
}

export function identityWarnings(identity: ControlledIdentity, loaded: LoadedId): Array<string | null> {
  if (!identity.copyId) return [];

  const actual = loaded.extensionId ?? identity.copyId;
  const predicted = actual === identity.copyId;

  return [
    `allowControl runs a copy of the build, and an unpacked extension's id comes from its folder, so this session's extension id is ${actual}, not the ${identity.plainId} that dist/<browser> gets: every chrome-extension:// address and every chrome://extensions/?options= address for this run uses ${actual}, and the copy shares no chrome.storage and no grants with the plain build's runs.`,
    loaded.replacedPlainId
      ? `The contract read 5 s after spawn still carried the plain build's id ${identity.plainId}, which the engine derives from dist/<browser> before it prepares the copy, so ${actual} is predicted from the copy's folder; extension_wait reads the id the browser answered once the contract records it.`
      : null,
    identity.rewroteStartingUrl
      ? predicted
        ? `startingUrl named the plain build's id ${identity.plainId}; it was rewritten to ${identity.copyId} so it opens on this run.`
        : `startingUrl named the plain build's id ${identity.plainId} and was rewritten to ${identity.copyId}, but the contract recorded ${actual}; open the page again with that id.`
      : null,
  ];
}
