// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { extensionInstall } from "extension-install";

export async function installManagedBrowser(
  browser: string,
): Promise<string> {
  const start = Date.now();

  try {
    await extensionInstall({ browser });

    return JSON.stringify({
      status: "installed",
      browser,
      duration: Date.now() - start,
      hint: `Browser "${browser}" is now available. Use extension_dev or extension_start with browser: "${browser}".`,
    });
  } catch (err) {
    return JSON.stringify({
      status: "error",
      browser,
      message: err instanceof Error ? err.message : String(err),
      duration: Date.now() - start,
      hint:
        browser === "edge"
          ? "Edge installation on Linux may require elevated privileges. Try using Chrome or Chromium instead."
          : "Check network connectivity and disk space. You can also install browsers manually.",
    });
  }
}
