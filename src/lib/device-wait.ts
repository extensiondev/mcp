// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

export const DEVICE_WAIT_MAX_SECONDS = 900;

const DEVICE_CODE_LIFE_SECONDS = 900;

const expiries = new Map<string, string>();

export function rememberCodeExpiry(deviceCode: string, expiresAt: string): void {
  if (deviceCode && expiresAt) expiries.set(deviceCode, expiresAt);
}

export function forgetCodeExpiry(deviceCode: string): void {
  expiries.delete(deviceCode);
}

export function codeExpiresAt(deviceCode: string): string | null {
  return expiries.get(deviceCode) ?? null;
}

export function codeExpiryFromStart(expiresInSeconds: number, now = Date.now()): string {
  return new Date(now + expiresInSeconds * 1000).toISOString();
}

export function secondsLeft(expiresAt: string | null | undefined, now = Date.now()): number | null {
  const at = expiresAt ? Date.parse(expiresAt) : Number.NaN;
  if (!Number.isFinite(at)) return null;

  return Math.max(0, Math.ceil((at - now) / 1000));
}

export function askedWait(raw: unknown): number | null {
  if (raw === undefined || raw === null || raw === "") return null;

  const n = typeof raw === "string" ? Number(raw) : raw;
  if (typeof n !== "number" || !Number.isFinite(n)) return null;

  return Math.min(DEVICE_WAIT_MAX_SECONDS, Math.max(0, Math.floor(n)));
}

export interface DeviceWait {
  waiting: boolean;
  bound: number;
  budgetMs: number;
  startedAt: number;
}

export function deviceWait(args: {
  waitSeconds: unknown;
  expiresAt?: string | null;
  fallbackMs: number;
}): DeviceWait {
  const startedAt = Date.now();
  const asked = askedWait(args.waitSeconds);

  if (asked === null) return { waiting: false, bound: 0, budgetMs: args.fallbackMs, startedAt };

  const left = secondsLeft(args.expiresAt, startedAt);
  const bound = left === null ? asked : Math.min(asked, left);

  return { waiting: true, bound, budgetMs: bound * 1000, startedAt };
}

export function waitedSeconds(wait: DeviceWait): number {
  return Math.round((Date.now() - wait.startedAt) / 1000);
}

export function waitValue(wait: DeviceWait, expiresAt: string | null): Record<string, unknown> {
  const left = secondsLeft(expiresAt);

  return {
    ...(wait.waiting ? { waitedSeconds: waitedSeconds(wait) } : {}),
    ...(expiresAt ? { expiresAt } : {}),
    ...(left !== null ? { expiresInSeconds: left } : {}),
  };
}

function clock(expiresAt: string): string {
  return `${expiresAt.slice(11, 16)} UTC`;
}

export function resumeWaitSentence(tool: string, expiresAt: string | null, extra = ""): string {
  const left = secondsLeft(expiresAt);
  const bound = left === null ? DEVICE_WAIT_MAX_SECONDS : Math.min(DEVICE_WAIT_MAX_SECONDS, left);

  return `Show the link, then call ${tool} again with this deviceCode${extra} and waitSeconds: ${bound} so that one call blocks until the owner approves and answers the result${
    left === null ? "" : ` (the code lives until ${clock(expiresAt as string)}, ${left} s from now)`
  }.`;
}

export function waitRanOutSentence(args: {
  tool: string;
  wait: DeviceWait;
  expiresAt: string | null;
  extra?: string;
}): string {
  const waited = waitedSeconds(args.wait);
  const left = secondsLeft(args.expiresAt);
  const again = `call ${args.tool} again with this deviceCode${args.extra ?? ""} and waitSeconds`;

  if (left === null) {
    return `Waited ${waited} s and the owner has not approved yet. The code lives ${DEVICE_CODE_LIFE_SECONDS / 60} minutes from the first call; ${again}: ${DEVICE_WAIT_MAX_SECONDS} to keep waiting in one call, or 0 to read once.`;
  }

  if (left === 0) {
    return `Waited ${waited} s and the owner has not approved; the code's life (until ${clock(args.expiresAt as string)}) is over, so the next read answers expired. A new code is needed: call ${args.tool} again without deviceCode.`;
  }

  return `Waited ${waited} s and the owner has not approved yet. The code is still live for ${left} s (until ${clock(args.expiresAt as string)}); ${again}: ${Math.min(DEVICE_WAIT_MAX_SECONDS, left)} to keep waiting in one call, or 0 to read once.`;
}

export function expiredSentence(tool: string, said: string, extra = ""): string {
  return `${said ? `${said} ` : ""}The code is dead and the approval with it, so a new code is needed: call ${tool} again without deviceCode${extra}, show the owner the new link, and resume with waitSeconds so the approval is read in the same call.`;
}

export function firstCallWaitWarning(tool: string, bound: number): string {
  return `waitSeconds applies to the call that carries deviceCode: this first answer carries the link and code so the owner can open them, so it was not held for ${bound} s. Show the link, then call ${tool} again with this deviceCode and waitSeconds to block until the owner approves.`;
}

export function deviceWaitDescription(tool: string, result: string): string {
  return `How long, in seconds, a call that carries deviceCode blocks while it polls the approval: 0 to ${DEVICE_WAIT_MAX_SECONDS}, clamped to the code's remaining life, polling on the interval the platform set (longer when it answers slow_down). It answers ${result} in the same call the moment the owner approves, authorization-pending with waitedSeconds, expiresAt and expiresInSeconds when the bound passes first, and expired when the code dies meanwhile. 0 reads once. Left out, the call reads for a few seconds as before. The first call (no deviceCode) never blocks: it answers the link and code for the owner to open, then ${tool} is called again with deviceCode and waitSeconds.`;
}
