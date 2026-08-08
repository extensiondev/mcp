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

/* @invariant
 * The verdict is read off the last hop, because that is the only one a browser
 * reads.
 *
 * This exists because a redirect answered with access-control-allow-origin and
 * the presigned URL it pointed at answered without one, and every check the
 * platform had followed redirects automatically and reported 200. A server
 * fetch does not enforce CORS, so "it came back 200" is not evidence that a
 * browser can read it, and reporting it as such certified links that failed
 * for every recipient. Following the chain by hand and asserting the header on
 * the response that ends it is the only server-side check that answers the
 * question a browser asks.
 */
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

    try {
      await res.body?.cancel();
    } catch {
      controller.abort();
    }

    const status = res.status;
    const allowOrigin = res.headers.get("access-control-allow-origin");

    /* @invariant
     * A HOLD IS NOT A BROKEN LINK, AND THIS PROBE MUST NOT REPORT IT AS ONE.
     *
     * This fetch carries no Authorization on purpose: it stands in for the
     * public browser that will open the share, so it measures what that browser
     * can read and nothing else. During the public hold the platform can answer
     * this document with its hold signal rather than the zip, and the plain
     * status branches below would read that as "the link has nothing to
     * render", which is the exact conflation between held-for-the-public and
     * broken that makes an operator conclude their working share is dead. The
     * signal is the machine field, never the status number or the prose, so a
     * held response is recognised by sawPlatformHold and answered as held. It is
     * still not ok, because the public genuinely cannot read it yet, but the
     * reason says why and stops short of calling the link broken.
     */
    if (sawPlatformHold(res)) {
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
          `${url} answered ${status} but with ` +
          (allowOrigin
            ? `access-control-allow-origin: ${allowOrigin}, which does not cover ${origin}`
            : "no access-control-allow-origin header") +
          `. A browser at ${origin} will refuse to read it, so the link opens to an error even though this fetch succeeded.` +
          (redirects > 0
            ? " The header has to be on this response, not on the redirect that led here."
            : ""),
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
