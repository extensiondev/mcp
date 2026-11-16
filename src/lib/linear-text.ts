// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

export function cutAt(value: string, marks: string): string {
  for (let index = 0; index < value.length; index += 1) {
    if (marks.includes(value.charAt(index))) return value.slice(0, index);
  }

  return value;
}

export function dropTrailing(value: string, marks: string, options: { whitespace?: boolean } = {}): string {
  let end = value.length;

  while (end > 0 && (marks.includes(value.charAt(end - 1)) || (options.whitespace === true && value.charAt(end - 1).trim() === ""))) end -= 1;

  return end === value.length ? value : value.slice(0, end);
}
