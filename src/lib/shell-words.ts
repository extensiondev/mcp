// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

const SHELL_SPECIAL = /[\s&;|<>()$`'"\\*?[\]{}!]/;

const EXPANDS_IN_DOUBLE_QUOTES = /[$`"\\!]/;

const SHELL_PLAIN_WORD = /^[A-Za-z0-9_@%+=:,./-]+$/;

function singleQuoted(word: string): string {
  return `'${word.replace(/'/g, "'\\''")}'`;
}

export function shellPath(filePath: string): string {
  return SHELL_PLAIN_WORD.test(filePath) ? filePath : singleQuoted(filePath);
}

export function shellUrl(url: string): string {
  if (!SHELL_SPECIAL.test(url)) return url;

  return EXPANDS_IN_DOUBLE_QUOTES.test(url) ? singleQuoted(url) : `"${url}"`;
}

export function unshellUrl(word: string): string {
  if (word.length > 1 && word.startsWith("'") && word.endsWith("'")) return word.slice(1, -1).replace(/'\\''/g, "'");

  return word.replace(/^["']|["']$/g, "");
}
