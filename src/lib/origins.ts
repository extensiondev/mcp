// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { AsyncLocalStorage } from "node:async_hooks";

import { isLocalOrigin, resolveOrigins, type Origins } from "@extension.dev/urls/origins";

import { requestCredential } from "./credential-scope";

const LOCAL_REGISTRY_ROUTE = "/api/local-registry";

const callApi = new AsyncLocalStorage<string>();

function trimmed(value: unknown): string {
  return String(value ?? "").trim().replace(/\/+$/, "");
}

export function withCallApi<T>(api: unknown, run: () => T): T {
  const value = trimmed(api);

  return value ? callApi.run(value, run) : run();
}

export function callTargetApi(): string {
  return callApi.getStore() ?? "";
}

export function effectiveApiBase(apiHint?: string): string {
  return (
    trimmed(apiHint) ||
    callTargetApi() ||
    trimmed(requestCredential()?.api) ||
    trimmed(process.env.EXTENSION_DEV_API_URL)
  );
}

function sameServerClass(a: string, b: string): boolean {
  return isLocalOrigin(a) === isLocalOrigin(b);
}

export function mcpOrigins(apiHint?: string): Origins {
  const www = effectiveApiBase(apiHint) || undefined;
  const envWww = trimmed(process.env.EXTENSION_DEV_API_URL);
  const envSurfaces = !www || !envWww || sameServerClass(www, envWww);
  const fromEnv = (value: string | undefined) => (envSurfaces ? value : undefined);
  const registry = trimmed(fromEnv(process.env.EXTENSION_DEV_REGISTRY_URL)) || undefined;
  const origins = resolveOrigins(
    {
      www,
      console: fromEnv(process.env.EXTENSION_DEV_CONSOLE_URL),
      inspect: fromEnv(process.env.EXTENSION_DEV_INSPECT_URL),
      preview: fromEnv(process.env.EXTENSION_DEV_PREVIEW_URL),
      userland: fromEnv(process.env.EXTENSION_DEV_USERLAND_URL),
      registry,
      media: fromEnv(process.env.EXTENSION_MEDIA_ORIGIN),
    },
    { hint: www },
  );

  if (registry || !www || !isLocalOrigin(www)) return origins;

  return { ...origins, registry: `${origins.www.replace(/\/+$/, "")}${LOCAL_REGISTRY_ROUTE}` };
}
