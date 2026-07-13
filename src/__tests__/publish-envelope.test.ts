import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeCredentials } from "@extension.dev/core";
import { handler } from "../tools/publish";

// The extension_publish JSON-string envelopes are a frozen contract: agents
// pattern-match on PublishAuthError / PublishConfigError / PublishNetworkError
// / PublishError. These strings must stay byte-identical across the
// @extension.dev/core thin-adapter rewrite (MIGRATION.md phase 2).

describe("extension_publish envelope compatibility", () => {
  let tmp: string;
  let prevXdg: string | undefined;
  let prevToken: string | undefined;
  let prevApi: string | undefined;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "extdev-envelope-"));
    prevXdg = process.env.XDG_CONFIG_HOME;
    prevToken = process.env.EXTENSION_DEV_TOKEN;
    prevApi = process.env.EXTENSION_DEV_API_URL;
    process.env.XDG_CONFIG_HOME = tmp;
    delete process.env.EXTENSION_DEV_TOKEN;
    delete process.env.EXTENSION_DEV_API_URL;
  });

  afterEach(() => {
    if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prevXdg;
    if (prevToken === undefined) delete process.env.EXTENSION_DEV_TOKEN;
    else process.env.EXTENSION_DEV_TOKEN = prevToken;
    if (prevApi === undefined) delete process.env.EXTENSION_DEV_API_URL;
    else process.env.EXTENSION_DEV_API_URL = prevApi;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("returns the frozen PublishAuthError bytes when no token is available", async () => {
    const out = await handler({ projectPath: "/tmp/x" });
    expect(out).toBe(
      JSON.stringify({
        ok: false,
        error: {
          name: "PublishAuthError",
          message:
            "No token. Run extension_login, or set EXTENSION_DEV_TOKEN (create one in the extension.dev dashboard).",
        },
      }),
    );
  });

  it("returns the frozen PublishConfigError bytes for a plaintext api URL", async () => {
    process.env.EXTENSION_DEV_TOKEN = "tok_test";
    const out = await handler({
      projectPath: "/tmp/x",
      api: "http://evil.example.com",
    });
    expect(out).toBe(
      JSON.stringify({
        ok: false,
        error: {
          name: "PublishConfigError",
          message:
            "Refusing to send the access token to http://evil.example.com: use https (http is allowed only for localhost).",
        },
      }),
    );
  });

  it("prefers EXTENSION_DEV_TOKEN over stored credentials (resolution order)", async () => {
    writeCredentials({
      version: 1,
      token: "tok_stored",
      workspaceSlug: "acme",
      projectSlug: "widget",
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      api: "https://www.extension.dev",
    });
    // Non-localhost http still refuses BEFORE any network call, proving the
    // token was resolved (env wins) and then guarded.
    process.env.EXTENSION_DEV_TOKEN = "tok_env";
    const out = await handler({
      projectPath: "/tmp/x",
      api: "http://not-localhost.example",
    });
    expect(JSON.parse(out).error.name).toBe("PublishConfigError");
  });
});
