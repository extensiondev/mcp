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
    description: "Custom Chromium-based binary (overrides browser)",
  },
  geckoBinary: {
    type: "string",
    description: "Custom Gecko/Firefox binary (overrides browser)",
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
} as const;

export interface LaunchFlagArgs {
  profile?: string;
  startingUrl?: string;
  chromiumBinary?: string;
  geckoBinary?: string;
  host?: string;
  publicHost?: string;
  extensions?: string[];
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
    cli.push("--extensions", args.extensions.join(","));
  return cli;
}
