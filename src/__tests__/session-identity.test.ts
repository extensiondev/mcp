import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  identityHeaders,
  installIdentityPath,
  INSTALL_HEADER,
  resetSessionIdentityForTests,
  resolveInstallId,
  ROTATE_AFTER_MS,
  SESSION_HEADER,
  sessionId,
  telemetryDisabled,
  TOOL_HEADER,
} from "../lib/session-identity";

const HEX_128 = /^[0-9a-f]{32}$/;

describe("session identity", () => {
  let tmp: string;
  let prevXdg: string | undefined;
  let prevNoTelemetry: string | undefined;
  let prevDoNotTrack: string | undefined;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-install-id-"));
    prevXdg = process.env.XDG_CONFIG_HOME;
    prevNoTelemetry = process.env.EXTENSION_DEV_NO_TELEMETRY;
    prevDoNotTrack = process.env.DO_NOT_TRACK;
    process.env.XDG_CONFIG_HOME = tmp;
    delete process.env.EXTENSION_DEV_NO_TELEMETRY;
    delete process.env.DO_NOT_TRACK;
    resetSessionIdentityForTests();
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
    resetSessionIdentityForTests();
  });

  it("mints a random install id and persists it beside the credentials", () => {
    const id = resolveInstallId();
    expect(id).toMatch(HEX_128);
    const file = installIdentityPath();
    expect(file.startsWith(tmp)).toBe(true);
    const stored = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(stored.version).toBe(1);
    expect(stored.installId).toBe(id);
    expect(typeof stored.rotatedAt).toBe("number");
  });

  it("keeps the same install id across processes inside the window", () => {
    const first = resolveInstallId();
    resetSessionIdentityForTests();
    expect(resolveInstallId()).toBe(first);
  });

  it("rotates the install id once the window has passed", () => {
    const start = Date.UTC(2026, 6, 1);
    const first = resolveInstallId(start);
    expect(resolveInstallId(start + ROTATE_AFTER_MS - 1)).toBe(first);
    const rotated = resolveInstallId(start + ROTATE_AFTER_MS);
    expect(rotated).toMatch(HEX_128);
    expect(rotated).not.toBe(first);
  });

  it("does not encode the machine or the person", () => {
    const id = resolveInstallId();
    const leaks = [
      os.hostname(),
      os.userInfo().username,
      os.homedir(),
      process.platform,
    ];
    for (const leak of leaks) {
      expect(id).not.toContain(String(leak).toLowerCase());
    }
    resetSessionIdentityForTests();
    fs.rmSync(installIdentityPath(), { force: true });
    expect(resolveInstallId()).not.toBe(id);
  });

  it("gives every process a different session id and holds it for the process", () => {
    const first = sessionId();
    expect(first).toMatch(HEX_128);
    expect(sessionId()).toBe(first);
    resetSessionIdentityForTests();
    expect(sessionId()).not.toBe(first);
  });

  it("never persists the session id", () => {
    const session = sessionId();
    resolveInstallId();
    const stored = fs.readFileSync(installIdentityPath(), "utf8");
    expect(stored).not.toContain(session);
  });

  it("builds the three headers and nothing else", () => {
    const headers = identityHeaders("extension_publish");
    expect(Object.keys(headers).sort()).toEqual(
      [INSTALL_HEADER, SESSION_HEADER, TOOL_HEADER].sort(),
    );
    expect(headers[INSTALL_HEADER]).toMatch(HEX_128);
    expect(headers[SESSION_HEADER]).toMatch(HEX_128);
    expect(headers[TOOL_HEADER]).toBe("extension_publish");
  });

  it("refuses a tool name that is not a tool name", () => {
    expect(identityHeaders("")).toEqual({});
    expect(identityHeaders("extension publish!")).toEqual({});
    expect(identityHeaders("a".repeat(65))).toEqual({});
  });

  it("sends nothing when the operator opted out", () => {
    process.env.EXTENSION_DEV_NO_TELEMETRY = "1";
    expect(telemetryDisabled()).toBe(true);
    expect(identityHeaders("extension_publish")).toEqual({});
    expect(resolveInstallId()).toBe("");
    expect(sessionId()).toBe("");
    expect(fs.existsSync(installIdentityPath())).toBe(false);

    delete process.env.EXTENSION_DEV_NO_TELEMETRY;
    process.env.DO_NOT_TRACK = "1";
    expect(identityHeaders("extension_publish")).toEqual({});
  });

  it("treats an explicit off value as opted in", () => {
    process.env.EXTENSION_DEV_NO_TELEMETRY = "0";
    expect(telemetryDisabled()).toBe(false);
    process.env.EXTENSION_DEV_NO_TELEMETRY = "false";
    expect(telemetryDisabled()).toBe(false);
  });

  it("falls back to a memory only id when the config dir cannot be written", () => {
    const blocked = path.join(tmp, "blocked");
    fs.writeFileSync(blocked, "not a directory");
    process.env.XDG_CONFIG_HOME = blocked;
    const id = resolveInstallId();
    expect(id).toMatch(HEX_128);
    expect(resolveInstallId()).toBe(id);
  });

  it("returns no headers rather than throwing when the home directory is gone", () => {
    delete process.env.XDG_CONFIG_HOME;
    const homedir = os.homedir;
    (os as { homedir: () => string }).homedir = () => {
      throw new Error("no home on this host");
    };
    try {
      expect(() => identityHeaders("extension_publish")).not.toThrow();
      expect(identityHeaders("extension_publish")).toEqual({});
    } finally {
      (os as { homedir: () => string }).homedir = homedir;
    }
  });

  it("replaces a corrupted identity file rather than throwing", () => {
    const file = installIdentityPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "{ not json");
    expect(resolveInstallId()).toMatch(HEX_128);

    fs.writeFileSync(
      file,
      JSON.stringify({ version: 1, installId: "nope", rotatedAt: Date.now() }),
    );
    expect(resolveInstallId()).toMatch(HEX_128);
  });
});
