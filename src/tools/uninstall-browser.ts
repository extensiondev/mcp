// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { extensionUninstall } from "extension-install";

export async function uninstallManagedBrowser(args: {
  browser?: string;
  all?: boolean;
}): Promise<string> {
  const start = Date.now();

  if (!args.browser && !args.all) {
    return JSON.stringify({
      status: "error",
      message: "Provide a browser to remove, or set all: true.",
    });
  }

  try {
    await extensionUninstall({ browser: args.browser, all: args.all });

    return JSON.stringify({
      status: "uninstalled",
      target: args.all ? "all" : args.browser,
      duration: Date.now() - start,
      hint: 'Use extension_browsers with action: "list" to confirm what remains in the managed cache.',
    });
  } catch (err) {
    return JSON.stringify({
      status: "error",
      target: args.all ? "all" : args.browser,
      message: err instanceof Error ? err.message : String(err),
      duration: Date.now() - start,
    });
  }
}
