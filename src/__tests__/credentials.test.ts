import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  clearCredentials,
  credentialsPath,
  readCredentials,
  readValidCredentials,
  writeCredentials,
  type StoredCredentials,
} from "../lib/credentials";

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

describe("credentials store", () => {
  let tmp: string;
  let prevXdg: string | undefined;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "extdev-creds-"));
    prevXdg = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = tmp;
  });

  afterEach(() => {
    if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prevXdg;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("writes under XDG_CONFIG_HOME and round-trips", () => {
    if (process.platform === "win32") return; // path uses APPDATA on Windows
    const file = credentialsPath();
    expect(file).toBe(path.join(tmp, "extension-dev", "auth.json"));

    writeCredentials(sample());
    const read = readCredentials();
    expect(read).not.toBeNull();
    expect(read?.token).toBe("claims.sig");
    expect(read?.workspaceSlug).toBe("acme");
    expect(read?.projectSlug).toBe("widget");
  });

  it("writes the file 0600", () => {
    if (process.platform === "win32") return;
    const file = writeCredentials(sample());
    const mode = fs.statSync(file).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("readValidCredentials drops an expired token", () => {
    writeCredentials(sample({ expiresAt: 1000 })); // long past
    expect(readCredentials()).not.toBeNull();
    expect(readValidCredentials()).toBeNull();
  });

  it("readValidCredentials keeps a live token", () => {
    writeCredentials(sample({ expiresAt: FUTURE }));
    expect(readValidCredentials()?.token).toBe("claims.sig");
  });

  it("rejects an unknown version", () => {
    const file = credentialsPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ version: 2, token: "x" }));
    expect(readCredentials()).toBeNull();
  });

  it("clear removes the file", () => {
    writeCredentials(sample());
    expect(clearCredentials().cleared).toBe(true);
    expect(readCredentials()).toBeNull();
    // Clearing again is a no-op, not an error.
    expect(clearCredentials().cleared).toBe(false);
  });

  it("returns null when nothing is stored", () => {
    expect(readCredentials()).toBeNull();
  });
});
