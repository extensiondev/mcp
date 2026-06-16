import { extensionInstall } from "extension-install";

export const schema = {
  name: "extension_install_browser",
  description:
    "Install a managed browser binary for extension testing. Useful in CI, Docker, or fresh environments where browsers are not pre-installed.",
  inputSchema: {
    type: "object" as const,
    properties: {
      browser: {
        type: "string",
        enum: ["chrome", "chromium", "edge", "firefox"],
        description: "Browser to install",
      },
    },
    required: ["browser"],
  },
};

export async function handler(args: { browser: string }): Promise<string> {
  const start = Date.now();

  try {
    await extensionInstall({ browser: args.browser });

    return JSON.stringify({
      status: "installed",
      browser: args.browser,
      duration: Date.now() - start,
      hint: `Browser "${args.browser}" is now available. Use extension_dev or extension_start with --browser=${args.browser}.`,
    });
  } catch (err) {
    return JSON.stringify({
      status: "error",
      browser: args.browser,
      message: err instanceof Error ? err.message : String(err),
      duration: Date.now() - start,
      hint:
        args.browser === "edge"
          ? "Edge installation on Linux may require elevated privileges. Try using Chrome or Chromium instead."
          : "Check network connectivity and disk space. You can also install browsers manually.",
    });
  }
}
