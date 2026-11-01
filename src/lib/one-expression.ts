// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (body: string) => unknown;

function parses(make: (body: string) => unknown, source: string): boolean {
  try {
    make(`return (${source}\n)`);

    return true;
  } catch {
    return false;
  }
}

export function isSingleExpression(source: string): boolean {
  return parses((body) => new Function(body), source);
}

export function awaitsAtTopLevel(source: string): boolean {
  return !isSingleExpression(source) && parses((body) => new AsyncFunction(body), source);
}

export function isOneExpression(source: string): boolean {
  return isSingleExpression(source) || awaitsAtTopLevel(source);
}

export function protocolExpression(source: string): string {
  return awaitsAtTopLevel(source) ? `(async () => (${source}\n))()` : source;
}
