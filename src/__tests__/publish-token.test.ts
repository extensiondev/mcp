import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeCredentials } from "../lib/credentials";
import { resolveToken } from "../tools/publish";

const FUTURE = Math.floor(Date.now() / 1000) + 3600;

function writeCreds(token: string, expiresAt = FUTURE) {
  writeCredentials({
    version: 1,
    token,
    workspaceSlug: "acme",
    projectSlug: "widget",
    expiresAt,
    api: "https://www.extension.dev",
  });
}

describe("publish resolveToken precedence", () => {
  let tmp: string;
  let prevXdg: string | undefined;
  let prevToken: string | undefined;

  beforeEach(() => {
    if (process.platform === "win32") return;
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "extdev-tok-"));
    prevXdg = process.env.XDG_CONFIG_HOME;
    prevToken = process.env.EXTENSION_DEV_TOKEN;
    process.env.XDG_CONFIG_HOME = tmp;
    delete process.env.EXTENSION_DEV_TOKEN;
  });

  afterEach(() => {
    if (process.platform === "win32") return;
    if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prevXdg;
    if (prevToken === undefined) delete process.env.EXTENSION_DEV_TOKEN;
    else process.env.EXTENSION_DEV_TOKEN = prevToken;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("prefers EXTENSION_DEV_TOKEN over the creds file", () => {
    if (process.platform === "win32") return;
    process.env.EXTENSION_DEV_TOKEN = "from-env";
    writeCreds("from-file");
    expect(resolveToken()).toBe("from-env");
  });

  it("falls back to the creds file when env is unset", () => {
    if (process.platform === "win32") return;
    writeCreds("from-file");
    expect(resolveToken()).toBe("from-file");
  });

  it("ignores an expired creds file", () => {
    if (process.platform === "win32") return;
    writeCreds("from-file", 1000);
    expect(resolveToken()).toBe("");
  });

  it("returns empty when neither env nor file is present", () => {
    if (process.platform === "win32") return;
    expect(resolveToken()).toBe("");
  });
});
