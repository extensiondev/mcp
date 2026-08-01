import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  writeCredentials,
  type StoredCredentials,
} from "../lib/credentials";
import { readIdentity } from "../tools/whoami";
import { askServerIdentity } from "../lib/server-identity";

const FUTURE = Math.floor(Date.now() / 1000) + 3600;

function sample(overrides: Partial<StoredCredentials> = {}): StoredCredentials {
  return {
    version: 1,
    token: "claims.sig",
    workspaceSlug: "acme",
    projectSlug: "widget",
    expiresAt: FUTURE,
    api: "https://www.extension.dev",
    ...overrides,
  };
}

function fetchAnswering(status: number, body?: unknown): typeof fetch {
  return (async () =>
    new Response(body === undefined ? "" : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
}

const fetchFailing: typeof fetch = (async () => {
  throw new Error("getaddrinfo ENOTFOUND www.extension.dev");
}) as unknown as typeof fetch;

describe("extension_auth status asks the server who the token is", () => {
  let tmp: string;
  let prevXdg: string | undefined;

  beforeEach(() => {
    if (process.platform === "win32") return;
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "extdev-whoami-server-"));
    prevXdg = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = tmp;
  });

  afterEach(() => {
    if (process.platform === "win32") return;
    if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prevXdg;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("reports the server's confirmation beside the local claim", async () => {
    if (process.platform === "win32") return;
    writeCredentials(sample());

    const result = JSON.parse(
      await readIdentity({
        fetchImpl: fetchAnswering(200, { login: "acme/widget", live: true }),
      }),
    );

    expect(result.status).toBe("logged-in");
    expect(result.value.server).toEqual({
      verdict: "confirmed",
      api: "https://www.extension.dev",
      login: "acme/widget",
      live: true,
    });
    expect(result.hint).toContain("confirms this token");
    expect(result.hint).toContain("acme/widget");
  });

  it("flips the status when the server refuses the credential the local file believes in", async () => {
    if (process.platform === "win32") return;
    writeCredentials(sample());

    const result = JSON.parse(
      await readIdentity({ fetchImpl: fetchAnswering(401, { message: "no" }) }),
    );

    expect(result.status).toBe("refused-by-server");
    expect(result.value.server.verdict).toBe("refused");
    expect(result.hint).toContain("refused this credential");
    expect(result.hint).toContain("only what the local file claims");
    expect(result.hint).toContain("action: login");
  });

  it("says the check did not happen when the server is unreachable, never dressing the local claim as confirmed", async () => {
    if (process.platform === "win32") return;
    writeCredentials(sample());

    const result = JSON.parse(await readIdentity({ fetchImpl: fetchFailing }));

    expect(result.status).toBe("logged-in");
    expect(result.value.server.verdict).toBe("unavailable");
    expect(result.value.server.detail).toContain("ENOTFOUND");
    expect(result.hint).toContain("not server-confirmed");
    expect(
      result.warnings.some((w: string) => w.includes("not server-confirmed")),
    ).toBe(true);
  });

  it("treats a server without the endpoint as unverified, not as a verdict", async () => {
    if (process.platform === "win32") return;
    writeCredentials(sample());

    const result = JSON.parse(
      await readIdentity({ fetchImpl: fetchAnswering(404) }),
    );

    expect(result.status).toBe("logged-in");
    expect(result.value.server.verdict).toBe("unavailable");
    expect(result.value.server.detail).toContain("404");
    expect(result.hint).toContain("not server-confirmed");
  });

  it("asks the base recorded at login, not the default, when they diverge", async () => {
    if (process.platform === "win32") return;
    writeCredentials(sample({ api: "http://localhost:3100" }));
    const seen: string[] = [];
    const fetchSpy = (async (url: string | URL) => {
      seen.push(String(url));
      return new Response(JSON.stringify({ login: "acme/widget", live: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const result = JSON.parse(await readIdentity({ fetchImpl: fetchSpy }));

    expect(seen).toEqual(["http://localhost:3100/api/cli/whoami"]);
    expect(result.value.server.api).toBe("http://localhost:3100");
  });

  it("does not ask the server for a token the local file already knows is expired", async () => {
    if (process.platform === "win32") return;
    writeCredentials(
      sample({ expiresAt: Math.floor(Date.now() / 1000) - 60 }),
    );
    const fetchSpy = vi.fn(fetchAnswering(200, { login: "acme/widget" }));

    const result = JSON.parse(
      await readIdentity({ fetchImpl: fetchSpy as unknown as typeof fetch }),
    );

    expect(result.status).toBe("expired");
    expect(result.value.server.verdict).toBe("not-asked");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("askServerIdentity sends the bearer and reads only real verdicts", () => {
  it("sends the token as an Authorization bearer to /api/cli/whoami", async () => {
    let sawUrl = "";
    let sawAuth = "";
    const fetchSpy = (async (url: string | URL, init?: RequestInit) => {
      sawUrl = String(url);
      sawAuth = String(
        (init?.headers as Record<string, string> | undefined)?.authorization ||
          "",
      );
      return new Response(JSON.stringify({ login: "a/b", live: true }), {
        status: 200,
      });
    }) as unknown as typeof fetch;

    const answer = await askServerIdentity({
      apiBase: "https://www.extension.dev/",
      token: "tok.sig",
      fetchImpl: fetchSpy,
    });

    expect(sawUrl).toBe("https://www.extension.dev/api/cli/whoami");
    expect(sawAuth).toBe("Bearer tok.sig");
    expect(answer).toEqual({ kind: "confirmed", login: "a/b", live: true });
  });

  it("reads a 200 without a login as unavailable rather than inventing an identity", async () => {
    const answer = await askServerIdentity({
      apiBase: "https://www.extension.dev",
      token: "tok.sig",
      fetchImpl: (async () =>
        new Response("{}", { status: 200 })) as unknown as typeof fetch,
    });
    expect(answer.kind).toBe("unavailable");
  });

  it("reads a 401 as the server's refusal", async () => {
    const answer = await askServerIdentity({
      apiBase: "https://www.extension.dev",
      token: "tok.sig",
      fetchImpl: (async () =>
        new Response("{}", { status: 401 })) as unknown as typeof fetch,
    });
    expect(answer).toEqual({ kind: "refused" });
  });

  it("reads a 5xx as silence, not as a verdict", async () => {
    const answer = await askServerIdentity({
      apiBase: "https://www.extension.dev",
      token: "tok.sig",
      fetchImpl: (async () =>
        new Response("oops", { status: 503 })) as unknown as typeof fetch,
    });
    expect(answer.kind).toBe("unavailable");
  });
});
