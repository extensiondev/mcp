// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

/* @invariant
 * A WILDCARD PATTERN NEVER BECOMES A CHAIN OF OPEN `.*` RUNS.
 *
 * Joining the pieces of a glob with `.*` makes a regular expression that
 * retries every earlier run when a later piece fails, so a pattern with k
 * stars costs the text's length to the power k, on text a web page or a
 * project file chooses. Each inner piece here is found once, at its
 * leftmost place, inside a lookahead that is read back by reference and
 * never reopened; only the last piece is tied to the end. For pieces of a
 * fixed length (text and single-character wildcards) the leftmost place is
 * always a correct choice, so the answer is the one the open chain gave.
 * The pieces must hold no capture group of their own.
 */
export function joinWildcards(pieces: string[]): string {
  if (pieces.length < 2) return pieces[0] ?? "";

  const inner = pieces.slice(1, -1).filter((piece) => piece !== "");

  return `${pieces[0]}${inner.map((piece, index) => `(?=(.*?${piece}))\\${index + 1}`).join("")}.*${pieces[pieces.length - 1]}`;
}
