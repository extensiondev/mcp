// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

export function parseFrameObject(raw: string): Record<string, any> | null {
  try {
    const parsed: unknown = JSON.parse(raw);

    return parsed !== null && typeof parsed === "object"
      ? (parsed as Record<string, any>)
      : null;
  } catch {
    return null;
  }
}
