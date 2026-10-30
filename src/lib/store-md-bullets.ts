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

export const STORE_OWN_LINES_PLACE =
  "under `## Chrome Web Store`, at the top of the section or under any of its `###` sub-headings";

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

const SUBSECTION = /^###\s+(.*)$/;

const JUSTIFICATION_SUBSECTION = /^permission/i;

/* @invariant A STORE SECTION'S OWN LINES ARE READ ANYWHERE INSIDE IT. The
 * Hands-free STORE.md carried `- Visibility: unlisted` under a
 * `### Visibility` sub-heading of `## Chrome Web Store` and the reader took
 * only the lines above the first `###`, so the preflight said the file had
 * no such line (ledger 303). Every `- Key:` line of the section is read now,
 * at its top or under any of its sub-headings, except the bullets of a
 * `### Permissions justification` sub-section, which are permissions and
 * their reasons, never listing lines.
 */
export function storeOwnLinesBody(body: string): string {
  const kept: string[] = [];
  let skipping = false;

  for (const line of body.split("\n")) {
    const heading = SUBSECTION.exec(line);

    if (heading) {
      skipping = JUSTIFICATION_SUBSECTION.test(heading[1]!.trim());
      continue;
    }

    if (!skipping) kept.push(line);
  }

  return kept.join("\n");
}
