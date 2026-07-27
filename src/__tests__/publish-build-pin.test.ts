import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const platform = vi.hoisted(() => ({
  result: { ok: true, data: {} as Record<string, unknown> },
}));

vi.mock("../lib/publish", () => ({
  resolveToken: () => "tok_test",
  publish: async () => ({
    ok: platform.result.ok,
    data: { ...platform.result.data },
  }),
}));

import { handler } from "../tools/publish";
import { writeCredentials } from "../lib/credentials";

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
  return (async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify(body),
  })) as unknown as typeof fetch;
}

describe("extension_publish build pin enrichment", () => {
  let tmp: string;
  let prevXdg: string | undefined;
  let prevFetch: typeof fetch;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "extdev-publish-pin-"));
    prevXdg = process.env.XDG_CONFIG_HOME;
    prevFetch = global.fetch;
    process.env.XDG_CONFIG_HOME = tmp;
    platform.result = { ok: true, data: {} };
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
});
