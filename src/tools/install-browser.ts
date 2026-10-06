// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import path from "node:path";
import { extensionInstall, getManagedBrowsersCacheRoot } from "extension-install";
import { envelope } from "../lib/envelope";
import { findManagedBinaryIn } from "./detect-browsers";

/* @invariant THE INSTALLER PRINTS WITH console.log UNLESS EXTENSION_OUTPUT IS
   json OR ndjson, and this server's stdout is the JSON-RPC stream. The switch is set for the call and restored after. */
async function withMachineOutput<T>(run: () => Promise<T>): Promise<T> {
  const previous = process.env.EXTENSION_OUTPUT;
  process.env.EXTENSION_OUTPUT = "json";
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env.EXTENSION_OUTPUT;
    else process.env.EXTENSION_OUTPUT = previous;
  }
}

export async function installManagedBrowser(
  browser: string,
): Promise<string> {
  const start = Date.now();

  try {
    await withMachineOutput(() =>
      extensionInstall({
        browser,
        locateInstalledBinary: (destination, target) =>
          findManagedBinaryIn(destination, target),
      }),
    );

    const destination = path.join(getManagedBrowsersCacheRoot(), browser);
    const binaryPath = findManagedBinaryIn(destination, browser);
    if (!binaryPath) {
      return envelope({
        ok: false,
        command: "extension_browsers",
        status: "install-unconfirmed",
        value: { browser, destination, duration: Date.now() - start },
        error: {
          code: "E_BROWSER_INSTALL",
          message: `The installer returned, but no ${browser} binary is in the managed cache at ${destination}; nothing was installed there.`,
        },
        hint: 'extension_browsers with action: "detect" says which binary a session would launch; a system install may already serve.',
      });
    }

    return envelope({
      ok: true,
      command: "extension_browsers",
      status: "installed",
      value: { browser, binaryPath, duration: Date.now() - start },
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
