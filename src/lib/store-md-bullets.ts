// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

export interface BulletLine {
  key: string;
  value: string;
}

export const HOST_BULLET_EXAMPLE = "`- *://*/*: Asked for one site at a time when the user allows it; nothing at install.`";

export const HOST_BULLET_FORM = `one bullet per host pattern, keyed by the pattern as the manifest spells it, for example ${HOST_BULLET_EXAMPLE}`;

const BULLET = /^- +(.{1,80}?):(?:\s+(.*))?$/;

const WRAPPED = /^(["'`])(.*)\1$/;

export function stripQuotes(value: string): string {
  const trimmed = value.trim();
  const wrapped = WRAPPED.exec(trimmed);

  return wrapped ? wrapped[2]!.trim() : trimmed;
}

/* @invariant A BULLET'S KEY ENDS AT THE FIRST COLON FOLLOWED BY SPACE OR THE
 * LINE'S END. A host pattern is a key (the all-hosts pattern or
 * `https://*.example.com` and its path), and every host pattern holds `://`,
 * so a key that could hold no colon dropped the whole line and the host
 * justification Chrome asks for could never be written (ledger 302). The
 * key is read up to the first `: ` or a `:` that ends the line (a
 * `- Description:` whose paragraphs follow), stripped of the backticks or
 * quotes an author wraps a pattern in, and capped at 80 characters as before.
 */
export function bulletLine(line: string): BulletLine | null {
  const bullet = BULLET.exec(line);
  if (!bullet) return null;

  return { key: stripQuotes(bullet[1]!), value: (bullet[2] ?? "").trim() };
}

