// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

const LITERAL = 0;
const ONE = 1;
const CLASS = 2;
const STAR = 3;
const GLOBSTAR = 4;
const FOLDERS_OPEN = 5;
const FOLDERS = 6;

const SLASH = 47;

interface Piece {
  kind: number;
  code: number;
  negated: boolean;
  ranges: number[];
}

const piece = (kind: number, code = 0): Piece => ({ kind, code, negated: false, ranges: [] });

function classPiece(body: string): Piece {
  const negated = body.startsWith("!") || body.startsWith("^");
  const ranges: number[] = [];

  for (let i = negated ? 1 : 0; i < body.length; i += 1) {
    const low = body.charCodeAt(i);

    if (body[i + 1] === "-" && i + 2 < body.length) {
      ranges.push(low, body.charCodeAt(i + 2));
      i += 2;
    } else {
      ranges.push(low, low);
    }
  }

  return { kind: CLASS, code: 0, negated, ranges };
}

function inClass(item: Piece, code: number): boolean {
  for (let i = 0; i < item.ranges.length; i += 2) {
    if (code >= item.ranges[i]! && code <= item.ranges[i + 1]!) return !item.negated;
  }

  return item.negated;
}

function wellFormed(body: string): boolean {
  for (let i = body.startsWith("!") || body.startsWith("^") ? 1 : 0; i < body.length; i += 1) {
    if (body[i + 1] === "-" && i + 2 < body.length) {
      if (body.charCodeAt(i) > body.charCodeAt(i + 2)) return false;

      i += 2;
    }
  }

  return true;
}

function push(pieces: Piece[], next: Piece): void {
  const last = pieces[pieces.length - 1];
  const open = last && (last.kind === STAR || last.kind === GLOBSTAR);
  const folders = last && last.kind === FOLDERS;

  if (next.kind === STAR && open) return;

  if (next.kind === GLOBSTAR) {
    if (last && last.kind === GLOBSTAR) return;

    if (open) {
      last.kind = GLOBSTAR;

      return;
    }

    if (folders) {
      pieces.length -= 2;
      push(pieces, next);

      return;
    }
  }

  if (next.kind === FOLDERS_OPEN) {
    if (folders || (last && last.kind === GLOBSTAR)) return;

    pieces.push(next, piece(FOLDERS));

    return;
  }

  pieces.push(next);
}

function piecesOf(pattern: string): Piece[] | null {
  const pieces: Piece[] = [];

  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i]!;

    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        if (pattern[i + 2] === "/") {
          push(pieces, piece(FOLDERS_OPEN));
          i += 2;
        } else {
          push(pieces, piece(GLOBSTAR));
          i += 1;
        }
      } else {
        push(pieces, piece(STAR));
      }
    } else if (ch === "?") {
      push(pieces, piece(ONE));
    } else if (ch === "[") {
      const end = pattern.indexOf("]", i + 1);

      if (end > i + 1) {
        const body = pattern.slice(i + 1, end);
        if (!wellFormed(body)) return null;

        push(pieces, classPiece(body));
        i = end;
      } else {
        push(pieces, piece(LITERAL, ch.charCodeAt(0)));
      }
    } else if (ch === "\\" && i + 1 < pattern.length) {
      push(pieces, piece(LITERAL, pattern.charCodeAt(i + 1)));
      i += 1;
    } else {
      push(pieces, piece(LITERAL, ch.charCodeAt(0)));
    }
  }

  return pieces;
}

function walker(pieces: Piece[]): (subject: string, from: number, anchored: boolean) => boolean {
  const end = pieces.length;
  const seen = new Uint32Array(end + 1);
  let stamp = 0;
  let here: number[] = [];
  let next: number[] = [];

  const enter = (start: number, into: number[]): void => {
    let at = start;

    while (seen[at] !== stamp) {
      seen[at] = stamp;
      into.push(at);
      if (at === end) return;

      const kind = pieces[at]!.kind;

      if (kind === STAR || kind === GLOBSTAR) {
        at += 1;
      } else if (kind === FOLDERS_OPEN) {
        if (seen[at + 1] !== stamp) {
          seen[at + 1] = stamp;
          into.push(at + 1);
        }

        at += 2;
      } else {
        return;
      }
    }
  };

  const turn = (): void => {
    stamp += 1;

    if (stamp > 0xfffffff0) {
      seen.fill(0);
      stamp = 1;
    }
  };

  return (subject, from, anchored) => {
    here.length = 0;
    turn();
    enter(0, here);

    for (let i = from; i < subject.length; i += 1) {
      const code = subject.charCodeAt(i);

      next.length = 0;
      turn();

      for (const at of here) {
        if (at === end) continue;

        const item = pieces[at]!;

        if (item.kind === LITERAL) {
          if (code === item.code) enter(at + 1, next);
        } else if (item.kind === ONE) {
          if (code !== SLASH) enter(at + 1, next);
        } else if (item.kind === CLASS) {
          if (inClass(item, code)) enter(at + 1, next);
        } else if (item.kind === STAR) {
          if (code !== SLASH) enter(at, next);
        } else if (item.kind === GLOBSTAR) {
          enter(at, next);
        } else if (item.kind === FOLDERS) {
          if (seen[at] !== stamp) {
            seen[at] = stamp;
            next.push(at);
          }

          if (code === SLASH) enter(at + 1, next);
        }
      }

      if (!anchored && code === SLASH) enter(0, next);

      [here, next] = [next, here];
      if (here.length === 0 && (anchored || subject.indexOf("/", i + 1) < 0)) return false;
    }

    return seen[end] === stamp;
  };
}

function literalRun(pieces: Piece[], from: number, step: number): string {
  let run = "";

  for (let i = from; i >= 0 && i < pieces.length && pieces[i]!.kind === LITERAL; i += step) {
    run = step > 0 ? run + String.fromCharCode(pieces[i]!.code) : String.fromCharCode(pieces[i]!.code) + run;
  }

  return run;
}

function staysInOneSegment(item: Piece): boolean {
  if (item.kind === LITERAL) return item.code !== SLASH;
  if (item.kind === CLASS) return !inClass(item, SLASH);

  return item.kind === ONE || item.kind === STAR;
}

export function ignoreGlobMatcher(pattern: string, anchored: boolean): (subject: string) => boolean {
  const pieces = piecesOf(pattern);
  if (!pieces) return () => false;

  const head = literalRun(pieces, 0, 1);

  if (head.length === pieces.length) {
    if (anchored) return (subject) => subject === head;

    return (subject) => subject.endsWith(head) && (subject.length === head.length || subject.charCodeAt(subject.length - head.length - 1) === SLASH);
  }

  const tail = literalRun(pieces, pieces.length - 1, -1);
  const walk = walker(pieces);

  if (!anchored && pieces.every(staysInOneSegment)) {
    const open = pieces.length === head.length + tail.length + 1 && pieces[head.length]!.kind === STAR;
    const least = head.length + tail.length;

    return (subject) => {
      if (!subject.endsWith(tail)) return false;

      const from = subject.lastIndexOf("/") + 1;
      if (!subject.startsWith(head, from)) return false;

      return open ? subject.length - from >= least : walk(subject, from, true);
    };
  }

  return (subject) => {
    if (!subject.endsWith(tail)) return false;
    if (anchored && !subject.startsWith(head)) return false;

    return walk(subject, 0, anchored);
  };
}
