import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  writeCredentials,
  type StoredCredentials,
} from "../lib/credentials";
import * as whoami from "../tools/whoami";

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
});
