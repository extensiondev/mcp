// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

const UNSAFE_IN_SCRIPT = /[<>\u2028\u2029]/g;

const ESCAPED: Record<string, string> = {
  "<": "\\u003c",
  ">": "\\u003e",
  "\u2028": "\\u2028",
  "\u2029": "\\u2029",
};

/* @invariant
 * A VALUE WRITTEN INTO GENERATED SCRIPT IS ONE LITERAL, IN ANY CARRIER.
 *
 * JSON.stringify yields a JavaScript literal but leaves `<`, `>` and the
 * two Unicode line separators as they are, so a value can still close a
 * script element or end a line when the script is carried inside markup or
 * read by an older parser. Those four only ever occur inside the string
 * parts of JSON text, where their `\u` form reads back as the same
 * character, so escaping them changes no value.
 */
export function scriptLiteral(value: unknown): string {
  return String(JSON.stringify(value)).replace(UNSAFE_IN_SCRIPT, (char) => ESCAPED[char]!);
}
