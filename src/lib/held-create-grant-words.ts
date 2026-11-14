// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

export const CREATE_IN_PROGRESS_CODE = "CREATE_IN_PROGRESS";

export interface HeldCreateGrant {
  grant: string;
  grantExpiresAt: number;
}

export function grantExpiresAt(data: Record<string, unknown>): number {
  return Number(data.expiresAt || 0) || Math.floor(Date.now() / 1000) + 900;
}

export function heldUntilSentence(held: HeldCreateGrant): string {
  return new Date(held.grantExpiresAt * 1000).toISOString();
}
