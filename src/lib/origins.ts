// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { isLocalOrigin, resolveOrigins, type Origins } from "@extension.dev/urls/origins";

import { requestCredential } from "./credential-scope";

const LOCAL_REGISTRY_ROUTE = "/api/local-registry";

export function mcpOrigins(apiHint?: string): Origins {
  const www =
    String(apiHint || requestCredential()?.api || process.env.EXTENSION_DEV_API_URL || "").trim() || undefined;

  const registry = String(process.env.EXTENSION_DEV_REGISTRY_URL || "").trim() || undefined;
  const origins = resolveOrigins(
    {
      www,
      console: process.env.EXTENSION_DEV_CONSOLE_URL,
      inspect: process.env.EXTENSION_DEV_INSPECT_URL,
      preview: process.env.EXTENSION_DEV_PREVIEW_URL,
      userland: process.env.EXTENSION_DEV_USERLAND_URL,
      registry,
      media: process.env.EXTENSION_MEDIA_ORIGIN,
    },
    { hint: www },
  );

  if (registry || !www || !isLocalOrigin(www)) return origins;

  return { ...origins, registry: `${origins.www.replace(/\/+$/, "")}${LOCAL_REGISTRY_ROUTE}` };
}
