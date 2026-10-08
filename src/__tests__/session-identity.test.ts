import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { credentialsPath } from "../lib/credentials";

let identity = await import("../lib/session-identity");

const HEX_128 = /^[0-9a-f]{32}$/;

describe("session identity", () => {
  let tmp: string;
  let prevXdg: string | undefined;
  let prevNoTelemetry: string | undefined;
  let prevDoNotTrack: string | undefined;

  beforeEach(async () => {
    vi.resetModules();
    identity = await import("../lib/session-identity");
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-install-id-"));
    prevXdg = process.env.XDG_CONFIG_HOME;
    prevNoTelemetry = process.env.EXTENSION_DEV_NO_TELEMETRY;
    prevDoNotTrack = process.env.DO_NOT_TRACK;
    process.env.XDG_CONFIG_HOME = tmp;
    delete process.env.EXTENSION_DEV_NO_TELEMETRY;
    delete process.env.DO_NOT_TRACK;
  });

  afterEach(() => {
    if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prevXdg;
    if (prevNoTelemetry === undefined) {
      delete process.env.EXTENSION_DEV_NO_TELEMETRY;
    } else process.env.EXTENSION_DEV_NO_TELEMETRY = prevNoTelemetry;
    if (prevDoNotTrack === undefined) delete process.env.DO_NOT_TRACK;
    else process.env.DO_NOT_TRACK = prevDoNotTrack;

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("mints a random install id and persists it beside the credentials", () => {
    const id = identity.resolveInstallId();
    expect(id).toMatch(HEX_128);
    const file = identity.installIdentityPath();
    expect(path.dirname(file)).toBe(path.dirname(credentialsPath()));
    const stored = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(stored.version).toBe(1);
    expect(stored.installId).toBe(id);
    expect(typeof stored.rotatedAt).toBe("number");
  });

  it("keeps the same install id across processes inside the window", async () => {
    const first = identity.resolveInstallId();
    vi.resetModules();
    const nextProcess = await import("../lib/session-identity");
    expect(nextProcess.resolveInstallId()).toBe(first);
  });

  it("rotates the install id once the window has passed", () => {
    const start = Date.UTC(2026, 6, 1);
    const first = identity.resolveInstallId(start);
    expect(identity.resolveInstallId(start + identity.ROTATE_AFTER_MS - 1)).toBe(first);
    const rotated = identity.resolveInstallId(start + identity.ROTATE_AFTER_MS);
    expect(rotated).toMatch(HEX_128);
    expect(rotated).not.toBe(first);
  });

  it("does not encode the machine or the person", async () => {
    const id = identity.resolveInstallId();
    const leaks = [
      os.hostname(),
      os.userInfo().username,
      os.homedir(),
      process.platform,
    ];

    for (const leak of leaks) {
      expect(id).not.toContain(String(leak).toLowerCase());
    }

    vi.resetModules();
    const nextProcess = await import("../lib/session-identity");
    fs.rmSync(identity.installIdentityPath(), { force: true });
    expect(nextProcess.resolveInstallId()).not.toBe(id);
  });

  it("gives every process a different session id and holds it for the process", async () => {
    const first = identity.sessionId();
    expect(first).toMatch(HEX_128);
    expect(identity.sessionId()).toBe(first);
    vi.resetModules();
    const nextProcess = await import("../lib/session-identity");
    expect(nextProcess.sessionId()).not.toBe(first);
  });

  it("never persists the session id", () => {
    const session = identity.sessionId();
    identity.resolveInstallId();
    const stored = fs.readFileSync(identity.installIdentityPath(), "utf8");
    expect(stored).not.toContain(session);
  });

  it("builds the three headers and nothing else", () => {
    const headers = identity.identityHeaders("extension_publish");
    expect(Object.keys(headers).sort()).toEqual(
      [identity.INSTALL_HEADER, identity.SESSION_HEADER, identity.TOOL_HEADER].sort(),
    );

    expect(headers[identity.INSTALL_HEADER]).toMatch(HEX_128);
    expect(headers[identity.SESSION_HEADER]).toMatch(HEX_128);
    expect(headers[identity.TOOL_HEADER]).toBe("extension_publish");
  });

  it("refuses a tool name that is not a tool name", () => {
    expect(identity.identityHeaders("")).toEqual({});
    expect(identity.identityHeaders("extension publish!")).toEqual({});
    expect(identity.identityHeaders("a".repeat(65))).toEqual({});
  });

  it("sends nothing when the operator opted out", () => {
    process.env.EXTENSION_DEV_NO_TELEMETRY = "1";
    expect(identity.telemetryDisabled()).toBe(true);
    expect(identity.identityHeaders("extension_publish")).toEqual({});
    expect(identity.resolveInstallId()).toBe("");
    expect(identity.sessionId()).toBe("");
    expect(fs.existsSync(identity.installIdentityPath())).toBe(false);

    delete process.env.EXTENSION_DEV_NO_TELEMETRY;
    process.env.DO_NOT_TRACK = "1";
    expect(identity.identityHeaders("extension_publish")).toEqual({});
  });

  it("treats an explicit off value as opted in", () => {
    process.env.EXTENSION_DEV_NO_TELEMETRY = "0";
    expect(identity.telemetryDisabled()).toBe(false);
    process.env.EXTENSION_DEV_NO_TELEMETRY = "false";
    expect(identity.telemetryDisabled()).toBe(false);
  });

  it("falls back to a memory only id when the config dir cannot be written", () => {
    const blocked = path.join(tmp, "blocked");
    fs.writeFileSync(blocked, "not a directory");
    process.env.XDG_CONFIG_HOME = blocked;
    const id = identity.resolveInstallId();
    expect(id).toMatch(HEX_128);
    expect(identity.resolveInstallId()).toBe(id);
  });

  it("returns no headers rather than throwing when the home directory is gone", () => {
    delete process.env.XDG_CONFIG_HOME;
    const appData = process.env.APPDATA;
    const localAppData = process.env.LOCALAPPDATA;
    delete process.env.APPDATA;
    delete process.env.LOCALAPPDATA;
    const homedir = os.homedir;

    (os as { homedir: () => string }).homedir = () => {
      throw new Error("no home on this host");
    };

    try {
      expect(() => identity.identityHeaders("extension_publish")).not.toThrow();
      expect(identity.identityHeaders("extension_publish")).toEqual({});
    } finally {
      (os as { homedir: () => string }).homedir = homedir;
      if (appData !== undefined) process.env.APPDATA = appData;
      if (localAppData !== undefined) process.env.LOCALAPPDATA = localAppData;
    }
  });

  it("replaces a corrupted identity file rather than throwing", () => {
    const file = identity.installIdentityPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "{ not json");
    expect(identity.resolveInstallId()).toMatch(HEX_128);

    fs.writeFileSync(
      file,
      JSON.stringify({ version: 1, installId: "nope", rotatedAt: Date.now() }),
    );

    expect(identity.resolveInstallId()).toMatch(HEX_128);
  });
});
