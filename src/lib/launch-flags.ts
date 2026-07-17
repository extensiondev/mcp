// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// MIT License (c) Cezar Augusto and the extension.dev collaborators

// Browser-launch flags shared by extension_dev, extension_start, and
// extension_preview. Mirrors the engine CLI surface so agents can drive
// profiles, custom binaries, and Docker-style host splits.

export const LAUNCH_FLAG_SCHEMA = {
  profile: {
    type: "string",
    description:
      'Browser profile path, or "false" to reuse the default user profile. Omit for a fresh throwaway profile.',
  },
  startingUrl: {
    type: "string",
    description: "URL the browser opens on launch",
  },
  chromiumBinary: {
    type: "string",
    description: "Path to a custom Chromium-based binary (overrides browser)",
  },
  geckoBinary: {
    type: "string",
    description: "Path to a custom Gecko/Firefox binary (overrides browser)",
  },
  host: {
    type: "string",
    description:
      "Dev server bind host. Use 0.0.0.0 for Docker or devcontainers. Defaults to 127.0.0.1",
  },
  publicHost: {
    type: "string",
    description:
      "Connectable host the browser dials for HMR and reload when it differs from the bind host",
  },
  extensions: {
    type: "array",
    items: { type: "string" },
    description:
      "Companion extension paths or store URLs to load alongside the project",
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
