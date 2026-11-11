// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

export interface ElementSummary {
  tag: string;
  id?: string;
  name?: string;
  type?: string;
  role?: string;
  text: string;
  disabled: boolean;
  readOnly: boolean;
  editable: boolean;
  visible: boolean;
  rect: { x: number; y: number; width: number; height: number };
}

export interface Point {
  x: number;
  y: number;
}

export type NotEditableReason = "disabled" | "read-only" | "not-a-field" | "no-such-option";

export type PageRead =
  | { invalidSelector: string }
  | { matches: 0 }
  | { matches: number; elements: ElementSummary[] }
  | {
      matches: 1;
      element: ElementSummary;
      text?: string;
      truncated?: boolean;
      notEditable?: NotEditableReason;
      point?: Point;
      covered?: boolean;
      filled?: boolean;
      clicked?: boolean;
      focused?: boolean;
    };

export type ReadFailure =
  | { kind: "no-match"; polls?: number; elapsedMs?: number }
  | { kind: "ambiguous"; matches: number; elements: ElementSummary[] }
  | { kind: "bad-selector"; message: string };

export function unresolved(read: PageRead): ReadFailure | null {
  if ("invalidSelector" in read) return { kind: "bad-selector", message: read.invalidSelector };
  if (read.matches === 0) return { kind: "no-match" };
  if (read.matches > 1 && "elements" in read) return { kind: "ambiguous", matches: read.matches, elements: read.elements };

  return null;
}
