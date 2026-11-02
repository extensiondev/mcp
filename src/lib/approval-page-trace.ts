// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

export interface ApprovalPageTrace {
  openedAt: string | null;
  openedBy?: string;
  openCount: number;
  signedOutAt?: string;
}

const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

export function readPageTrace(raw: unknown): ApprovalPageTrace | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;

  const row = raw as Record<string, unknown>;
  const openedAt = text(row.openedAt);
  const openedBy = text(row.openedBy);
  const signedOutAt = text(row.signedOutAt);
  const count = Number(row.openCount);

  return {
    openedAt: openedAt || null,
    ...(openedBy ? { openedBy } : {}),
    openCount: Number.isFinite(count) && count > 0 ? Math.floor(count) : 0,
    ...(signedOutAt ? { signedOutAt } : {}),
  };
}

export function pageTraceSentence(trace: ApprovalPageTrace | null): string {
  if (!trace) return "";

  const signedOut = trace.signedOutAt ? ` It was last shown signed out at ${trace.signedOutAt}.` : "";

  if (!trace.openedAt) {
    return ` Nobody has had the approval page open while signed in since it was asked for.${signedOut} If the person says they approved it, the click never reached the platform: ask them to open the link, sign in if asked, and press Approve.`;
  }

  const who = trace.openedBy ? ` by ${trace.openedBy}` : "";
  const times = trace.openCount > 1 ? ` (${trace.openCount} times)` : "";

  return ` The approval page was last open${who} at ${trace.openedAt}${times}, and no decision was recorded.${signedOut} If the person says they approved it, the click did not count: ask them to open the link again and press Approve.`;
}
