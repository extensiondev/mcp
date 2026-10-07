import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  clearCredentials,
  credentialsPath,
  listCredentials,
  readCredentials,
  readValidCredentials,
  tokenExpiry,
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
    if (process.platform === "win32") return;

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

  it("writes the containing directory 0700 (private secrets dir)", () => {
    if (process.platform === "win32") return;

    const file = writeCredentials(sample());
    const mode = fs.statSync(path.dirname(file)).mode & 0o777;
    expect(mode).toBe(0o700);
  });

  it("tightens a pre-existing world-readable dir to 0700", () => {
    if (process.platform === "win32") return;

    const dir = path.dirname(credentialsPath());
    fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
    fs.chmodSync(dir, 0o755);
    writeCredentials(sample());
    const mode = fs.statSync(dir).mode & 0o777;
    expect(mode).toBe(0o700);
  });

  it("readValidCredentials drops an expired token", () => {
    writeCredentials(sample({ expiresAt: 1000 }));
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
    expect(clearCredentials().cleared).toBe(false);
  });

  it("returns null when nothing is stored", () => {
    expect(readCredentials()).toBeNull();
  });
});

describe("several logins live side by side, one per workspace/project", () => {
  let tmp: string;
  let prevXdg: string | undefined;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "extdev-creds-multi-"));
    prevXdg = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = tmp;
  });

  afterEach(() => {
    if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prevXdg;

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("keeps the first login when a second project logs in, and makes the latest the default", () => {
    if (process.platform === "win32") return;

    writeCredentials(sample({ token: "t-widget", projectSlug: "widget" }));
    writeCredentials(sample({ token: "t-gadget", projectSlug: "gadget" }));

    expect(readCredentials()?.token).toBe("t-gadget");
    expect(readCredentials({ project: "acme/widget" })?.token).toBe("t-widget");
    expect(readCredentials({ project: "ACME/Widget" })?.token).toBe("t-widget");
    expect(readCredentials({ project: "widget" })?.token).toBe("t-widget");
    expect(readCredentials({ project: "acme/nothing" })).toBeNull();
    expect(listCredentials().map((e) => [e.key, e.active])).toEqual([
      ["acme/widget", false],
      ["acme/gadget", true],
    ]);
  });

  it("re-login to a known project replaces only that entry", () => {
    if (process.platform === "win32") return;

    writeCredentials(sample({ token: "t-widget", projectSlug: "widget" }));
    writeCredentials(sample({ token: "t-gadget", projectSlug: "gadget" }));
    writeCredentials(sample({ token: "t-widget-2", projectSlug: "widget" }));

    expect(listCredentials()).toHaveLength(2);
    expect(readCredentials({ project: "acme/widget" })?.token).toBe("t-widget-2");
    expect(readCredentials()?.token).toBe("t-widget-2");
  });

  it("reads a version 1 file as a store of one and rewrites it as version 2 on the next login", () => {
    if (process.platform === "win32") return;

    const file = credentialsPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(sample({ token: "legacy" })));

    expect(readCredentials()?.token).toBe("legacy");
    expect(readCredentials({ project: "acme/widget" })?.token).toBe("legacy");

    writeCredentials(sample({ token: "t-gadget", projectSlug: "gadget" }));
    const written = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(written.version).toBe(2);
    expect(Object.keys(written.entries).sort()).toEqual(["acme/gadget", "acme/widget"]);
    expect(readCredentials({ project: "acme/widget" })?.token).toBe("legacy");
  });

  it("logs one project out and leaves the others, moving the default when needed", () => {
    if (process.platform === "win32") return;

    writeCredentials(sample({ token: "t-widget", projectSlug: "widget" }));
    writeCredentials(sample({ token: "t-gadget", projectSlug: "gadget" }));

    const one = clearCredentials({ project: "acme/gadget" });
    expect(one.cleared).toBe(true);
    expect(one.removed).toEqual(["acme/gadget"]);
    expect(one.remaining).toEqual(["acme/widget"]);
    expect(readCredentials()?.token).toBe("t-widget");

    const missing = clearCredentials({ project: "acme/nothing" });
    expect(missing.cleared).toBe(false);

    const all = clearCredentials();
    expect(all.cleared).toBe(true);
    expect(fs.existsSync(credentialsPath())).toBe(false);
  });

  it("selects by project for the validity read too", () => {
    if (process.platform === "win32") return;

    writeCredentials(sample({ token: "fresh", projectSlug: "widget" }));
    writeCredentials(sample({ token: "stale", projectSlug: "gadget", expiresAt: 10 }));

    expect(readValidCredentials(undefined, { project: "acme/widget" })?.token).toBe("fresh");
    expect(readValidCredentials(undefined, { project: "acme/gadget" })).toBeNull();
  });
});

describe("a token that arrives without an expiry is not stored as eternal", () => {
  it("keeps a real expiry and gives a missing or garbled one the documented seven days", () => {
    const now = Math.floor(Date.now() / 1000);
    expect(tokenExpiry(1_900_000_000)).toBe(1_900_000_000);
    expect(tokenExpiry("1900000000")).toBe(1_900_000_000);

    for (const bad of [undefined, null, 0, -5, "soon", NaN]) {
      const got = tokenExpiry(bad);
      expect(got).toBeGreaterThanOrEqual(now + 7 * 24 * 3600 - 2);
      expect(got).toBeLessThanOrEqual(now + 7 * 24 * 3600 + 2);
    }
  });
});
