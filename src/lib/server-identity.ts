// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

export type ServerIdentityAnswer =
  | { kind: "confirmed"; login: string; live: boolean }
  | { kind: "refused" }
  | { kind: "unavailable"; detail: string };

const DEFAULT_TIMEOUT_MS = 5000;

/* @invariant
 * ONLY A 200 CONFIRMS AND ONLY A 401 REFUSES. EVERYTHING ELSE IS SILENCE.
 *
 * The whole point of asking the server is to stop reporting "logged in" for a
 * credential production would refuse, so the answer must never be inferred
 * from anything weaker than the server's own verdict. A 404 is a deploy that
 * does not carry the endpoint yet, a 5xx is an outage, a network error is a
 * network error: reading any of those as either "confirmed" or "refused"
 * would recreate the local-file guess this call exists to replace, just with
 * extra steps. Callers get "unavailable" and must say so out loud.
 */
export async function askServerIdentity(args: {
  apiBase: string;
  token: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<ServerIdentityAnswer> {
  const fetchImpl = args.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    args.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
  try {
    const res = await fetchImpl(
      `${args.apiBase.replace(/\/+$/, "")}/api/cli/whoami`,
      {
        headers: {
          authorization: `Bearer ${args.token}`,
          accept: "application/json",
        },
        signal: controller.signal,
      },
    );
    if (res.status === 200) {
      const data = (await res.json().catch(() => null)) as {
        login?: unknown;
        live?: unknown;
      } | null;
      const login = String(data?.login || "").trim();
      if (!login) {
        return {
          kind: "unavailable",
          detail: "the server answered 200 without a login",
        };
      }
      return { kind: "confirmed", login, live: data?.live === true };
    }
    if (res.status === 401) return { kind: "refused" };
    return {
      kind: "unavailable",
      detail: `the server answered ${res.status}, which is not a verdict on this credential`,
    };
  } catch (error: unknown) {
    return {
      kind: "unavailable",
      detail: (error as Error)?.message || "network error",
    };
  } finally {
    clearTimeout(timer);
  }
}
