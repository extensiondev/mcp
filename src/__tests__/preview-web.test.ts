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
      expect(out.value.built).toBe(false);
      expect(out.value.manifest).toMatchObject({
        name: "Probe Ext",
        version: "1.2.3",
        manifestVersion: 3,
      });
      expect(out.value.surfaces).toEqual(
        expect.arrayContaining(["popup", "background-worker"]),
      );
      expect(new URL(out.value.deepLink).port).toBe("3110");
      const internal = new URL(out.value.deepLink).searchParams.get("url") ?? "";
      expect(internal.startsWith("preview://build/")).toBe(true);
      const b64 = internal.slice("preview://build/".length);
      expect(Buffer.from(b64, "base64url").toString("utf8")).toBe(
        path.resolve(dir),
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("honours hostUrl and keeps preview as the only door", async () => {
    const dir = tmpDist(MANIFEST);
    try {
      const overridden = JSON.parse(
        await handler({
          projectPath: dir,
          build: false,
          distPath: dir,
          probe: false,
          hostUrl: "http://localhost:4321/",
        }),
      );
      expect(new URL(overridden.value.deepLink).port).toBe("4321");

      const staleArgs = {
        projectPath: dir,
        build: false,
        distPath: dir,
        probe: false,
        surface: "inspect",
        inspectUrl: "http://localhost:3106",
      };
      const stale = JSON.parse(await handler(staleArgs));
      expect(new URL(stale.value.deepLink).port).toBe("3110");
      const internal = new URL(stale.value.deepLink).searchParams.get("url") ?? "";
      expect(internal.startsWith("preview://build/")).toBe(true);
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
      expect(out.value.hostReachable).toBe(true);
      expect(out.value.previewLoadable).toBe(true);
      expect(out.value.probe.fileCount).toBe(3);
      expect(out.value.probe.identifier).toBe("preview-abc");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails when the surface is unreachable, rather than reporting a link that cannot open", async () => {
    const dir = tmpDist(MANIFEST);
    const cwd = process.cwd();
    global.fetch = (async () => {
      throw new Error("fetch failed");
    }) as unknown as typeof fetch;
    try {
      process.chdir(os.tmpdir());
      const out = JSON.parse(
        await handler({ projectPath: dir, build: false, distPath: dir }),
      );
      expect(out.ok).toBe(false);
      expect(out.error.code).toBe("E_PREVIEW_HOST_UNREACHABLE");
      expect(out.value.hostReachable).toBe(false);
      expect(out.value.previewLoadable).toBe(false);
      expect(out.error.message).toMatch(/share:true/);
      expect(out.warnings.join(" ")).toMatch(/no npm install of this server/);
    } finally {
      process.chdir(cwd);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("names the dev command only when a monorepo checkout is actually present", async () => {
    const dir = tmpDist(MANIFEST);
    const checkout = fs.mkdtempSync(path.join(os.tmpdir(), "preview-checkout-"));
    const appDir = path.join(checkout, "apps", "web", "preview.extension.dev");
    fs.mkdirSync(appDir, { recursive: true });
    fs.writeFileSync(
      path.join(appDir, "package.json"),
      JSON.stringify({ name: "preview.extension.dev" }),
    );
    const nested = path.join(checkout, "packages", "probe");
    fs.mkdirSync(nested, { recursive: true });
    global.fetch = (async () => {
      throw new Error("fetch failed");
    }) as unknown as typeof fetch;
    try {
      const out = JSON.parse(
        await handler({ projectPath: nested, build: false, distPath: dir }),
      );
      expect(out.ok).toBe(false);
      expect(out.warnings.join(" ")).toMatch(/Start it/);
      expect(out.warnings.join(" ")).toContain(checkout);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(checkout, { recursive: true, force: true });
    }
  });

  it("refuses a hostUrl that is not a local preview server", async () => {
    const dir = tmpDist(MANIFEST);
    let reached = false;
    global.fetch = (async () => {
      reached = true;
      throw new Error("should never be called");
    }) as unknown as typeof fetch;
    try {
      const out = JSON.parse(
        await handler({
          projectPath: dir,
          build: false,
          distPath: dir,
          hostUrl: "https://evil.example",
        }),
      );
      expect(out.ok).toBe(false);
      expect(out.error.code).toBe("E_BAD_HOST_URL");
      expect(reached).toBe(false);
      expect(JSON.stringify(out)).not.toContain(dir);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("still accepts a local preview server on another port", async () => {
    const dir = tmpDist(MANIFEST);
    global.fetch = jsonFetch(
      JSON.stringify({
        identifier: "preview-abc",
        version: "1.0.0",
        manifest: { name: "Fixture" },
        files: [1, 2, 3],
      }),
      "application/json",
    );
    try {
      const out = JSON.parse(
        await handler({
          projectPath: dir,
          build: false,
          distPath: dir,
          hostUrl: "http://127.0.0.1:4321",
        }),
      );
      expect(out.ok).toBe(true);
      expect(out.value.deepLink).toContain("http://127.0.0.1:4321");
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
      expect(out.value.hostReachable).toBe(true);
      expect(out.value.previewLoadable).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("errors when the dist manifest is not valid JSON", async () => {
    const dir = tmpDist();
    fs.writeFileSync(path.join(dir, "manifest.json"), "{ not json");
    try {
      const out = JSON.parse(
        await handler({ projectPath: dir, build: false, distPath: dir, probe: false }),
      );
      expect(out.ok).toBe(false);
      expect(out.status).toBe("bad-dist-manifest");
      expect(out.error.code).toBe("E_BAD_MANIFEST");
      expect(out.value.stage).toBe("resolve-dist");
      expect(out.value.distDir).toBe(path.resolve(dir));
      expect(out.error.message).toContain("not valid JSON");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not read a directory of the same name as a manifest", async () => {
    const dir = tmpDist();
    fs.mkdirSync(path.join(dir, "manifest.json"));
    try {
      const out = JSON.parse(
        await handler({ projectPath: dir, build: false, distPath: dir, probe: false }),
      );
      expect(out.ok).toBe(false);
      expect(out.status).toBe("bad-dist-manifest");
      expect(out.error.code).toBe("E_BAD_MANIFEST");
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
      expect(out.status).toBe("no-dist");
      expect(out.value.stage).toBe("resolve-dist");
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
      expect(out.value.deepLink).toBeTruthy();
      expect(out.value.opened).toBeDefined();
      expect(out.value.opened.ok).not.toBe(true);
      expect(out.warnings.join(" ")).toMatch(/live dev session/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  describe("the remedy it prints is one the reader could actually run", () => {
    function unreachable() {
      global.fetch = (async () => {
        throw new Error("fetch failed");
      }) as unknown as typeof fetch;
    }

    function fakeCheckout(): string {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "preview-monorepo-"));
      const app = path.join(root, "apps", "web", "preview.extension.dev");
      fs.mkdirSync(app, { recursive: true });
      fs.writeFileSync(
        path.join(app, "package.json"),
        JSON.stringify({ name: "preview.extension.dev" }),
      );
      return root;
    }

    it("sends an npm install to share:true and never to a pnpm filter", async () => {
      const dir = tmpDist(MANIFEST);
      vi.spyOn(process, "cwd").mockReturnValue(dir);
      unreachable();
      try {
        const out = JSON.parse(
          await handler({ projectPath: dir, build: false, distPath: dir }),
        );
        const everything = [
          out.error.message,
          out.hint,
          ...(out.warnings ?? []),
        ].join(" ");
        expect(everything).not.toContain("pnpm");
        expect(out.error.message).toContain("share:true");
        expect(out.hint).toContain("share:true");
        expect(out.warnings.join(" ")).toContain("share:true");
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it("names the dev command only from a checkout that carries the app", async () => {
      const root = fakeCheckout();
      const dir = path.join(root, "widget", "dist", "chrome");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(MANIFEST));
      vi.spyOn(process, "cwd").mockReturnValue(os.tmpdir());
      unreachable();
      try {
        const out = JSON.parse(
          await handler({ projectPath: dir, build: false, distPath: dir }),
        );
        expect(out.error.message).toContain(
          "pnpm --filter preview.extension.dev dev",
        );
        expect(out.error.message).toContain(root);
        expect(out.error.message).toContain("share:true");
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

    it("puts the lane that works for everyone first in the description", () => {
      expect(schema.description).not.toContain("pnpm");
      const share = schema.description.indexOf("share:true");
      const local = schema.description.indexOf("preview://build");
      expect(share).toBeGreaterThan(-1);
      expect(share).toBeLessThan(local);
      expect(schema.description).toMatch(/developing extension\.dev itself/);
      expect(
        (schema.inputSchema.properties as any).share.description,
      ).toMatch(/zip|hands over/i);
    });
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
        expect(out.value.deepLink).toBeTruthy();
        expect(out.value.share.requested).toBe(true);
        expect(out.value.share.ok).toBe(false);
        expect(out.value.share.supported).toBe(false);
        expect(String(out.value.share.loginHint)).toMatch(/extension_auth/);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    function shareFleet(zipHops: Record<string, Response | (() => Response)>) {
      const uploaded = {
        artifactId: "gen_cors",
        previewUrl: "https://preview.extension.dev/?preview=gen_cors",
        zipUrl: "https://www.extension.dev/api/artifacts/gen_cors/source.zip",
        revokeUrl: "https://www.extension.dev/api/artifacts/gen_cors",
        expiresAt: "2026-08-23T00:00:00.000Z",
      };
      global.fetch = (async (input: any, init: any) => {
        const url = String(input);
        if (init?.method === "POST") {
          return new Response(JSON.stringify(uploaded), {
            status: 201,
            headers: { "content-type": "application/json" },
          });
        }
        if (url.includes("/__preview/fetch")) {
          return new Response("not here", {
            status: 404,
            headers: { "content-type": "text/plain" },
          });
        }
        const hop = zipHops[url];
        if (!hop) throw new Error(`unrouted ${url}`);
        return typeof hop === "function" ? hop() : hop;
      }) as unknown as typeof fetch;
      return uploaded;
    }

    it("refuses to certify a share whose zip a browser cannot read", async () => {
      const dir = tmpDist(MANIFEST);
      process.env.EXTENSION_DEV_TOKEN = "tok_test";
      const signed = "https://acct.r2.cloudflarestorage.com/b/gen_cors.zip?s=1";
      const uploaded = shareFleet({
        ["https://www.extension.dev/api/artifacts/gen_cors/source.zip"]: () =>
          new Response(null, {
            status: 302,
            headers: {
              location: signed,
              "access-control-allow-origin": "*",
            },
          }),
        [signed]: () =>
          new Response(null, {
            status: 200,
            headers: { "content-type": "application/zip" },
          }),
      });
      try {
        const out = JSON.parse(
          await handler({ projectPath: dir, build: false, distPath: dir, share: true }),
        );
        expect(out.value.share.ok).toBe(true);
        expect(out.value.share.previewUrl).toBe(uploaded.previewUrl);
        expect(out.value.share.browserLoadable).toBe(false);
        expect(out.value.share.browserCheck.finalUrl).toBe(signed);
        expect(out.value.share.browserCheck.finalStatus).toBe(200);
        expect(out.value.share.browserCheck.allowOrigin).toBeNull();
        expect(out.value.previewLoadable).not.toBe(true);
        expect(out.warnings.join(" ")).toMatch(/will not render for anyone/);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it("certifies a share when the final hop allows the preview origin", async () => {
      const dir = tmpDist(MANIFEST);
      process.env.EXTENSION_DEV_TOKEN = "tok_test";
      shareFleet({
        ["https://www.extension.dev/api/artifacts/gen_cors/source.zip"]: () =>
          new Response(null, {
            status: 200,
            headers: {
              "content-type": "application/zip",
              "access-control-allow-origin": "*",
            },
          }),
      });
      try {
        const out = JSON.parse(
          await handler({ projectPath: dir, build: false, distPath: dir, share: true }),
        );
        expect(out.value.share.browserLoadable).toBe(true);
        expect(out.value.share.browserCheck.redirects).toBe(0);
        expect(out.warnings.join(" ")).not.toMatch(/will not render/);
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
        expect(out.value.share.ok).toBe(true);
        expect(out.value.share.previewUrl).toBe(
          "https://preview.extension.dev/?preview=gen_abc123",
        );
        expect(out.value.share.serves).toBe("uploaded-local-build");
        expect(out.value.share.localBuildUploaded).toBe(true);
        expect(out.value.share.revokeUrl).toBeTruthy();
        expect(out.value.share.expiresAt).toBeTruthy();

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
        expect(first.value.share.record.recorded).toBe(true);
        expect(first.value.share.record.path).toBe(recordPath);
        expect(first.value.share.record.entries).toBe(1);
        expect(String(first.value.share.note)).toContain(recordPath);

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
        expect(second.value.share.record.entries).toBe(2);
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
        expect(out.value.share.record.gitignored).toBe("added");
        expect(out.value.share.record.warning).toBeUndefined();
        expect(fs.readFileSync(path.join(dir, ".gitignore"), "utf8")).toContain(
          ".extension.dev/",
        );

        const again = JSON.parse(
          await handler({ projectPath: dir, build: false, distPath: dir, probe: false, share: true }),
        );
        expect(again.value.share.record.gitignored).toBe("already-ignored");
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
        expect(out.value.share.record.recorded).toBe(true);
        expect(String(out.value.share.record.preserved)).toMatch(/unreadable\.json$/);
        expect(fs.readFileSync(out.value.share.record.preserved, "utf8")).toBe("not json");
        const written = JSON.parse(
          fs.readFileSync(out.value.share.record.path, "utf8"),
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
        expect(out.value.share.ok).toBe(true);
        expect(out.value.share.previewUrl).toBeTruthy();
        expect(out.value.share.record.recorded).toBe(false);
        expect(String(out.value.share.note)).toMatch(
          /Keep the revokeUrl in this response/,
        );
        expect(String(out.value.share.note)).toMatch(/extension_shares/);
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
        expect(out.value.share.ok).toBe(false);
        expect(out.value.share.record).toBeUndefined();
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
        expect(out.value.deepLink).toBeTruthy();
        expect(out.value.share.ok).toBe(false);
        expect(out.value.share.supported).toBe(true);
        expect(String(out.value.share.reason)).toMatch(/too large/i);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});
