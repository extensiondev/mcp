import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { handler } from "../tools/publish";
import { writeCredentials } from "../lib/credentials";

const platform = vi.hoisted(() => ({
  result: {
    ok: true,
    data: { shareUrl: "https://preview.extension.dev/?preview=gen_x", visibility: "private" } as Record<string, unknown>,
  },
}));

/* @invariant The real publish client runs: only the network is faked, and
   only /api/cli/publish answers with the platform body each cell sets, so the
   token resolution and response reading are the shipped ones. */
function publishAnswer(url: string): Response | null {
  if (!url.endsWith("/api/cli/publish")) return null;

  return new Response(JSON.stringify(platform.result.data), {
    status: platform.result.ok ? 200 : 500,
    headers: { "content-type": "application/json" },
  });
}

const OLD_SHA = "aaaaaaaa1111111122222222333333334444aaaa";
const NEW_SHA = "bbbbbbbb1111111122222222333333334444bbbb";

function buildsIndex(): unknown {
  return {
    items: [
      {
        sha: NEW_SHA,
        status: "success",
        timestamp: "2026-07-20T00:00:00.000Z",
        version: "2.0.0",
        channel: "beta",
      },
      {
        sha: OLD_SHA,
        status: "success",
        timestamp: "2026-07-01T00:00:00.000Z",
        version: "1.0.0",
        channel: "stable",
      },
    ],
  };
}

function registryFetch(body: unknown): typeof fetch {
  return (async (input: string | URL | Request) => {
    const answer = publishAnswer(String(input instanceof Request ? input.url : input));
    if (answer) return answer;

    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(body),
    };
  }) as unknown as typeof fetch;
}

describe("extension_publish build pin enrichment", () => {
  let tmp: string;
  let prevXdg: string | undefined;
  let prevFetch: typeof fetch;
  let prevToken: string | undefined;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "extdev-publish-pin-"));
    prevXdg = process.env.XDG_CONFIG_HOME;
    prevToken = process.env.EXTENSION_DEV_TOKEN;
    delete process.env.EXTENSION_DEV_TOKEN;
    prevFetch = global.fetch;
    process.env.XDG_CONFIG_HOME = tmp;
    platform.result = { ok: true, data: { shareUrl: "https://preview.extension.dev/?preview=gen_x", visibility: "private" } };
    writeCredentials({
      version: 1,
      token: "tok_stored",
      workspaceSlug: "acme",
      projectSlug: "widget",
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      api: "https://www.extension.dev",
    });

    global.fetch = registryFetch(buildsIndex());
  });

  afterEach(() => {
    if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prevXdg;

    global.fetch = prevFetch;
    if (prevToken === undefined) delete process.env.EXTENSION_DEV_TOKEN;
    else process.env.EXTENSION_DEV_TOKEN = prevToken;

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("matches a full-length pin against a full-length index sha", async () => {
    const out = JSON.parse(await handler({ buildSha: OLD_SHA }));
    expect(out.ok).toBe(true);
    expect(out.value.buildSha).toBe(OLD_SHA);
    expect(out.value.version).toBe("1.0.0");
    expect(out.value.channel).toBe("stable");
    expect(out.value.builtAt).toBe("2026-07-01T00:00:00.000Z");
  });

  it("matches a short pin against a full-length index sha", async () => {
    const out = JSON.parse(await handler({ buildSha: OLD_SHA.slice(0, 7) }));
    expect(out.value.version).toBe("1.0.0");
    expect(out.value.channel).toBe("stable");
  });

  it("never attributes the newest build's metadata to an unresolved pin", async () => {
    const out = JSON.parse(await handler({ buildSha: "deadbee" }));
    expect(out.ok).toBe(true);
    expect(out.value.buildSha).toBe("deadbee");
    expect(out.value.version).toBeUndefined();
    expect(out.value.channel).toBeUndefined();
    expect(out.value.builtAt).toBeUndefined();
    expect(
      out.warnings.some((w: string) =>
        w.includes("not found in the project's registry build index"),
      ),
    ).toBe(true);
  });

  it("keeps the newest-successful enrichment and its note when nothing is pinned", async () => {
    const out = JSON.parse(await handler({}));
    expect(out.value.buildSha).toBe(NEW_SHA);
    expect(out.value.version).toBe("2.0.0");
    expect(
      out.warnings.some((w: string) => w.includes("newest successful build")),
    ).toBe(true);
  });

  /* @invariant
    * the deploy lane marks a finished build `ready`.
    */
  it("reads a build the index marks ready as the newest successful build", async () => {
    global.fetch = registryFetch({
      items: [
        {
          id: "a8a86d7",
          commit: "a8a86d7c0ffee000000000000000000000000001",
          status: "ready",
          timestamp: "2026-10-01T10:00:00.000Z",
          version: "9.0.0.0",
          browsers: ["chrome", "edge", "firefox"],
        },
        {
          id: "bead5ee",
          commit: "bead5eedc0ffeebabe990000000000000000000",
          status: "failed",
          timestamp: "2026-10-01T11:00:00.000Z",
          version: "9.0.0.1",
        },
      ],
    });

    const out = JSON.parse(await handler({}));
    expect(out.ok).toBe(true);
    expect(out.value.buildSha).toBe("a8a86d7");
    expect(out.value.version).toBe("9.0.0.0");
    expect(out.value.builtAt).toBe("2026-10-01T10:00:00.000Z");
  });

  it("keeps the platform's own buildSha, version and builtAt when the envelope carries them", async () => {
    platform.result = {
      ok: true,
      data: {
        shareUrl: "https://preview.extension.dev/?preview=gen_x",
        buildSha: "a8a86d7c0ffee000000000000000000000000001",
        version: "9.0.0.0",
        builtAt: "2026-10-01T10:00:00.000Z",
      },
    };

    const out = JSON.parse(await handler({}));
    expect(out.value.buildSha).toBe(
      "a8a86d7c0ffee000000000000000000000000001",
    );

    expect(out.value.version).toBe("9.0.0.0");
    expect(out.value.builtAt).toBe("2026-10-01T10:00:00.000Z");
  });
});
