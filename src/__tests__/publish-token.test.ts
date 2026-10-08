import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { writeCredentials } from "../lib/credentials";
import { resolveToken } from "../lib/publish";

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

  it("ignores an expired creds file", () => {
    if (process.platform === "win32") return;

    writeCreds("from-file", 1000);
    expect(resolveToken()).toBe("");
  });

  it("lets an explicit project outrank EXTENSION_DEV_TOKEN and pick among stored logins", () => {
    if (process.platform === "win32") return;

    const future = Math.floor(Date.now() / 1000) + 3600;

    for (const [token, projectSlug] of [["t-widget", "widget"], ["t-gadget", "gadget"]] as const) {
      writeCredentials({
        version: 1,
        token,
        workspaceSlug: "acme",
        projectSlug,
        expiresAt: future,
        api: "https://www.extension.dev",
      });
    }

    process.env.EXTENSION_DEV_TOKEN = "from-env";

    expect(resolveToken()).toBe("from-env");
    expect(resolveToken({ project: "acme/widget" })).toBe("t-widget");
    expect(resolveToken({ project: "gadget" })).toBe("t-gadget");
    expect(resolveToken({ project: "acme/nothing" })).toBe("");
  });
});
