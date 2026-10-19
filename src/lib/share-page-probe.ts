// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { sawPlatformHold } from "./platform-hold";

type FetchImpl = typeof fetch;

const PROBE_TIMEOUT_MS = 4_000;

export interface SharePageVerdict {
  url: string;
  status: number;
  held: boolean;
  retryAfter: string | null;
}

async function ask(url: string, method: "HEAD" | "GET", doFetch: FetchImpl): Promise<Response> {
  return doFetch(url, { method, redirect: "follow", signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
}

export async function probeSharePage(url: string, fetchImpl?: FetchImpl): Promise<SharePageVerdict | null> {
  const doFetch = fetchImpl ?? fetch;

  try {
    let res = await ask(url, "HEAD", doFetch);
    if (res.status === 405 || res.status === 501) res = await ask(url, "GET", doFetch);

    const retryAfter = res.headers.get("retry-after");
    const held = res.status === 503 || sawPlatformHold(res) || (res.status >= 400 && Boolean(retryAfter));

    return { url, status: res.status, held, retryAfter };
  } catch {
    return null;
  }
}
