// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { fileURLToPath } from "node:url";

import { RootsListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";

import type { Server } from "@modelcontextprotocol/sdk/server/index.js";

let reported: string[] | null = null;

export const clientDirs = {
  cwd: (): string => process.cwd(),
};

export function setClientRoots(uris: unknown[] | null): void {
  if (!uris) {
    reported = null;

    return;
  }

  reported = uris
    .map((uri) => {
      try {
        return typeof uri === "string" && uri.startsWith("file:") ? fileURLToPath(uri) : "";
      } catch {
        return "";
      }
    })
    .filter(Boolean);
}

/* @invariant THE CLIENT'S DIRECTORY ONLY EVER NARROWS AN UNNAMED CALL. When a
 * call names no project and several logins are stored, the one directory the
 * client works in (its single MCP root, or the stdio server's working
 * directory when the client reports no roots) may name the project through
 * its GitHub origin. Two roots name no one directory, so they name nothing.
 */
export function clientRoots(): string[] {
  return reported ? [...reported] : [];
}

export function clientProjectDir(): string | null {
  if (reported) return reported.length === 1 ? (reported[0] ?? null) : null;

  return clientDirs.cwd() || null;
}

export function watchClientRoots(server: Server): void {
  const refresh = async () => {
    if (!server.getClientCapabilities()?.roots) return;

    try {
      const listed = await server.listRoots();
      setClientRoots(listed.roots.map((root) => root.uri));
    } catch {
      setClientRoots(null);
    }
  };

  const previous = server.oninitialized;

  server.oninitialized = () => {
    previous?.();
    void refresh();
  };

  server.setNotificationHandler(RootsListChangedNotificationSchema, refresh);
}
