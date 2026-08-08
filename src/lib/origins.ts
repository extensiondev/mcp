// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { resolveOrigins, type Origins } from "@extension.dev/urls/origins";

export function mcpOrigins(apiHint?: string): Origins {
  const www =
    String(apiHint || process.env.EXTENSION_DEV_API_URL || "").trim() || undefined;
  return resolveOrigins(
    {
      www,
      console: process.env.EXTENSION_DEV_CONSOLE_URL,
      inspect: process.env.EXTENSION_DEV_INSPECT_URL,
      preview: process.env.EXTENSION_DEV_PREVIEW_URL,
      userland: process.env.EXTENSION_DEV_USERLAND_URL,
      registry: process.env.EXTENSION_DEV_REGISTRY_URL,
      media: process.env.EXTENSION_MEDIA_ORIGIN,
    },
    { hint: www },
  );
}
