// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { extensionInstall } from "extension-install";
import { envelope } from "../lib/envelope";

export async function installManagedBrowser(
  browser: string,
): Promise<string> {
  const start = Date.now();

  try {
    await extensionInstall({ browser });

    return envelope({
      ok: true,
      command: "extension_browsers",
      status: "installed",
      value: { browser, duration: Date.now() - start },
      hint: `Browser "${browser}" is now available. Use extension_dev or extension_start with browser: "${browser}".`,
    });
  } catch (err) {
    return envelope({
      ok: false,
      command: "extension_browsers",
      status: "install-failed",
      value: { browser, duration: Date.now() - start },
      error: {
        code: "E_BROWSER_INSTALL",
        message: err instanceof Error ? err.message : String(err),
      },
      hint:
        browser === "edge"
          ? "Edge installation on Linux may require elevated privileges. Try using Chrome or Chromium instead."
          : "Check network connectivity and disk space. You can also install browsers manually.",
    });
  }
}
