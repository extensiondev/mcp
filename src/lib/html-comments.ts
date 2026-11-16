// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

const COMMENT_OPEN = "<!--";

const COMMENT_CLOSE = "-->";

export function stripHtmlComments(value: string): string {
  if (!value.includes(COMMENT_OPEN)) return value;

  const kept: string[] = [];
  let open = -1;
  let index = 0;

  while (index < value.length) {
    if (open !== -1 && value.startsWith(COMMENT_CLOSE, index)) {
      kept.length = open;
      open = -1;
      index += COMMENT_CLOSE.length;
      continue;
    }

    kept.push(value.charAt(index));
    index += 1;

    const size = kept.length;

    if (open === -1 && size >= 4 && kept[size - 1] === "-" && kept[size - 2] === "-" && kept[size - 3] === "!" && kept[size - 4] === "<") open = size - 4;
  }

  return kept.join("");
}
