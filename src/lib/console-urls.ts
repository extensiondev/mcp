// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { consoleProjectPath } from "@extension.dev/urls/paths";

import { mcpOrigins } from "./origins";

import type { ProjectRef } from "./registry";

export function consoleBase(apiHint?: string): string {
  return mcpOrigins(apiHint).console;
}

export function consoleProjectUrl(
  ref: ProjectRef | null,
  page: string,
  apiHint?: string,
): string {
  const base = consoleBase(apiHint);
  if (!ref) return base;

  return `${base}${consoleProjectPath(ref, page)}`;
}
