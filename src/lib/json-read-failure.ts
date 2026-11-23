// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

/* @invariant THIS FILE IMPORTS NOTHING. The words for a JSON file that
 * failed to read or parse are used by the hosted lane too, which may not
 * load a module that reaches the disk, so the kernel exports them from
 * here. `jsonReadFailure` names the kind of failure and never the parser's
 * message; it adds the line and column only when the caller hands it a
 * reader, which `manifest-path` does for every tool on this machine.
 */
const NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
const WHITESPACE = " \t\n\r";
const ESCAPES = '"\\/bfnrt';

export function jsonErrorOffset(text: string): number | null {
  let at = 0;

  const skip = (): void => {
    while (at < text.length && WHITESPACE.includes(text[at])) at += 1;
  };

  const word = (expected: string): boolean => {
    if (!text.startsWith(expected, at)) return false;

    at += expected.length;

    return true;
  };

  const string = (): boolean => {
    if (text[at] !== '"') return false;

    at += 1;

    while (at < text.length) {
      const char = text[at];

      if (char === '"') {
        at += 1;

        return true;
      }

      if (char < " ") return false;

      if (char !== "\\") {
        at += 1;
        continue;
      }

      const escaped = text[at + 1];

      if (escaped === "u" && /^[0-9a-fA-F]{4}$/.test(text.slice(at + 2, at + 6))) {
        at += 6;
        continue;
      }

      if (escaped === undefined || !ESCAPES.includes(escaped)) return false;

      at += 2;
    }

    return false;
  };

  const members = (close: string, member: () => boolean): boolean => {
    at += 1;
    skip();

    if (text[at] === close) {
      at += 1;

      return true;
    }

    for (;;) {
      skip();

      if (!member()) return false;

      skip();

      if (text[at] === close) {
        at += 1;

        return true;
      }

      if (text[at] !== ",") return false;

      at += 1;
    }
  };

  const value = (): boolean => {
    skip();

    const char = text[at];

    if (char === "{") {
      return members("}", () => {
        if (!string()) return false;

        skip();

        if (text[at] !== ":") return false;

        at += 1;

        return value();
      });
    }

    if (char === "[") return members("]", value);
    if (char === '"') return string();
    if (char === "t") return word("true");
    if (char === "f") return word("false");
    if (char === "n") return word("null");

    NUMBER.lastIndex = at;

    if (!NUMBER.test(text)) return false;

    at = NUMBER.lastIndex;

    return true;
  };

  try {
    if (!value()) return at;

    skip();

    return at < text.length ? at : null;
  } catch {
    return null;
  }
}

export function whereItFails(text: string): string {
  const offset = jsonErrorOffset(text);
  if (offset === null) return "";

  const before = text.slice(0, offset);
  const line = before.split("\n").length;
  const column = offset - before.lastIndexOf("\n");

  return offset >= text.length ? `: it ends before its value is complete, at line ${line}, column ${column}` : ` at line ${line}, column ${column}`;
}

export function failureCode(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;

  return typeof code === "string" && /^[A-Z0-9_]{2,32}$/.test(code) ? code : "read failed";
}

export function jsonReadFailure(err: unknown, file: string, read?: (file: string) => string): string {
  if (!(err instanceof SyntaxError)) {
    const code = failureCode(err);

    return code === "read failed" && err instanceof Error && err.constructor === Error ? err.message : code;
  }

  if (!read) return "not valid JSON";

  try {
    return `not valid JSON${whereItFails(read(file))}`;
  } catch {
    return "not valid JSON";
  }
}
