// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

export const LAUNCH_FLAG_SCHEMA = {
  profile: {
    type: "string",
    description:
      'Profile path, or "false" to reuse the real user profile. Omit for a throwaway one.',
  },
  startingUrl: {
    type: "string",
    description: "URL the browser opens on launch",
  },
  chromiumBinary: {
    type: "string",
    description: "Custom Chromium-based binary to launch; `browser` still names the target family the engine builds for (chromium-based when none is given).",
  },
  geckoBinary: {
    type: "string",
    description: "Custom Gecko/Firefox binary to launch; `browser` still names the target family the engine builds for (gecko-based when none is given).",
  },
  host: {
    type: "string",
    description:
      "Bind host, default 127.0.0.1. Use 0.0.0.0 in Docker or devcontainers.",
  },
  publicHost: {
    type: "string",
    description:
      "Host the browser dials for HMR and reload when it differs from the bind host",
  },
  extensions: {
    type: "array",
    items: { type: "string" },
    description:
      "Extra extension paths or store URLs to load alongside the project",
  },
  headless: {
    type: "boolean",
    description:
      "false opens a browser window the person can see, overriding EXTENSION_HEADLESS and any --headless in EXTENSION_BROWSER_FLAGS for this session only; pass it when the person wants to watch or try the extension. true forces headless. Omit to inherit the environment (headless when EXTENSION_HEADLESS=1 or EXTENSION_BROWSER_FLAGS carries --headless).",
  },
} as const;

export interface LaunchFlagArgs {
  profile?: string;
  startingUrl?: string;
  chromiumBinary?: string;
  geckoBinary?: string;
  host?: string;
  publicHost?: string;
  extensions?: string[];
  headless?: boolean;
}

const HEADLESS_FLAG = /(^|\s)-{1,2}headless(=\S*)?(?=\s|$)/gi;

export function envIsHeadless(env: NodeJS.ProcessEnv | Record<string, string | undefined>): boolean {
  if (/^(1|true)$/i.test(env.EXTENSION_HEADLESS ?? "")) return true;

  return /(^|\s|=)-{1,2}headless\b/i.test(env.EXTENSION_BROWSER_FLAGS ?? "");
}

export function headlessLaunch(
  args: { headless?: boolean },
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): { headless: boolean; env?: Record<string, string> } {
  if (args.headless === true) return { headless: true, env: { EXTENSION_HEADLESS: "1" } };

  if (args.headless === false) {
    const flags = (env.EXTENSION_BROWSER_FLAGS ?? "").replace(HEADLESS_FLAG, " ").replace(/\s+/g, " ").trim();

    return { headless: false, env: { EXTENSION_HEADLESS: "0", EXTENSION_BROWSER_FLAGS: flags } };
  }

  return { headless: envIsHeadless(env) };
}

export function headlessHint(headless: boolean): string {
  return headless
    ? "The browser is headless, so it is not visible to the person: do not tell them it is open on their screen. When they want to see or try the extension, call this tool again with headless: false and replace: true, which opens a window they can see."
    : "The browser window is visible to the person.";
}

export function launchFlagArgs(args: LaunchFlagArgs): string[] {
  const cli: string[] = [];
  if (args.profile !== undefined) cli.push("--profile", args.profile);
  if (args.startingUrl) cli.push("--starting-url", args.startingUrl);
  if (args.chromiumBinary) cli.push("--chromium-binary", args.chromiumBinary);
  if (args.geckoBinary) cli.push("--gecko-binary", args.geckoBinary);
  if (args.host) cli.push("--host", args.host);
  if (args.publicHost) cli.push("--public-host", args.publicHost);

  if (args.extensions?.length)
    {cli.push("--extensions", args.extensions.join(","));}

  return cli;
}
