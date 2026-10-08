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
    const answer = await extensionUninstall({ browser: args.browser, all: args.all });
    const rows: Array<{ browser: string; removed: boolean; path: string }> = Array.isArray(answer)
      ? (answer as unknown[]).flatMap((row) => {
          const r = row as { browser?: unknown; removed?: unknown; path?: unknown } | null;

          return r && typeof r === "object" && typeof r.removed === "boolean"
            ? [{ browser: String(r.browser ?? ""), removed: r.removed, path: String(r.path ?? "") }]
            : [];
        })
      : [];
    const removed = rows.filter((row) => row.removed).map((row) => row.browser);
    const absent = rows.filter((row) => !row.removed).map((row) => row.browser);
    const status =
      rows.length === 0
        ? "uninstall-unconfirmed"
        : removed.length === 0
          ? "not-installed"
          : absent.length > 0
            ? "uninstalled-partially"
            : "uninstalled";

    return envelope({
      ok: rows.length > 0,
      command: "extension_browsers",
      status,
      value: {
        target: args.all ? "all" : args.browser,
        removed,
        notInstalled: absent,
        results: rows,
        duration: Date.now() - start,
      },
      ...(rows.length === 0
        ? {
            error: {
              code: "E_BROWSER_UNINSTALL",
              message: "The uninstaller returned no per-browser result, so nothing is known to have been removed.",
            },
          }
        : {}),
      hint:
        status === "not-installed"
          ? `${absent.join(", ")} ${absent.length === 1 ? "was" : "were"} not installed in the managed cache, so nothing was removed.`
          : status === "uninstalled-partially"
            ? `Removed ${removed.join(", ")}; ${absent.join(", ")} ${absent.length === 1 ? "was" : "were"} not installed.`
            : 'Use extension_browsers with action: "list" to confirm what remains in the managed cache.',
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
