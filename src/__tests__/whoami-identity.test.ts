import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  writeCredentials,
  type StoredCredentials,
} from "../lib/credentials";
import * as auth from "../tools/auth";

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
    if (process.platform === "win32") return;
    writeCredentials(sample());

    const result = JSON.parse(await auth.handler({}));

    expect(result.status).toBe("logged-in");
    expect(result.hint).toContain("acme/widget");
    expect(result.hint).toContain("extension_auth");
    expect(result.hint).toMatch(/not follow|not.*current working directory/i);
    expect(result.value.expiresAt).toBe(new Date(FUTURE * 1000).toISOString());
    expect(typeof result.value.expiresInSeconds).toBe("number");
  });

  it("the tool description anchors identity to the stored token", () => {
    expect(auth.schema.description).toContain("extension.dev/device");
    expect(auth.schema.description).toMatch(
      /does not change with the current working directory/i,
    );
  });

  it("still reports logged-out plainly when nothing is stored", async () => {
    if (process.platform === "win32") return;

    const result = JSON.parse(await auth.handler({}));

    expect(result.status).toBe("logged-out");
    expect(result.hint).toContain("extension_auth");
  });

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

      const result = JSON.parse(await auth.handler({}));

      expect(result.value.api).toBeUndefined();
      expect(result.value.apiRecordedAtLogin).toBe("https://www.extension.dev");
      expect(result.value.apiDefault).toBe("https://www.extension.dev");
    });

    it("flags a stale localhost login base instead of presenting it as the api", async () => {
      if (process.platform === "win32") return;
      writeCredentials(sample({ api: "http://localhost:3100" }));

      const result = JSON.parse(await auth.handler({}));

      expect(result.value.api).toBeUndefined();
      expect(result.value.apiRecordedAtLogin).toBe("http://localhost:3100");
      expect(result.value.apiDefault).toBe("https://www.extension.dev");
      expect(result.hint).toContain("minted via http://localhost:3100");
      expect(result.hint).toContain(
        "access grants for private registry reads use that recorded base",
      );
      expect(result.hint).not.toContain("do not read that recorded value");
      expect(result.hint).toContain("https://www.extension.dev");
      expect(
        result.warnings.some((w: string) =>
          w.includes("minted via http://localhost:3100"),
        ),
      ).toBe(true);
    });

    it("omits the recorded base entirely when the stored file never had one", async () => {
      if (process.platform === "win32") return;
      writeCredentials(sample({ api: "" }));

      const result = JSON.parse(await auth.handler({}));

      expect(result.value.api).toBeUndefined();
      expect(result.value.apiRecordedAtLogin).toBeUndefined();
      expect(result.value.apiDefault).toBe("https://www.extension.dev");
    });

    it("discloses that EXTENSION_DEV_TOKEN outranks the stored login", async () => {
      if (process.platform === "win32") return;
      const prevToken = process.env.EXTENSION_DEV_TOKEN;
      process.env.EXTENSION_DEV_TOKEN = "env-token";
      try {
        writeCredentials(sample());
        const result = JSON.parse(await auth.handler({}));
        expect(result.value.envTokenOverride).toBeUndefined();
        expect(
          result.warnings.some((w: string) =>
            w.includes("EXTENSION_DEV_TOKEN is set"),
          ),
        ).toBe(true);
        expect(result.hint).toContain("EXTENSION_DEV_TOKEN is set");
      } finally {
        if (prevToken === undefined) delete process.env.EXTENSION_DEV_TOKEN;
        else process.env.EXTENSION_DEV_TOKEN = prevToken;
      }
    });
  });
});

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

  it("extension_auth states the TTL and where CI re-mints", () => {
    expect(auth.schema.description).toContain("7 days");
    expect(auth.schema.description).toContain("Access tokens");
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

    const result = JSON.parse(await auth.handler({}));

    const ttlNote = result.warnings.find((w: string) => w.includes("7 days"));
    expect(ttlNote).toContain("7 days");
    expect(ttlNote).toContain(
      "https://console.extension.dev/acme/widget/settings/access-tokens",
    );
  });

  it("token-gated tools state the TTL wherever they point at Access tokens", async () => {
    const submit = await import("../tools/submit");
    const promote = await import("../tools/release-promote");
    expect(submit.schema.description).toContain("7 days");
    expect(promote.schema.description).toContain("7 days");
  });
});
