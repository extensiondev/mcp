// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

export const PLATFORM_READ_TIMEOUT_MS = 15_000;
export const PLATFORM_DISPATCH_TIMEOUT_MS = 60_000;

export type PlatformFetchKind = "read" | "dispatch";

export type UnreachedKind = "timeout" | "refused" | "dns" | "network";

export interface PlatformUnreached {
  kind: UnreachedKind;
  message: string;
}

export type PlatformFetchResult = { ok: true; res: Response } | { ok: false; unreached: PlatformUnreached };

export interface PlatformFetchOptions {
  kind?: PlatformFetchKind;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

export function platformBoundMs(kind: PlatformFetchKind): number {
  return kind === "dispatch" ? PLATFORM_DISPATCH_TIMEOUT_MS : PLATFORM_READ_TIMEOUT_MS;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function causeCode(err: unknown): string {
  const seen = new Set<unknown>();
  let current: unknown = err;

  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && code) return code;

    current = (current as { cause?: unknown }).cause;
  }

  return "";
}

const DNS_CODES = new Set(["ENOTFOUND", "EAI_AGAIN", "EAI_NONAME", "EAI_FAIL"]);
const REFUSED_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "EHOSTUNREACH", "ENETUNREACH"]);

export function unreachedBy(url: string, err: unknown, boundMs: number): PlatformUnreached {
  const name = err instanceof Error ? err.name : "";
  const code = causeCode(err);
  const host = hostOf(url);
  const said = err instanceof Error ? err.message : String(err);

  if (name === "TimeoutError" || code === "UND_ERR_CONNECT_TIMEOUT" || code === "UND_ERR_HEADERS_TIMEOUT") {
    return { kind: "timeout", message: `could not reach ${url}: the platform did not answer within ${Math.round(boundMs / 1000)} s` };
  }

  if (DNS_CODES.has(code)) {
    return { kind: "dns", message: `could not reach ${url}: ${host} could not be resolved (DNS ${code})` };
  }

  if (REFUSED_CODES.has(code)) {
    return { kind: "refused", message: `could not reach ${url}: the connection was refused by ${host} (${code})` };
  }

  return { kind: "network", message: `could not reach ${url}: ${code ? `${code}, ` : ""}${said}` };
}

/* @invariant ONE BOUNDED FETCH PER PLATFORM CALL, AND THE BOUND IS THIS
 * SERVER'S OWN TIMER. A read is given 15 s and a write that dispatches 60 s;
 * nothing here retries, so a call lasts at most one bound past whatever its
 * own timeout input allows. The bound is a setTimeout of this module raced
 * against the fetch, not only an AbortSignal handed to fetch, so a fetch
 * that never settles still answers at the bound, and the answer names what
 * was hit: the platform not answering, the connection refused, or DNS. The
 * 385 s `extension_builds list` of ledger 148 was none of these: the Mac
 * slept at 14:15:35 -03 for 388 s (pmset log), the call left at 14:15:37,
 * and the 20 s abort timer ran on the 14:22:03 lid wake before the socket
 * could, so the answer was a timeout stamped with the whole nap.
 */
export async function platformFetch(url: string, init: RequestInit, options: PlatformFetchOptions = {}): Promise<PlatformFetchResult> {
  const kind = options.kind ?? "read";
  const boundMs = platformBoundMs(kind);
  const doFetch = options.fetchImpl ?? globalThis.fetch;
  const controller = new AbortController();
  const bound = new DOMException(`The platform did not answer within ${Math.round(boundMs / 1000)} s`, "TimeoutError");
  let timer: ReturnType<typeof setTimeout> | undefined;
  let rejectBound: ((reason: unknown) => void) | undefined;

  const expired = new Promise<never>((_resolve, reject) => {
    rejectBound = reject;
    timer = setTimeout(() => {
      controller.abort(bound);
      reject(bound);
    }, boundMs);

    timer.unref?.();
  });

  const onOuterAbort = () => {
    controller.abort(options.signal?.reason);
    rejectBound?.(options.signal?.reason ?? new DOMException("The call was abandoned", "AbortError"));
  };

  if (options.signal?.aborted) onOuterAbort();
  else options.signal?.addEventListener("abort", onOuterAbort, { once: true });

  try {
    const res = await Promise.race([doFetch(url, { ...init, signal: controller.signal }), expired]);

    return { ok: true, res };
  } catch (err) {
    return { ok: false, unreached: unreachedBy(url, err, boundMs) };
  } finally {
    if (timer !== undefined) clearTimeout(timer);

    options.signal?.removeEventListener("abort", onOuterAbort);
  }
}
