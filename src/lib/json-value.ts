// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

export type JsonType = "null" | "array" | "object" | "string" | "number" | "boolean";

export function jsonType(value: unknown): JsonType {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";

  return typeof value as JsonType;
}

export function sameJsonValue(a: unknown, b: unknown): boolean {
  const type = jsonType(a);
  if (type !== jsonType(b)) return false;

  if (type === "array") {
    const left = a as unknown[];
    const right = b as unknown[];

    return left.length === right.length && left.every((item, i) => sameJsonValue(item, right[i]));
  }

  if (type === "object") {
    const left = a as Record<string, unknown>;
    const right = b as Record<string, unknown>;
    const keys = Object.keys(left);

    return (
      keys.length === Object.keys(right).length &&
      keys.every((key) => Object.prototype.hasOwnProperty.call(right, key) && sameJsonValue(left[key], right[key]))
    );
  }

  return a === b;
}

export function jsonTextType(text: string): JsonType | null {
  try {
    return jsonType(JSON.parse(text));
  } catch {
    return null;
  }
}
