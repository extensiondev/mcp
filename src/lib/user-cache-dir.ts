// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import os from "node:os";
import path from "node:path";

export const CACHE_DIR_NAME = "extension-dev";

export function userCacheDir(): string {
  if (process.platform === "win32") {
    const base =
      process.env.LOCALAPPDATA ||
      (process.env.USERPROFILE ? path.join(process.env.USERPROFILE, "AppData", "Local") : "") ||
      path.join(os.homedir(), "AppData", "Local");

    return path.join(base, CACHE_DIR_NAME, "Cache");
  }

  const xdg = String(process.env.XDG_CACHE_HOME || "").trim();
  if (xdg) return path.join(xdg, CACHE_DIR_NAME);

  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Caches", CACHE_DIR_NAME);

  return path.join(os.homedir(), ".cache", CACHE_DIR_NAME);
}
