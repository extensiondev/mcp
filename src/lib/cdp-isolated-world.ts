// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

export interface ExecutionContextDescription {
  id: number;
  origin?: string;
  name?: string;
  uniqueId?: string;
  auxData?: { isDefault?: boolean; type?: string; frameId?: string };
}

export function extensionIsolatedContexts(
  contexts: ExecutionContextDescription[],
  extensionId: string,
  frameId: string,
): ExecutionContextDescription[] {
  const origin = `chrome-extension://${extensionId}`;

  return contexts.filter(
    (context) =>
      context.auxData?.type === "isolated" &&
      context.auxData.frameId === frameId &&
      typeof context.origin === "string" &&
      context.origin.replace(/\/$/, "") === origin,
  );
}

export function executionContextFrom(message: Record<string, unknown>, sessionId: string): ExecutionContextDescription | null {
  if (message.method !== "Runtime.executionContextCreated") return null;
  if (message.sessionId !== undefined && message.sessionId !== sessionId) return null;

  const context = (message.params as { context?: unknown } | undefined)?.context as ExecutionContextDescription | undefined;

  return context && typeof context.id === "number" ? context : null;
}
