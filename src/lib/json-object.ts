// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

export type JsonObjectRead =
  | { value: Record<string, unknown> }
  | { problem: string };

export function parseJsonObject(text: string): JsonObjectRead {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { problem: "not a JSON object" };

    return { value: parsed as Record<string, unknown> };
  } catch (err) {
    return { problem: err instanceof Error ? err.message : String(err) };
  }
}
