import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { handler, schema } from "../tools/preview-web";

vi.mock("../lib/cdp-port", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/cdp-port")>()),
  resolveCdpPort: async () => null,
  resolveRdpPort: async () => null,
}));

const MANIFEST = {
  manifest_version: 3,
  name: "Probe Ext",
  version: "1.2.3",
  action: { default_popup: "popup.html" },
  background: { service_worker: "sw.js" },
};

function tmpDist(manifest?: unknown): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "preview-web-"));
  if (manifest !== undefined) {
    fs.writeFileSync(
      path.join(dir, "manifest.json"),
      JSON.stringify(manifest),
    );
  }
  return dir;
}

function jsonFetch(body: unknown, contentType = "application/json"): typeof fetch {
  return (async () => ({
    ok: true,
    status: 200,
    headers: { get: (k: string) => (k.toLowerCase() === "content-type" ? contentType : null) },
    json: async () => body,
  })) as unknown as typeof fetch;
}

describe("extension_preview_web", () => {
  const origFetch = global.fetch;
  afterEach(() => {
    global.fetch = origFetch;
    vi.restoreAllMocks();
  });

  it("names the tool and requires projectPath", () => {
    expect(schema.name).toBe("extension_preview_web");
    expect(schema.inputSchema.required).toContain("projectPath");
  });

  it("defaults to preview and emits a base64url-round-tripping preview://build deep link (probe off)", async () => {
    const dir = tmpDist(MANIFEST);
    try {
      const out = JSON.parse(
        await handler({ projectPath: dir, build: false, distPath: dir, probe: false }),
      );
      expect(out.ok).toBe(true);
      expect(out.built).toBe(false);
      expect(out.surface).toBe("preview");
      expect(out.manifest).toMatchObject({
        name: "Probe Ext",
        version: "1.2.3",
        manifestVersion: 3,
      });
      expect(out.surfaces).toEqual(
        expect.arrayContaining(["popup", "background-worker"]),
      );
      expect(new URL(out.deepLink).port).toBe("3110");
      const internal = new URL(out.deepLink).searchParams.get("url") ?? "";
      expect(internal.startsWith("preview://build/")).toBe(true);
      const b64 = internal.slice("preview://build/".length);
      expect(Buffer.from(b64, "base64url").toString("utf8")).toBe(
        path.resolve(dir),
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("still targets inspect (and its scheme, port and legacy inspectUrl) on surface:inspect", async () => {
    const dir = tmpDist(MANIFEST);
    try {
      const out = JSON.parse(
        await handler({
          projectPath: dir,
          build: false,
          distPath: dir,
          probe: false,
          surface: "inspect",
        }),
      );
      expect(out.surface).toBe("inspect");
      expect(new URL(out.deepLink).port).toBe("3106");
      const internal = new URL(out.deepLink).searchParams.get("url") ?? "";
      expect(internal.startsWith("inspect://path/")).toBe(true);

      const overridden = JSON.parse(
        await handler({
          projectPath: dir,
          build: false,
          distPath: dir,
          probe: false,
          surface: "inspect",
          inspectUrl: "http://localhost:4321",
        }),
      );
      expect(new URL(overridden.deepLink).port).toBe("4321");
      const ignored = JSON.parse(
        await handler({
          projectPath: dir,
          build: false,
          distPath: dir,
          probe: false,
          inspectUrl: "http://localhost:4321",
        }),
      );
      expect(new URL(ignored.deepLink).port).toBe("3110");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports previewLoadable when the surface's middleware answers with a payload", async () => {
    const dir = tmpDist(MANIFEST);
    global.fetch = jsonFetch({
      identifier: "preview-abc",
      version: "1.2.3",
      manifest: { name: "Probe Ext" },
      files: [1, 2, 3],
    });
    try {
      const out = JSON.parse(
        await handler({
          projectPath: dir,
          build: false,
          distPath: dir,
          hostUrl: "http://localhost:3110",
        }),
      );
      expect(out.hostReachable).toBe(true);
      expect(out.previewLoadable).toBe(true);
      expect(out.probe.fileCount).toBe(3);
      expect(out.probe.identifier).toBe("preview-abc");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("degrades gracefully when the surface is unreachable", async () => {
    const dir = tmpDist(MANIFEST);
    global.fetch = (async () => {
      throw new Error("fetch failed");
    }) as unknown as typeof fetch;
    try {
      const out = JSON.parse(
        await handler({ projectPath: dir, build: false, distPath: dir }),
      );
      expect(out.ok).toBe(true);
      expect(out.hostReachable).toBe(false);
      expect(out.previewLoadable).toBe(false);
      expect(String(out.probe.note)).toMatch(/Start it/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("treats a non-JSON answer (deployed static host) as not loadable", async () => {
    const dir = tmpDist(MANIFEST);
    global.fetch = jsonFetch("<!doctype html>", "text/html");
    try {
      const out = JSON.parse(
        await handler({ projectPath: dir, build: false, distPath: dir }),
      );
      expect(out.hostReachable).toBe(true);
      expect(out.previewLoadable).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("errors when the dist has no manifest", async () => {
    const dir = tmpDist();
    try {
      const out = JSON.parse(
        await handler({ projectPath: dir, build: false, distPath: dir, probe: false }),
      );
      expect(out.ok).toBe(false);
      expect(out.stage).toBe("resolve-dist");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("open:true without a live session reports opened.ok false and keeps the deep link", async () => {
    const dir = tmpDist(MANIFEST);
    try {
      const out = JSON.parse(
        await handler({
          projectPath: dir,
          build: false,
          distPath: dir,
          probe: false,
          open: true,
        }),
      );
      expect(out.deepLink).toBeTruthy();
      expect(out.opened).toBeDefined();
      expect(out.opened.ok).not.toBe(true);
      expect(String(out.openHint)).toMatch(/live dev session/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  describe("share:true (uploads the local dist)", () => {
    let prevXdg: string | undefined;
    let prevToken: string | undefined;
    let prevApi: string | undefined;
    let prevPreview: string | undefined;
    let cfg: string;

    beforeEach(() => {
      prevXdg = process.env.XDG_CONFIG_HOME;
      prevToken = process.env.EXTENSION_DEV_TOKEN;
      prevApi = process.env.EXTENSION_DEV_API_URL;
      prevPreview = process.env.EXTENSION_DEV_PREVIEW_URL;
      cfg = fs.mkdtempSync(path.join(os.tmpdir(), "preview-web-cfg-"));
      process.env.XDG_CONFIG_HOME = cfg;
      delete process.env.EXTENSION_DEV_TOKEN;
      delete process.env.EXTENSION_DEV_API_URL;
      delete process.env.EXTENSION_DEV_PREVIEW_URL;
    });

    afterEach(() => {
      const restore = (k: string, v: string | undefined) => {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      };
      restore("XDG_CONFIG_HOME", prevXdg);
      restore("EXTENSION_DEV_TOKEN", prevToken);
      restore("EXTENSION_DEV_API_URL", prevApi);
      restore("EXTENSION_DEV_PREVIEW_URL", prevPreview);
      fs.rmSync(cfg, { recursive: true, force: true });
    });

    it("degrades gracefully with a login hint when not authenticated", async () => {
      const dir = tmpDist(MANIFEST);
      try {
        const out = JSON.parse(
          await handler({ projectPath: dir, build: false, distPath: dir, probe: false, share: true }),
        );
        expect(out.ok).toBe(true);
        expect(out.deepLink).toBeTruthy();
        expect(out.share.requested).toBe(true);
        expect(out.share.ok).toBe(false);
        expect(out.share.supported).toBe(false);
        expect(String(out.share.loginHint)).toMatch(/extension_login/);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it("uploads the local dist and returns the platform's preview link", async () => {
      const dir = tmpDist(MANIFEST);
      process.env.EXTENSION_DEV_TOKEN = "tok_test";
      let uploaded: any = null;
      global.fetch = (async (url: string, init: any) => {
        expect(String(url)).toContain("/api/artifacts");
        expect(init.headers.authorization).toBe("Bearer tok_test");
        uploaded = JSON.parse(init.body);
        return {
          ok: true,
          status: 201,
          text: async () =>
            JSON.stringify({
              artifactId: "gen_abc123",
              previewUrl: "https://preview.extension.dev/?preview=gen_abc123",
              zipUrl: "https://www.extension.dev/api/artifacts/gen_abc123/source.zip",
              revokeUrl: "https://www.extension.dev/api/artifacts/gen_abc123",
              expiresAt: "2026-08-23T00:00:00.000Z",
            }),
        };
      }) as unknown as typeof fetch;
      try {
        const out = JSON.parse(
          await handler({ projectPath: dir, build: false, distPath: dir, probe: false, share: true }),
        );
        expect(out.share.ok).toBe(true);
        expect(out.share.previewUrl).toBe(
          "https://preview.extension.dev/?preview=gen_abc123",
        );
        expect(out.share.serves).toBe("uploaded-local-build");
        expect(out.share.localBuildUploaded).toBe(true);
        expect(out.share.revokeUrl).toBeTruthy();
        expect(out.share.expiresAt).toBeTruthy();

        expect(uploaded.kind).toBe("dist");
        const paths = uploaded.generation.files.map((f: any) => f.path);
        expect(paths).toContain("manifest.json");
        const manifestEntry = uploaded.generation.files.find(
          (f: any) => f.path === "manifest.json",
        );
        expect(manifestEntry.encoding).toBe("utf8");
        expect(JSON.parse(manifestEntry.content).name).toBe(MANIFEST.name);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it("writes the revoke handle to the project's share record and appends on the next share", async () => {
      const dir = tmpDist(MANIFEST);
      process.env.EXTENSION_DEV_TOKEN = "tok_test";
      let served = 0;
      global.fetch = (async () => {
        served += 1;
        return {
          ok: true,
          status: 201,
          text: async () =>
            JSON.stringify({
              artifactId: `gen_share${served}`,
              previewUrl: `https://preview.extension.dev/?preview=gen_share${served}`,
              zipUrl: `https://www.extension.dev/api/artifacts/gen_share${served}/source.zip`,
              revokeUrl: `https://www.extension.dev/api/artifacts/gen_share${served}`,
              expiresAt: "2026-08-23T00:00:00.000Z",
            }),
        };
      }) as unknown as typeof fetch;
      try {
        const first = JSON.parse(
          await handler({ projectPath: dir, build: false, distPath: dir, probe: false, share: true }),
        );
        const recordPath = path.join(dir, ".extension.dev", "shared-previews.json");
        expect(first.share.record.recorded).toBe(true);
        expect(first.share.record.path).toBe(recordPath);
        expect(first.share.record.entries).toBe(1);
        expect(String(first.share.note)).toContain(recordPath);

        const afterFirst = JSON.parse(fs.readFileSync(recordPath, "utf8"));
        expect(afterFirst.version).toBe(1);
        expect(afterFirst.shares).toHaveLength(1);
        expect(afterFirst.shares[0]).toMatchObject({
          artifactId: "gen_share1",
          previewUrl: "https://preview.extension.dev/?preview=gen_share1",
          revokeUrl: "https://www.extension.dev/api/artifacts/gen_share1",
          expiresAt: "2026-08-23T00:00:00.000Z",
          name: MANIFEST.name,
          browser: "chrome",
        });
        expect(typeof afterFirst.shares[0].sharedAt).toBe("string");

        const second = JSON.parse(
          await handler({ projectPath: dir, build: false, distPath: dir, probe: false, share: true }),
        );
        expect(second.share.record.entries).toBe(2);
        const afterSecond = JSON.parse(fs.readFileSync(recordPath, "utf8"));
        expect(afterSecond.shares.map((s: any) => s.artifactId)).toEqual([
          "gen_share1",
          "gen_share2",
        ]);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it("gitignores the share record when the project is a git repository", async () => {
      const dir = tmpDist(MANIFEST);
      fs.mkdirSync(path.join(dir, ".git"));
      process.env.EXTENSION_DEV_TOKEN = "tok_test";
      global.fetch = (async () => ({
        ok: true,
        status: 201,
        text: async () =>
          JSON.stringify({
            artifactId: "gen_ignored",
            previewUrl: "https://preview.extension.dev/?preview=gen_ignored",
            revokeUrl: "https://www.extension.dev/api/artifacts/gen_ignored",
          }),
      })) as unknown as typeof fetch;
      try {
        const out = JSON.parse(
          await handler({ projectPath: dir, build: false, distPath: dir, probe: false, share: true }),
        );
        expect(out.share.record.gitignored).toBe("added");
        expect(out.share.record.warning).toBeUndefined();
        expect(fs.readFileSync(path.join(dir, ".gitignore"), "utf8")).toContain(
          ".extension.dev/",
        );

        const again = JSON.parse(
          await handler({ projectPath: dir, build: false, distPath: dir, probe: false, share: true }),
        );
        expect(again.share.record.gitignored).toBe("already-ignored");
        const entries = fs
          .readFileSync(path.join(dir, ".gitignore"), "utf8")
          .split("\n")
          .filter((line) => line.trim() === ".extension.dev/");
        expect(entries).toHaveLength(1);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it("keeps an unreadable record instead of overwriting it", async () => {
      const dir = tmpDist(MANIFEST);
      const stateDir = path.join(dir, ".extension.dev");
      fs.mkdirSync(stateDir);
      fs.writeFileSync(path.join(stateDir, "shared-previews.json"), "not json");
      process.env.EXTENSION_DEV_TOKEN = "tok_test";
      global.fetch = (async () => ({
        ok: true,
        status: 201,
        text: async () =>
          JSON.stringify({
            artifactId: "gen_keep",
            previewUrl: "https://preview.extension.dev/?preview=gen_keep",
            revokeUrl: "https://www.extension.dev/api/artifacts/gen_keep",
          }),
      })) as unknown as typeof fetch;
      try {
        const out = JSON.parse(
          await handler({ projectPath: dir, build: false, distPath: dir, probe: false, share: true }),
        );
        expect(out.share.record.recorded).toBe(true);
        expect(String(out.share.record.preserved)).toMatch(/unreadable\.json$/);
        expect(fs.readFileSync(out.share.record.preserved, "utf8")).toBe("not json");
        const written = JSON.parse(
          fs.readFileSync(out.share.record.path, "utf8"),
        );
        expect(written.shares).toHaveLength(1);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it("still returns the share when the record cannot be written", async () => {
      const dir = tmpDist(MANIFEST);
      fs.writeFileSync(path.join(dir, ".extension.dev"), "in the way");
      process.env.EXTENSION_DEV_TOKEN = "tok_test";
      global.fetch = (async () => ({
        ok: true,
        status: 201,
        text: async () =>
          JSON.stringify({
            artifactId: "gen_nowrite",
            previewUrl: "https://preview.extension.dev/?preview=gen_nowrite",
            revokeUrl: "https://www.extension.dev/api/artifacts/gen_nowrite",
          }),
      })) as unknown as typeof fetch;
      try {
        const out = JSON.parse(
          await handler({ projectPath: dir, build: false, distPath: dir, probe: false, share: true }),
        );
        expect(out.share.ok).toBe(true);
        expect(out.share.previewUrl).toBeTruthy();
        expect(out.share.record.recorded).toBe(false);
        expect(String(out.share.note)).toMatch(/only copy/);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it("writes no record when the upload fails", async () => {
      const dir = tmpDist(MANIFEST);
      process.env.EXTENSION_DEV_TOKEN = "tok_test";
      global.fetch = (async () => ({
        ok: false,
        status: 500,
        text: async () => JSON.stringify({ message: "Server error." }),
      })) as unknown as typeof fetch;
      try {
        const out = JSON.parse(
          await handler({ projectPath: dir, build: false, distPath: dir, probe: false, share: true }),
        );
        expect(out.share.ok).toBe(false);
        expect(out.share.record).toBeUndefined();
        expect(fs.existsSync(path.join(dir, ".extension.dev"))).toBe(false);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it("keeps the local preview working when the upload fails", async () => {
      const dir = tmpDist(MANIFEST);
      process.env.EXTENSION_DEV_TOKEN = "tok_test";
      global.fetch = (async () => ({
        ok: false,
        status: 413,
        text: async () => JSON.stringify({ message: "Payload is too large." }),
      })) as unknown as typeof fetch;
      try {
        const out = JSON.parse(
          await handler({ projectPath: dir, build: false, distPath: dir, probe: false, share: true }),
        );
        expect(out.ok).toBe(true);
        expect(out.deepLink).toBeTruthy();
        expect(out.share.ok).toBe(false);
        expect(out.share.supported).toBe(true);
        expect(String(out.share.reason)).toMatch(/too large/i);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});
