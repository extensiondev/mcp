import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  writeCredentials,
  type StoredCredentials,
} from "../lib/credentials";
import * as whoami from "../tools/whoami";
import * as login from "../tools/login";

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

// extension_whoami reports the STORED login, not anything about the current
// directory. A fresh-eyes walk read "Logged in to acme/widget" as "this
// project folder is acme/widget", so both the description and the message
// must anchor the identity to the token extension_login stored.
describe("whoami reports the stored token identity, not the cwd", () => {
  let tmp: string;
  let prevXdg: string | undefined;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "extdev-whoami-"));
    prevXdg = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = tmp;
  });

  afterEach(() => {
    if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prevXdg;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("says the identity comes from the stored token, not the directory", async () => {
    if (process.platform === "win32") return; // credentials path uses APPDATA
    writeCredentials(sample());

    const result = JSON.parse(await whoami.handler());

    expect(result.status).toBe("logged-in");
    expect(result.message).toContain("acme/widget");
    expect(result.message).toContain("extension_login");
    expect(result.message).toMatch(/not follow|not.*current working directory/i);
    // The praised expiry fields stay intact.
    expect(result.expiresAt).toBe(new Date(FUTURE * 1000).toISOString());
    expect(typeof result.expiresInSeconds).toBe("number");
  });

  it("the tool description anchors identity to the stored token", () => {
    expect(whoami.schema.description).toContain("extension_login");
    expect(whoami.schema.description).toMatch(
      /does not change with the current working directory/i,
    );
  });

  it("still reports logged-out plainly when nothing is stored", async () => {
    if (process.platform === "win32") return;

    const result = JSON.parse(await whoami.handler());

    expect(result.status).toBe("logged-out");
    expect(result.message).toContain("extension_login");
  });

  // The stored `api` only records which base extension_login was pointed at
  // when it minted the token; the authenticated tools never read it. A login
  // minted via a localhost dev server kept reporting `api:
  // http://localhost:3100` for a token that authenticates against prod, so
  // the field is now labeled as a record, never asserted as "the api".
  describe("api field honesty", () => {
    let prevApiUrl: string | undefined;
    let prevEnvToken: string | undefined;

    beforeEach(() => {
      prevApiUrl = process.env.EXTENSION_DEV_API_URL;
      prevEnvToken = process.env.EXTENSION_DEV_TOKEN;
      delete process.env.EXTENSION_DEV_API_URL;
      delete process.env.EXTENSION_DEV_TOKEN;
    });

    afterEach(() => {
      if (prevApiUrl === undefined) delete process.env.EXTENSION_DEV_API_URL;
      else process.env.EXTENSION_DEV_API_URL = prevApiUrl;
      if (prevEnvToken === undefined) delete process.env.EXTENSION_DEV_TOKEN;
      else process.env.EXTENSION_DEV_TOKEN = prevEnvToken;
    });

    it("never asserts a bare `api` field; labels the recorded login base", async () => {
      if (process.platform === "win32") return;
      writeCredentials(sample());

      const result = JSON.parse(await whoami.handler());

      expect(result.api).toBeUndefined();
      expect(result.apiRecordedAtLogin).toBe("https://www.extension.dev");
      expect(result.apiDefault).toBe("https://www.extension.dev");
    });

    it("flags a stale localhost login base instead of presenting it as the api", async () => {
      if (process.platform === "win32") return;
      writeCredentials(sample({ api: "http://localhost:3100" }));

      const result = JSON.parse(await whoami.handler());

      expect(result.api).toBeUndefined();
      expect(result.apiRecordedAtLogin).toBe("http://localhost:3100");
      expect(result.apiDefault).toBe("https://www.extension.dev");
      expect(result.message).toContain("minted via http://localhost:3100");
      expect(result.message).toContain(
        "do not read that recorded value",
      );
      expect(result.message).toContain("https://www.extension.dev");
    });

    it("omits the recorded base entirely when the stored file never had one", async () => {
      if (process.platform === "win32") return;
      writeCredentials(sample({ api: "" }));

      const result = JSON.parse(await whoami.handler());

      expect(result.api).toBeUndefined();
      expect(result.apiRecordedAtLogin).toBeUndefined();
      expect(result.apiDefault).toBe("https://www.extension.dev");
    });

    it("discloses that EXTENSION_DEV_TOKEN outranks the stored login", async () => {
      if (process.platform === "win32") return;
      const prevToken = process.env.EXTENSION_DEV_TOKEN;
      process.env.EXTENSION_DEV_TOKEN = "env-token";
      try {
        writeCredentials(sample());
        const result = JSON.parse(await whoami.handler());
        expect(result.envTokenOverride).toBe(true);
        expect(result.message).toContain("EXTENSION_DEV_TOKEN is set");
      } finally {
        if (prevToken === undefined) delete process.env.EXTENSION_DEV_TOKEN;
        else process.env.EXTENSION_DEV_TOKEN = prevToken;
      }
    });
  });
});

// The platform clamps CLI tokens to a 7-day TTL (server-owned). The MCP
// surface cannot change that, but it must SAY it wherever a CI author will
// look, or pipelines break silently a week after setup.
describe("7-day token TTL disclosure", () => {
  let tmp: string;
  let prevXdg: string | undefined;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "extdev-ttl-"));
    prevXdg = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = tmp;
  });

  afterEach(() => {
    if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prevXdg;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("extension_login's description states the TTL and where CI re-mints", () => {
    expect(login.schema.description).toContain("7 days");
    expect(login.schema.description).toContain("Access tokens");
  });

  it("whoami carries the TTL note with the deep console access-tokens URL", async () => {
    if (process.platform === "win32") return;
    writeCredentials({
      version: 1,
      token: "claims.sig",
      workspaceSlug: "acme",
      projectSlug: "widget",
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      api: "https://www.extension.dev",
    });

    const result = JSON.parse(await whoami.handler());

    expect(result.tokenTtlNote).toContain("7 days");
    expect(result.tokenTtlNote).toContain(
      "https://console.extension.dev/acme/widget/settings/access-tokens",
    );
  });

  it("token-gated tools state the TTL wherever they point at Access tokens", async () => {
    const deploy = await import("../tools/deploy");
    const promote = await import("../tools/release-promote");
    expect(deploy.schema.description).toContain("7 days");
    expect(promote.schema.description).toContain("7 days");
  });
});
