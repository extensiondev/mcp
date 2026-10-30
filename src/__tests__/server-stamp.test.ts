import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { envelope } from "../lib/envelope";
import { createServerStamp, rebuiltWarning } from "../lib/server-stamp";

import { version } from "../../package.json";

function entryFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "extdev-server-stamp-"));
  const file = path.join(dir, "module.js");
  fs.writeFileSync(file, "export const v = 1;\n");
  fs.utimesSync(file, new Date("2026-10-20T10:00:00Z"), new Date("2026-10-20T10:00:00Z"));

  return file;
}

describe("every platform answer says which server answered", () => {
  it("stamps the package version and the build time of the file the process loaded", () => {
    const file = entryFile();
    const stamp = createServerStamp(file);

    expect(stamp.entry).toBe(file);
    expect(stamp.stamp()).toEqual({ version, builtAt: "2026-10-20T10:00:00.000Z" });
    expect(stamp.rebuiltSince()).toBeNull();

    const out = JSON.parse(stamp.apply(envelope({ ok: true, command: "extension_submit", status: "submitted", value: { action: "submit" }, hint: "Made: no new links." })));

    expect(out.value).toEqual({ action: "submit", server: { version, builtAt: "2026-10-20T10:00:00.000Z" } });
    expect(out.hint).toBe("Made: no new links.");
    expect(out.warnings).toEqual([]);
  });

  it("warns to reconnect once when the file on disk is newer than the one running", () => {
    const file = entryFile();
    const stamp = createServerStamp(file);

    fs.utimesSync(file, new Date("2026-10-20T11:30:00Z"), new Date("2026-10-20T11:30:00Z"));

    expect(stamp.rebuiltSince()).toBe("2026-10-20T11:30:00.000Z");

    const out = JSON.parse(stamp.apply(envelope({ ok: false, command: "extension_publish", status: "publish-refused", error: { code: "E_PLATFORM", message: "no" }, warnings: ["kept"] })));

    expect(out.warnings).toEqual(["kept", rebuiltWarning("2026-10-20T11:30:00.000Z")]);
    expect(out.value.server.builtAt).toBe("2026-10-20T10:00:00.000Z");
  });

  it("names the build of a server compiled past the last release", () => {
    const previous = process.env.EXTENSION_MCP_BUILD_ID;
    process.env.EXTENSION_MCP_BUILD_ID = "48f1eba";

    try {
      expect(createServerStamp(entryFile()).stamp().version).toBe(`${version}+48f1eba`);
    } finally {
      if (previous === undefined) delete process.env.EXTENSION_MCP_BUILD_ID;
      else process.env.EXTENSION_MCP_BUILD_ID = previous;
    }
  });

  it("leaves a non-envelope answer and an unreadable entry alone", () => {
    const stamp = createServerStamp("/nowhere/module.js");

    expect(stamp.stamp()).toEqual({ version, builtAt: null });
    expect(stamp.rebuiltSince()).toBeNull();
    expect(stamp.apply("plain text")).toBe("plain text");
  });
});
