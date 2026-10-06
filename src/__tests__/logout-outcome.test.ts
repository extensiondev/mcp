import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  credentialsPath,
  listCredentials,
  readCredentials,
  writeCredentials,
  type StoredCredentials,
} from "../lib/credentials";
import { clearLocalCredentials } from "../tools/logout";

const FUTURE = Math.floor(Date.now() / 1000) + 3600;

function login(projectSlug: string): StoredCredentials {
  return {
    version: 1,
    token: `tok-${projectSlug}`,
    workspaceSlug: "acme",
    projectSlug,
    expiresAt: FUTURE,
    api: "https://www.extension.dev",
    provider: "extensiondev",
  };
}

function denied(code: string) {
  return () => {
    throw Object.assign(new Error(`${code}: operation not permitted`), { code });
  };
}

async function logout(project?: string) {
  return JSON.parse(await clearLocalCredentials(project));
}

let tmp: string;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ["XDG_CONFIG_HOME", "EXTENSION_DEV_TOKEN", "EXTENSION_DEV_PROJECT"]) {
    saved[key] = process.env[key];
  }
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "extdev-logout-"));
  process.env.XDG_CONFIG_HOME = tmp;
  delete process.env.EXTENSION_DEV_TOKEN;
  delete process.env.EXTENSION_DEV_PROJECT;
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("a logout says what was removed, and says so when nothing was", () => {
  it("removes the only login and says logged out", async () => {
    writeCredentials(login("solo"));
    const out = await logout("acme/solo");

    expect(out.ok).toBe(true);
    expect(out.status).toBe("logged-out");
    expect(out.value.removed).toEqual(["acme/solo"]);
    expect(fs.existsSync(credentialsPath())).toBe(false);
  });

  /*. */
  it("carries a revoke link for every login an unnamed logout removed", async () => {
    writeCredentials(login("one"));
    writeCredentials(login("two"));
    const out = await logout();

    expect(out.status).toBe("logged-out");
    expect(out.value.removed.sort()).toEqual(["acme/one", "acme/two"]);
    expect(Object.keys(out.value.revokeUrls).sort()).toEqual(["acme/one", "acme/two"]);
    expect(out.value.revokeUrls["acme/one"]).toMatch(/acme\/one.*settings\/access-tokens/);
    expect(out.value.revokeUrls["acme/two"]).toMatch(/acme\/two/);
  });

  it("does not say removed when the last login's file could not be deleted", async () => {
    writeCredentials(login("solo"));
    vi.spyOn(fs, "unlinkSync").mockImplementation(denied("EPERM"));
    const out = await logout("acme/solo");

    expect(out.ok).toBe(false);
    expect(out.status).toBe("logout-failed");
    expect(out.error.message).toContain("Nothing was removed");
    expect(out.error.message).toContain("EPERM");
    expect(out.value.removed).toEqual([]);
    expect(out.value.remaining).toEqual(["acme/solo"]);
    expect(out.hint).toContain("still stored on this machine");
    expect(out.hint).toContain("revoke the token");
    expect(readCredentials()?.token).toBe("tok-solo");
  });

  it("does not say nothing-to-clear over a store it could not delete", async () => {
    writeCredentials(login("alpha"));
    writeCredentials(login("beta"));
    vi.spyOn(fs, "unlinkSync").mockImplementation(denied("EACCES"));
    const out = await logout();

    expect(out.ok).toBe(false);
    expect(out.status).toBe("logout-failed");
    expect(out.error.message).toContain("could not be deleted (EACCES)");
    expect(out.value.remaining.sort()).toEqual(["acme/alpha", "acme/beta"]);
    expect(listCredentials()).toHaveLength(2);
  });

  it("keeps nothing-to-clear for a machine with no store at all", async () => {
    const out = await logout();

    expect(out.ok).toBe(true);
    expect(out.status).toBe("nothing-to-clear");
  });

  it("does not say removed when the store could not be rewritten without one login", async () => {
    writeCredentials(login("alpha"));
    writeCredentials(login("beta"));
    vi.spyOn(fs, "renameSync").mockImplementation(denied("EROFS"));
    const out = await logout("acme/alpha");

    expect(out.ok).toBe(false);
    expect(out.status).toBe("logout-failed");
    expect(out.error.message).toContain("acme/alpha");
    expect(out.value.remaining.sort()).toEqual(["acme/alpha", "acme/beta"]);
    expect(readCredentials({ project: "acme/alpha" })?.token).toBe("tok-alpha");
  });

  it("does not say no login matches when the store cannot be read", async () => {
    writeCredentials(login("alpha"));
    fs.writeFileSync(credentialsPath(), "{ not json");
    const out = await logout("acme/alpha");

    expect(out.ok).toBe(false);
    expect(out.status).toBe("logout-failed");
    expect(out.error.message).toContain("is not valid JSON");
    expect(out.error.message).toContain("acme/alpha");
  });

  it("still removes a store it cannot read when no project is named", async () => {
    writeCredentials(login("alpha"));
    fs.writeFileSync(credentialsPath(), "{ not json");
    const out = await logout();

    expect(out.ok).toBe(true);
    expect(out.status).toBe("logged-out");
    expect(fs.existsSync(credentialsPath())).toBe(false);
  });

  it("removes one of two and leaves the other", async () => {
    writeCredentials(login("alpha"));
    writeCredentials(login("beta"));
    const out = await logout("acme/alpha");

    expect(out.status).toBe("logged-out");
    expect(out.value.remaining).toEqual(["acme/beta"]);
    expect(listCredentials().map((entry) => entry.key)).toEqual(["acme/beta"]);
  });
});
