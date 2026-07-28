import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { listArtifacts, revokeArtifact } from "../lib/artifacts-api";
import { uploadPreview } from "../lib/preview-upload";
import { publish } from "../lib/publish";
import { RegistryAccessTokens } from "../lib/registry-access";
import { fetchRegistryJson } from "../lib/registry";
import { handler as submitHandler } from "../tools/submit";
import {
  INSTALL_HEADER,
  resetSessionIdentityForTests,
  SESSION_HEADER,
  TOOL_HEADER,
} from "../lib/session-identity";

const API = "https://www.extension.dev";
const HEX_128 = /^[0-9a-f]{32}$/;

/* @invariant The wire names are spelled out rather than imported, because the reader of
   these headers lives in another repo. Importing the constants from the module
   under test made a rename update the assertion with it, so the one change
   that actually breaks the server was the one this file could not see. */
const WIRE_INSTALL_HEADER = "x-extensiondev-install";
const WIRE_SESSION_HEADER = "x-extensiondev-session";
const WIRE_TOOL_HEADER = "x-extensiondev-tool";

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
    json: async () => body,
  } as unknown as Response;
}

function readIdentity(init: any): {
  install: string;
  session: string;
  tool: string;
} {
  const headers = (init?.headers ?? {}) as Record<string, string>;
  return {
    install: headers[WIRE_INSTALL_HEADER] ?? "",
    session: headers[WIRE_SESSION_HEADER] ?? "",
    tool: headers[WIRE_TOOL_HEADER] ?? "",
  };
}

it("sends the header names the platform actually reads", () => {
  expect(INSTALL_HEADER).toBe(WIRE_INSTALL_HEADER);
  expect(SESSION_HEADER).toBe(WIRE_SESSION_HEADER);
  expect(TOOL_HEADER).toBe(WIRE_TOOL_HEADER);
});

function expectIdentity(init: any, tool: string) {
  const identity = readIdentity(init);
  expect(identity.install).toMatch(HEX_128);
  expect(identity.session).toMatch(HEX_128);
  expect(identity.tool).toBe(tool);
  return identity;
}

function tmpDist(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-legs-dist-"));
  fs.writeFileSync(
    path.join(dir, "manifest.json"),
    JSON.stringify({ manifest_version: 3, name: "Legs", version: "1.0.0" }),
  );
  return dir;
}

describe("the six legs that terminate at www", () => {
  let configDir: string;
  let prevXdg: string | undefined;
  let prevToken: string | undefined;
  let prevFetch: typeof globalThis.fetch;

  beforeEach(() => {
    configDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-legs-config-"));
    prevXdg = process.env.XDG_CONFIG_HOME;
    prevToken = process.env.EXTENSION_DEV_TOKEN;
    prevFetch = globalThis.fetch;
    process.env.XDG_CONFIG_HOME = configDir;
    process.env.EXTENSION_DEV_TOKEN = "tok_legs";
    delete process.env.EXTENSION_DEV_NO_TELEMETRY;
    delete process.env.DO_NOT_TRACK;
    resetSessionIdentityForTests();
  });

  afterEach(() => {
    globalThis.fetch = prevFetch;
    if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prevXdg;
    if (prevToken === undefined) delete process.env.EXTENSION_DEV_TOKEN;
    else process.env.EXTENSION_DEV_TOKEN = prevToken;
    fs.rmSync(configDir, { recursive: true, force: true });
    resetSessionIdentityForTests();
  });

  it("leg 1: preview upload POSTs /api/artifacts as extension_preview_web", async () => {
    const dir = tmpDist();
    let captured: any = null;
    const fetchImpl = vi.fn(async (url: any, init: any) => {
      captured = { url: String(url), init };
      return jsonResponse({
        artifactId: "gen_" + "a".repeat(32),
        previewUrl: "https://preview.extension.dev/?preview=gen_abc",
      });
    });
    try {
      const out = await uploadPreview({
        distDir: dir,
        manifest: { name: "Legs", version: "1.0.0" },
        browser: "chrome",
        api: API,
        fetchImpl: fetchImpl as any,
      });
      expect(out.ok).toBe(true);
      expect(captured.url).toBe(`${API}/api/artifacts`);
      expectIdentity(captured.init, "extension_preview_web");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("leg 2: share listing GETs /api/artifacts as extension_shares", async () => {
    let captured: any = null;
    const fetchImpl = vi.fn(async (url: any, init: any) => {
      captured = { url: String(url), init };
      return jsonResponse({ artifacts: [] });
    });
    const out = await listArtifacts({ api: API, fetchImpl: fetchImpl as any });
    expect(out.ok).toBe(true);
    expect(captured.url).toContain("/api/artifacts");
    expectIdentity(captured.init, "extension_shares");
  });

  it("leg 3: share revoke DELETEs /api/artifacts/<id> as extension_shares", async () => {
    let captured: any = null;
    const fetchImpl = vi.fn(async (url: any, init: any) => {
      captured = { url: String(url), init };
      return jsonResponse({ revoked: true });
    });
    const out = await revokeArtifact({
      artifactId: "gen_" + "a".repeat(32),
      api: API,
      fetchImpl: fetchImpl as any,
    });
    expect(out.ok).toBe(true);
    expect(captured.init.method).toBe("DELETE");
    expectIdentity(captured.init, "extension_shares");
  });

  it("leg 4: publish POSTs /api/cli/publish as extension_publish", async () => {
    let captured: any = null;
    const fetchImpl = vi.fn(async (url: any, init: any) => {
      captured = { url: String(url), init };
      return jsonResponse({ shareUrl: "https://acme.extension.dev/widget" });
    });
    const out = await publish({ api: API, fetchImpl: fetchImpl as any });
    expect(out.ok).toBe(true);
    expect(captured.url).toBe(`${API}/api/cli/publish`);
    expectIdentity(captured.init, "extension_publish");
  });

  it("leg 5: submit POSTs /api/cli/stores/submit as extension_submit", async () => {
    let captured: any = null;
    globalThis.fetch = (async (url: any, init: any) => {
      captured = { url: String(url), init };
      return jsonResponse({ ok: true, dryRun: true, message: "Preflight OK" });
    }) as unknown as typeof fetch;

    await submitHandler({
      browsers: ["chrome"],
      buildSha: "abc1234",
      api: API,
    } as any);

    expect(captured.url).toBe(`${API}/api/cli/stores/submit`);
    expectIdentity(captured.init, "extension_submit");
  });

  it("leg 6: access grant POSTs /api/access-grant as extension_registry_access", async () => {
    let captured: any = null;
    const fetchImpl = vi.fn(async (url: any, init: any) => {
      const href = String(url);
      if (href.includes("/api/access-grant")) {
        captured = { url: href, init };
        return jsonResponse({
          token: "short-lived",
          expiresAt: Math.floor(Date.now() / 1000) + 600,
        });
      }
      if (href.includes("t=short-lived")) return jsonResponse({ ok: true });
      return jsonResponse({ message: "unauthorized" }, 401);
    });

    const res = await fetchRegistryJson(
      "https://registry.extension.dev/api/registry/acme/widget/x.json",
      fetchImpl as any,
      {
        ref: { workspace: "acme", project: "widget" },
        api: API,
        tokens: new RegistryAccessTokens({ fetchImpl: fetchImpl as any }),
      },
    );

    expect(res.ok).toBe(true);
    expect(captured).not.toBeNull();
    expectIdentity(captured.init, "extension_registry_access");
  });

  it("every leg in one process reports the same install and session", async () => {
    const seen: Array<{ install: string; session: string; tool: string }> = [];
    const fetchImpl = vi.fn(async (_url: any, init: any) => {
      seen.push(readIdentity(init));
      return jsonResponse({ artifacts: [] });
    });

    await listArtifacts({ api: API, fetchImpl: fetchImpl as any });
    await publish({ api: API, fetchImpl: fetchImpl as any });

    expect(seen).toHaveLength(2);
    expect(seen[0]!.install).toBe(seen[1]!.install);
    expect(seen[0]!.session).toBe(seen[1]!.session);
    expect(seen[0]!.tool).not.toBe(seen[1]!.tool);
  });

  it("sends no identity at all when the operator opted out", async () => {
    process.env.EXTENSION_DEV_NO_TELEMETRY = "1";
    let captured: any = null;
    const fetchImpl = vi.fn(async (url: any, init: any) => {
      captured = { url: String(url), init };
      return jsonResponse({ artifacts: [] });
    });
    await listArtifacts({ api: API, fetchImpl: fetchImpl as any });
    const headers = captured.init.headers as Record<string, string>;
    expect(headers[INSTALL_HEADER]).toBeUndefined();
    expect(headers[SESSION_HEADER]).toBeUndefined();
    expect(headers[TOOL_HEADER]).toBeUndefined();
    expect(headers.authorization).toBe("Bearer tok_legs");
  });

  it("carries nothing about the machine or the account beyond the three headers", async () => {
    let captured: any = null;
    const fetchImpl = vi.fn(async (url: any, init: any) => {
      captured = { url: String(url), init };
      return jsonResponse({ artifacts: [] });
    });
    await listArtifacts({ api: API, fetchImpl: fetchImpl as any });
    const headers = Object.keys(captured.init.headers as Record<string, string>);
    expect(headers.sort()).toEqual(
      ["accept", "authorization", INSTALL_HEADER, SESSION_HEADER, TOOL_HEADER].sort(),
    );
  });
});
