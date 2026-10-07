/* @invariant one resolver answers the token and
 * the project it belongs to, read from the token's own claims for an env
 * token and from the stored login otherwise; a lane is closed on the
 * server's code only. */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { writeCredentials } from "../lib/credentials";
import { laneClosedByServer, readTokenClaims, resolveCredential } from "../lib/credential-source";

const FUTURE = Math.floor(Date.now() / 1000) + 3600;

function claimsToken(u: string, p: string, exp = FUTURE): string {
  return `${Buffer.from(JSON.stringify({ u, p, exp, n: "x", a: "cli" })).toString("base64url")}.sig`;
}

function login(workspace: string, project: string) {
  writeCredentials({ version: 1, token: `stored-${project}`, workspaceSlug: workspace, projectSlug: project, expiresAt: FUTURE, api: "https://www.extension.dev" });
}

let tmp = "";
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "extdev-credential-source-"));
  for (const key of ["XDG_CONFIG_HOME", "EXTENSION_DEV_TOKEN", "EXTENSION_DEV_PROJECT"]) saved[key] = process.env[key];
  process.env.XDG_CONFIG_HOME = tmp;
  delete process.env.EXTENSION_DEV_TOKEN;
  delete process.env.EXTENSION_DEV_PROJECT;
});

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("readTokenClaims", () => {
  it("reads the workspace, project and expiry off a platform token", () => {
    expect(readTokenClaims(claimsToken("Acme", "Widget", 123))).toEqual({ workspace: "acme", project: "widget", expiresAt: 123 });
  });

  it("answers null for a token with no readable claims", () => {
    expect(readTokenClaims("not-a-token")).toBeNull();
    expect(readTokenClaims("")).toBeNull();
    expect(readTokenClaims(`${Buffer.from("{}").toString("base64url")}.sig`)).toBeNull();
  });
});

describe("resolveCredential", () => {
  it("takes the env token and ITS project for an unnamed call, and names the mismatch with the active login", () => {
    login("acme", "widget");
    process.env.EXTENSION_DEV_TOKEN = claimsToken("acme", "ci-tool");
    const out = resolveCredential();
    expect(out.source).toBe("env");
    expect(out.ref).toEqual({ workspace: "acme", project: "ci-tool" });
    expect(out.refSource).toBe("env-claims");
    expect(out.mismatch).toEqual({ env: { workspace: "acme", project: "ci-tool" }, stored: { workspace: "acme", project: "widget" } });
    expect(out.note).toMatch(/belongs to acme\/ci-tool .* active stored login is acme\/widget/);
  });

  it("names no project when the env token's claims cannot be read, so nothing is enriched from another login", () => {
    login("acme", "widget");
    process.env.EXTENSION_DEV_TOKEN = "opaque";
    const out = resolveCredential();
    expect(out.token).toBe("opaque");
    expect(out.ref).toBeNull();
    expect(out.note).toMatch(/claims could not be read/);
  });

  it("sends the named project's stored login even when the env token is set", () => {
    login("acme", "widget");
    process.env.EXTENSION_DEV_TOKEN = claimsToken("acme", "ci-tool");
    const out = resolveCredential({ project: "acme/widget" });
    expect(out.source).toBe("stored");
    expect(out.token).toBe("stored-widget");
    expect(out.ref).toEqual({ workspace: "acme", project: "widget" });
    expect(out.mismatch).toBeNull();
  });

  it("answers no token for a named project with no stored login, naming it", () => {
    process.env.EXTENSION_DEV_TOKEN = claimsToken("acme", "ci-tool");
    const out = resolveCredential({ project: "acme/missing" });
    expect(out.token).toBe("");
    expect(out.source).toBe("none");
    expect(out.ref).toEqual({ workspace: "acme", project: "missing" });
    expect(out.note).toMatch(/No stored login for acme\/missing/);
  });

  it("uses the stored active login when no env token is set", () => {
    login("acme", "widget");
    const out = resolveCredential();
    expect(out).toMatchObject({ source: "stored", token: "stored-widget", ref: { workspace: "acme", project: "widget" }, note: null });
  });

  it("says when a pinned server's env token belongs elsewhere", () => {
    process.env.EXTENSION_DEV_PROJECT = "acme/pinned";
    process.env.EXTENSION_DEV_TOKEN = claimsToken("acme", "ci-tool");
    const out = resolveCredential();
    expect(out.source).toBe("env");
    expect(out.ref).toEqual({ workspace: "acme", project: "ci-tool" });
    expect(out.note).toMatch(/pinned to acme\/pinned/);
  });
});

describe("laneClosedByServer", () => {
  it("reads the server's code only, never digits in a sentence", () => {
    expect(laneClosedByServer({ message: "403 Forbidden from proxy" }, "CLI_PROJECT_CREATE_DISABLED")).toBe(false);
    expect(laneClosedByServer({ message: "x", serverCode: "CLI_PROJECT_CREATE_DISABLED" }, "CLI_PROJECT_CREATE_DISABLED")).toBe(true);
    expect(laneClosedByServer({ message: "CLI_PROJECT_CREATE_DISABLED mentioned" }, "CLI_PROJECT_CREATE_DISABLED")).toBe(false);
  });
});
