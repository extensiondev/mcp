import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, it, expect } from "vitest";
import { schema, handler } from "../tools/deploy";
import { tools as ALL_TOOLS } from "../index";

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

describe("extension_deploy: registration + schema", () => {
  it("is registered under the extension_deploy name", () => {
    expect(schema.name).toBe("extension_deploy");
    expect(ALL_TOOLS.map((t) => t.schema.name)).toContain("extension_deploy");
  });

  it("requires browsers + buildSha and exposes no credential/zip/path property", () => {
    const req = (schema.inputSchema as { required: string[] }).required;
    expect(req).toContain("browsers");
    expect(req).toContain("buildSha");
    const props = Object.keys(
      (schema.inputSchema as { properties: Record<string, unknown> }).properties,
    );
    for (const p of props) {
      expect(p).not.toMatch(
        /secret|token|apiKey|clientId|clientSecret|refreshToken|serviceAccount|zip|projectPath|publisherId/i,
      );
    }
  });
});

describe("extension_deploy: platform submit handler", () => {
  let tmp: string;
  let prevXdg: string | undefined;
  let prevToken: string | undefined;
  let prevFetch: typeof fetch;

  beforeEach(() => {
    // Isolate resolveToken: empty config dir (no stored login creds) + no env token.
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "extdev-deploy-"));
    prevXdg = process.env.XDG_CONFIG_HOME;
    prevToken = process.env.EXTENSION_DEV_TOKEN;
    prevFetch = global.fetch;
    process.env.XDG_CONFIG_HOME = tmp;
    delete process.env.EXTENSION_DEV_TOKEN;
  });

  afterEach(() => {
    if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prevXdg;
    if (prevToken === undefined) delete process.env.EXTENSION_DEV_TOKEN;
    else process.env.EXTENSION_DEV_TOKEN = prevToken;
    global.fetch = prevFetch;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("fails with DeployAuthError before any fetch when no token resolves", async () => {
    let called = false;
    global.fetch = (async () => {
      called = true;
      return jsonResponse({});
    }) as unknown as typeof fetch;
    const out = JSON.parse(
      await handler({ browsers: ["chrome"], buildSha: "abc1234" }),
    );
    expect(out.ok).toBe(false);
    expect(out.error.name).toBe("DeployAuthError");
    expect(called).toBe(false);
  });

  it("fails with DeployInputError before any fetch when browsers/buildSha missing", async () => {
    process.env.EXTENSION_DEV_TOKEN = "tok";
    let called = false;
    global.fetch = (async () => {
      called = true;
      return jsonResponse({});
    }) as unknown as typeof fetch;
    const noBrowsers = JSON.parse(
      await handler({ browsers: [], buildSha: "abc1234" }),
    );
    expect(noBrowsers.error.name).toBe("DeployInputError");
    const noSha = JSON.parse(
      await handler({ browsers: ["chrome"], buildSha: "" }),
    );
    expect(noSha.error.name).toBe("DeployInputError");
    expect(called).toBe(false);
  });

  it("POSTs to /api/cli/stores/submit with a bearer token, dry-run by default", async () => {
    process.env.EXTENSION_DEV_TOKEN = "tok-123";
    let captured: { url: string; init: any } | null = null;
    global.fetch = (async (url: string, init: any) => {
      captured = { url, init };
      return jsonResponse({ ok: true, dryRun: true, message: "Preflight OK" });
    }) as unknown as typeof fetch;

    const out = JSON.parse(
      await handler({
        browsers: ["chrome", "Firefox"],
        buildSha: "abc1234",
        api: "https://www.extension.dev",
      }),
    );

    expect(captured).not.toBeNull();
    expect(captured!.url).toBe("https://www.extension.dev/api/cli/stores/submit");
    expect(captured!.init.method).toBe("POST");
    expect(captured!.init.headers.authorization).toBe("Bearer tok-123");
    const body = JSON.parse(captured!.init.body);
    expect(body.browsers).toEqual(["chrome", "firefox"]); // lower-cased + trimmed
    expect(body.buildSha).toBe("abc1234");
    expect(body.dryRun).toBe(true); // irreversible submit -> safe default
    expect(out.mode).toBe("platform");
    expect(out.message).toBe("Preflight OK");
  });

  it("passes dryRun:false through only when explicitly set", async () => {
    process.env.EXTENSION_DEV_TOKEN = "tok";
    let body: any = null;
    global.fetch = (async (_url: string, init: any) => {
      body = JSON.parse(init.body);
      return jsonResponse({ ok: true, submissions: [] });
    }) as unknown as typeof fetch;
    await handler({ browsers: ["edge"], buildSha: "def5678", dryRun: false });
    expect(body.dryRun).toBe(false);
  });

  it("surfaces a non-OK response as DeployError", async () => {
    process.env.EXTENSION_DEV_TOKEN = "tok";
    global.fetch = (async () =>
      jsonResponse(
        { message: "Build not found", code: "UNKNOWN_BUILD" },
        false,
        404,
      )) as unknown as typeof fetch;
    const out = JSON.parse(
      await handler({ browsers: ["chrome"], buildSha: "deadbeef" }),
    );
    expect(out.ok).toBe(false);
    expect(out.error.name).toBe("DeployError");
    expect(out.error.message).toContain("404");
  });
});
