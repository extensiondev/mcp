// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { sawPlatformHold } from "./platform-hold";

type FetchImpl = typeof fetch;

const MAX_HOPS = 4;

export interface ShareCorsVerdict {
  ok: boolean;
  checkedUrl: string;
  origin: string;
  finalUrl: string;
  finalStatus: number;
  redirects: number;
  allowOrigin: string | null;
  held: boolean;
  reason: string;
}

function allows(allowOrigin: string | null, origin: string): boolean {
  if (!allowOrigin) return false;

  const value = allowOrigin.trim();

  return value === "*" || value.toLowerCase() === origin.toLowerCase();
}

export async function probeShareCors(options: {
  zipUrl: string;
  origin: string;
  fetchImpl?: FetchImpl;
}): Promise<ShareCorsVerdict> {
  const doFetch = options.fetchImpl ?? fetch;
  const origin = options.origin;
  let url = options.zipUrl;
  let redirects = 0;

  const verdict = (
    extra: Partial<ShareCorsVerdict> & { ok: boolean; reason: string },
  ): ShareCorsVerdict => ({
    checkedUrl: options.zipUrl,
    origin,
    finalUrl: url,
    finalStatus: 0,
    redirects,
    allowOrigin: null,
    held: false,
    ...extra,
  });

  for (let hop = 0; hop < MAX_HOPS; hop++) {
    const controller = new AbortController();
    let res: Response;

    try {
      res = await doFetch(url, {
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
        headers: { origin, "sec-fetch-mode": "cors" },
      });
    } catch (err) {
      return verdict({
        ok: false,
        reason: `Could not reach ${url}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      });
    }

    const status = res.status;
    const allowOrigin = res.headers.get("access-control-allow-origin");
    let body: unknown;

    if (status >= 400) {
      try {
        body = JSON.parse((await res.text()).slice(0, 4096));
      } catch {
        body = undefined;
      }
    } else {
      try {
        await res.body?.cancel();
      } catch {
        controller.abort();
      }
    }

    if (sawPlatformHold(res, body)) {
      return verdict({
        ok: false,
        held: true,
        finalStatus: status,
        allowOrigin,
        reason:
          `${url} answered ${status} with the platform hold, so this link is held ` +
          `from the public until extension.dev opens. It is not broken: the share ` +
          `was created and will open once the platform is open. A signed-in ` +
          `operator can still reach it.`,
      });
    }

    if (status >= 300 && status < 400) {
      const location = res.headers.get("location");

      if (!location) {
        return verdict({
          ok: false,
          finalStatus: status,
          allowOrigin,
          reason: `${url} answered ${status} with no Location, so the download goes nowhere.`,
        });
      }

      url = new URL(location, url).toString();
      redirects += 1;
      continue;
    }

    if (status >= 400) {
      return verdict({
        ok: false,
        finalStatus: status,
        allowOrigin,
        reason: `The build's zip answered ${status}, so the link has nothing to render.`,
      });
    }

    if (!allows(allowOrigin, origin)) {
      return verdict({
        ok: false,
        finalStatus: status,
        allowOrigin,
        reason:
          `${url} answered ${status} but with ${ 
          allowOrigin
            ? `access-control-allow-origin: ${allowOrigin}, which does not cover ${origin}`
            : "no access-control-allow-origin header" 
          }. A browser at ${origin} will refuse to read it, so the link opens to an error even though this fetch succeeded.${ 
          redirects > 0
            ? " The header has to be on this response, not on the redirect that led here."
            : ""}`,
      });
    }

    return verdict({
      ok: true,
      finalStatus: status,
      allowOrigin,
      reason: `A browser at ${origin} can read the build's zip: the final response after ${redirects} redirect(s) answered ${status} with access-control-allow-origin: ${allowOrigin}.`,
    });
  }

  return verdict({
    ok: false,
    reason: `The build's zip redirected more than ${MAX_HOPS} times, so nothing could be read from it.`,
  });
}
