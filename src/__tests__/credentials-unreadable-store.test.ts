import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  CredentialStoreUnreadableError,
  credentialsPath,
  inspectCredentialStore,
  listCredentials,
  readCredentials,
  writeCredentialBatch,
  writeCredentials,
  type StoredCredentials,
} from "../lib/credentials";
import { persistTokenResponse } from "../lib/login-flow";
import { readIdentity } from "../tools/whoami";

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

let tmp: string;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ["XDG_CONFIG_HOME", "EXTENSION_DEV_TOKEN", "EXTENSION_DEV_PROJECT"]) {
    saved[key] = process.env[key];
  }
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "extdev-creds-unreadable-"));
  process.env.XDG_CONFIG_HOME = tmp;
  delete process.env.EXTENSION_DEV_TOKEN;
  delete process.env.EXTENSION_DEV_PROJECT;
});

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    fs.chmodSync(path.join(tmp, "extension-dev"), 0o700);
    fs.chmodSync(credentialsPath(), 0o600);
  } catch {
    // The cell may not have created them.
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

function seedTwo(): string {
  writeCredentials(login("alpha"));
  writeCredentials(login("beta"));
  return credentialsPath();
}

function corrupt(file: string, how: "truncated" | "newer" | "array" | "no-entries") {
  const text = fs.readFileSync(file, "utf8");
  if (how === "truncated") fs.writeFileSync(file, text.slice(0, text.length - 20));
  if (how === "newer") {
    fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(text), version: 3 }));
  }
  if (how === "array") fs.writeFileSync(file, "[]");
  if (how === "no-entries") fs.writeFileSync(file, JSON.stringify({ version: 2, active: null }));
}

describe("a login store that cannot be read is never written over", () => {
  it.each(["truncated", "newer", "array", "no-entries"] as const)(
    "refuses a single login over a %s store and leaves its bytes alone",
    (how) => {
      const file = seedTwo();
      corrupt(file, how);
      const before = fs.readFileSync(file, "utf8");

      expect(() => writeCredentials(login("gamma"))).toThrow(
        CredentialStoreUnreadableError,
      );
      expect(fs.readFileSync(file, "utf8")).toBe(before);
    },
  );

  it("refuses a batch login over a store a newer client wrote", () => {
    const file = seedTwo();
    corrupt(file, "newer");
    const before = fs.readFileSync(file, "utf8");

    expect(() => writeCredentialBatch([login("delta"), login("epsilon")])).toThrow(
      /version 3 store/,
    );
    expect(fs.readFileSync(file, "utf8")).toBe(before);
  });

  it("refuses when the file exists and this user may not read it", () => {
    if (process.platform === "win32" || process.getuid?.() === 0) return;
    const file = seedTwo();
    fs.chmodSync(file, 0o000);

    expect(() => writeCredentials(login("gamma"))).toThrow(/could not be read \(EACCES\)/);
    fs.chmodSync(file, 0o600);
    expect(listCredentials().map((entry) => entry.key).sort()).toEqual([
      "acme/alpha",
      "acme/beta",
    ]);
  });

  it("says in the refusal that nothing was stored and how to get unstuck", () => {
    const file = seedTwo();
    corrupt(file, "truncated");

    let message = "";
    try {
      persistTokenResponse({
        apiBase: "https://www.extension.dev",
        project: "acme/gamma",
        data: { token: "tok", workspaceSlug: "acme", projectSlug: "gamma", expiresAt: FUTURE },
      });
    } catch (err) {
      message = String((err as Error).message);
    }
    expect(message).toContain(file);
    expect(message).toContain("nothing was stored");
    expect(message).toContain("extension_auth (action: logout)");
  });

  it("still writes when there is no store, an empty file, or a store with no usable entry", () => {
    writeCredentials(login("alpha"));
    expect(readCredentials()?.projectSlug).toBe("alpha");

    fs.writeFileSync(credentialsPath(), "");
    writeCredentials(login("beta"));
    expect(listCredentials().map((entry) => entry.key)).toEqual(["acme/beta"]);

    fs.writeFileSync(credentialsPath(), JSON.stringify({ version: 2, active: null, entries: {} }));
    writeCredentials(login("gamma"));
    expect(listCredentials().map((entry) => entry.key)).toEqual(["acme/gamma"]);
  });
});

describe("the store is replaced whole", () => {
  it("leaves no temp or lock file behind after a write", () => {
    const file = seedTwo();

    expect(fs.readdirSync(path.dirname(file)).sort()).toEqual(["auth.json"]);
  });

  it("keeps the old store, and no stray temp file, when the replace cannot happen", () => {
    const file = seedTwo();
    const before = fs.readFileSync(file, "utf8");
    const rename = vi.spyOn(fs, "renameSync").mockImplementation(() => {
      throw Object.assign(new Error("EROFS: read-only file system"), { code: "EROFS" });
    });

    try {
      expect(() => writeCredentials(login("gamma"))).toThrow(/EROFS/);
    } finally {
      rename.mockRestore();
    }
    expect(fs.readFileSync(file, "utf8")).toBe(before);
    expect(fs.readdirSync(path.dirname(file)).sort()).toEqual(["auth.json"]);
  });

  it("takes over a lock a dead writer left and still stores the login", () => {
    const file = seedTwo();
    const lock = `${file}.lock`;
    fs.writeFileSync(lock, "");
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(lock, old, old);

    writeCredentials(login("gamma"));
    expect(listCredentials().map((entry) => entry.key).sort()).toEqual([
      "acme/alpha",
      "acme/beta",
      "acme/gamma",
    ]);
    expect(fs.existsSync(lock)).toBe(false);
  });

  it("refuses, and stores nothing, while another writer holds a fresh lock", () => {
    const file = seedTwo();
    const lock = `${file}.lock`;
    const before = fs.readFileSync(file, "utf8");
    fs.writeFileSync(lock, "");
    const realNow = Date.now;
    const realStat = fs.statSync;
    let clock = realNow();
    const now = vi.spyOn(Date, "now").mockImplementation(() => {
      clock += 400;
      return clock;
    });
    const stat = vi.spyOn(fs, "statSync").mockImplementation(((target: fs.PathLike) =>
      String(target) === lock
        ? ({ mtimeMs: clock } as fs.Stats)
        : realStat(target)) as typeof fs.statSync);

    try {
      expect(() => writeCredentials(login("gamma"))).toThrow(/Another process is writing/);
    } finally {
      now.mockRestore();
      stat.mockRestore();
      fs.rmSync(lock, { force: true });
    }
    expect(fs.readFileSync(file, "utf8")).toBe(before);
    expect(fs.existsSync(`${file}.lock`)).toBe(false);
  });
});

describe("status tells an unreadable store from a logged-out machine", () => {
  it("answers logged-out only when no store exists", async () => {
    const out = JSON.parse(await readIdentity());

    expect(out.status).toBe("logged-out");
    expect(inspectCredentialStore()).toEqual({ state: "absent" });
  });

  it("answers store-unreadable, not logged-out, for a store it cannot parse", async () => {
    const file = seedTwo();
    corrupt(file, "truncated");
    const out = JSON.parse(await readIdentity());

    expect(out.ok).toBe(false);
    expect(out.status).toBe("store-unreadable");
    expect(out.error.message).toContain(file);
    expect(out.hint).toContain("This is not a logged-out machine");
  });
});
