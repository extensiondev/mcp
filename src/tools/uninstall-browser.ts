// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { extensionUninstall } from "extension-install";
import { envelope } from "../lib/envelope";

export async function uninstallManagedBrowser(args: {
  browser?: string;
  all?: boolean;
}): Promise<string> {
  const start = Date.now();

  if (!args.browser && !args.all) {
    return envelope({
      ok: false,
      command: "extension_browsers",
      status: "bad-request",
      error: {
        code: "E_BAD_REQUEST",
        message: "Provide a browser to remove, or set all: true.",
      },
    });
  }

  try {
    await extensionUninstall({ browser: args.browser, all: args.all });

    return envelope({
      ok: true,
      command: "extension_browsers",
      status: "uninstalled",
      value: {
        target: args.all ? "all" : args.browser,
        duration: Date.now() - start,
      },
      hint: 'Use extension_browsers with action: "list" to confirm what remains in the managed cache.',
    });
  } catch (err) {
    return envelope({
      ok: false,
      command: "extension_browsers",
      status: "uninstall-failed",
      value: {
        target: args.all ? "all" : args.browser,
        duration: Date.now() - start,
      },
      error: {
        code: "E_BROWSER_UNINSTALL",
        message: err instanceof Error ? err.message : String(err),
      },
    });
  }
}
