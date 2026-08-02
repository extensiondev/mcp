import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/credentials", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/credentials")>()),
  readValidCredentials: () => null,
}));

import { ZIP_URL_REDIRECT_NOTE } from "../lib/artifacts-api";
import { probeShareCors } from "../lib/share-cors-probe";
import { handler as previewWeb } from "../tools/preview-web";
import { handler as shares } from "../tools/shares";

const ZIP = "https://www.extension.dev/api/artifacts/gen_abc/source.zip";
const SIGNED = "https://acct.r2.cloudflarestorage.com/bucket/gen_abc.zip?sig=1";
const FULL_ID = `gen_${"0123456789abcdef".repeat(4)}`;

const origFetch = global.fetch;
const origToken = process.env.EXTENSION_DEV_TOKEN;
const tmpDirs: string[] = [];

function tmpProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zip-redirect-"));
  tmpDirs.push(dir);
  return dir;
}

function listingFetch(body: unknown, status = 200): typeof fetch {
  return (async () => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  })) as unknown as typeof fetch;
}

function liveRow(zipUrl: string | null) {
  return {
    artifactId: FULL_ID,
    name: "demo",
    live: zipUrl !== null,
    createdAt: "2026-08-01T00:00:00.000Z",
    sizeBytes: 160688,
    zipUrl,
    previewUrl: zipUrl ? "https://preview.extension.dev/?preview=gen_abc" : null,
    revokeUrl: `https://extension.dev/api/artifacts/${FULL_ID}`,
  };
}

beforeEach(() => {
  process.env.EXTENSION_DEV_TOKEN = "test-token";
  global.fetch = (async () => {
    throw new Error("no test may reach the real platform");
  }) as unknown as typeof fetch;
});

afterEach(() => {
  global.fetch = origFetch;
  if (origToken === undefined) delete process.env.EXTENSION_DEV_TOKEN;
  else process.env.EXTENSION_DEV_TOKEN = origToken;
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("the note that comes with a zip URL", () => {
  it("says the URL redirects and that an unfollowed 302 reads as empty", () => {
    expect(ZIP_URL_REDIRECT_NOTE).toMatch(/302/);
    expect(ZIP_URL_REDIRECT_NOTE).toMatch(/redirect/i);
    expect(ZIP_URL_REDIRECT_NOTE).toMatch(/0 bytes|empty/i);
  });
});

describe("extension_shares hands out a zip URL with the redirect named", () => {
  it("warns whenever a listed row still carries a zipUrl", async () => {
    global.fetch = listingFetch({
      artifacts: [liveRow(ZIP)],
      count: 1,
      matched: 1,
      limit: 50,
      truncated: false,
    });

    const out = JSON.parse(await shares({ action: "list" }));

    expect(out.value.shares[0].zipUrl).toBe(ZIP);
    expect(out.warnings.some((w: string) => w === ZIP_URL_REDIRECT_NOTE)).toBe(true);
  });

  it("stays quiet when no row has a zip to download", async () => {
    global.fetch = listingFetch({
      artifacts: [liveRow(null)],
      count: 1,
      matched: 1,
      limit: 50,
      truncated: false,
    });

    const out = JSON.parse(await shares({ action: "list" }));

    expect(out.warnings.some((w: string) => w === ZIP_URL_REDIRECT_NOTE)).toBe(false);
  });
});

describe("this package's own zip read follows the redirect", () => {
  it("walks the 302 to the presigned URL instead of reading the empty hop", async () => {
    const seen: string[] = [];
    const impl = (async (input: unknown) => {
      const url = String(input);
      seen.push(url);
      if (url === ZIP) {
        return new Response(null, { status: 302, headers: { location: SIGNED } });
      }
      return new Response(null, {
        status: 200,
        headers: { "access-control-allow-origin": "*" },
      });
    }) as unknown as typeof fetch;

    const verdict = await probeShareCors({
      zipUrl: ZIP,
      origin: "https://preview.extension.dev",
      fetchImpl: impl,
    });

    expect(seen).toEqual([ZIP, SIGNED]);
    expect(verdict.redirects).toBe(1);
    expect(verdict.finalUrl).toBe(SIGNED);
    expect(verdict.finalStatus).toBe(200);
    expect(verdict.ok).toBe(true);
  });

  it("never reports a bare 302 as the final answer", async () => {
    const impl = (async () =>
      new Response(null, {
        status: 302,
        headers: { location: SIGNED },
      })) as unknown as typeof fetch;

    const verdict = await probeShareCors({
      zipUrl: ZIP,
      origin: "https://preview.extension.dev",
      fetchImpl: impl,
    });

    expect(verdict.ok).toBe(false);
    expect(verdict.finalStatus).not.toBe(302);
  });
});

describe("extension_preview_web names the redirect beside the zip it hands out", () => {
  function uploadFetch(body: unknown): typeof fetch {
    return (async () => ({
      ok: true,
      status: 201,
      text: async () => JSON.stringify(body),
    })) as unknown as typeof fetch;
  }

  it("carries the note in the share block when a zipUrl came back", async () => {
    const dir = tmpProject();
    fs.writeFileSync(
      path.join(dir, "manifest.json"),
      JSON.stringify({ manifest_version: 3, name: "Zip Ext", version: "1.0.0" }),
    );
    global.fetch = uploadFetch({
      artifactId: "gen_zipnote",
      previewUrl: "https://preview.extension.dev/?preview=gen_zipnote",
      zipUrl: "https://www.extension.dev/api/artifacts/gen_zipnote/source.zip",
      revokeUrl: "https://www.extension.dev/api/artifacts/gen_zipnote",
    });

    const out = JSON.parse(
      await previewWeb({
        projectPath: dir,
        build: false,
        distPath: dir,
        probe: false,
        share: true,
      }),
    );

    expect(out.value.share.zipUrl).toBeTruthy();
    expect(String(out.value.share.note)).toContain(ZIP_URL_REDIRECT_NOTE);
  });

  it("leaves the note out when the share carries no zip", async () => {
    const dir = tmpProject();
    fs.writeFileSync(
      path.join(dir, "manifest.json"),
      JSON.stringify({ manifest_version: 3, name: "Zip Ext", version: "1.0.0" }),
    );
    global.fetch = uploadFetch({
      artifactId: "gen_nozip",
      previewUrl: "https://preview.extension.dev/?preview=gen_nozip",
      revokeUrl: "https://www.extension.dev/api/artifacts/gen_nozip",
    });

    const out = JSON.parse(
      await previewWeb({
        projectPath: dir,
        build: false,
        distPath: dir,
        probe: false,
        share: true,
      }),
    );

    expect(String(out.value.share.note)).not.toContain(ZIP_URL_REDIRECT_NOTE);
  });
});
