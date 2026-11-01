// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

const ENGINE_LINES: Array<[string, RegExp]> = [
  ["enable", /Couldn't finish enabling .+? in Safari: [^\n]+/g],
  ["accessibility", /Can't drive Safari's settings without an Accessibility grant for [^\n]+/g],
  ["webdriver", /No WebDriver session for this run: [^\n]+/g],
];

export interface SafariEngineSays {
  lines: string[];
  accessibility: boolean;
}

function lastMatch(text: string, pattern: RegExp): string | null {
  let found: string | null = null;

  for (const match of text.matchAll(pattern)) found = match[0];

  return found ? found.trim() : null;
}

export function parseSafariEngineSays(log: string): SafariEngineSays {
  const text = log.replace(ANSI, "");
  const lines: string[] = [];
  let accessibility = false;

  for (const [kind, pattern] of ENGINE_LINES) {
    const line = lastMatch(text, pattern);
    if (!line) continue;

    lines.push(line);
    if (kind === "accessibility") accessibility = true;
  }

  return { lines, accessibility };
}
