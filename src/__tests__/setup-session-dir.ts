import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { beforeEach } from "vitest";

process.env.EXTENSION_MCP_SESSION_DIR = fs.mkdtempSync(
  path.join(os.tmpdir(), "mcp-test-session-markers-"),
);

/* @invariant No test run may ever emit a creation funnel row.
 *
 * The suite drives the real tool handlers, and extension_create seeds the
 * funnel against the production project key by default. Without this, a green
 * test run posts draft_seeded rows and our own CI becomes the biggest template
 * in the funnel. The tests that exercise the emitter clear this themselves and
 * restore it afterwards.
 */
process.env.EXTENSION_DEV_NO_TELEMETRY = "1";

/* @invariant On Windows every test gets its own login store.
 *
 * The store lives under %APPDATA% there and ignores XDG_CONFIG_HOME, which is
 * how every test isolates it, so on the first Windows run the whole suite
 * read and wrote the runner's one real auth.json and the cells broke each
 * other: leftover logins counted, a torn file read as unreadable. A fresh
 * APPDATA per test is what XDG_CONFIG_HOME already gives every other host.
 */
if (process.platform === "win32") {
  beforeEach(() => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-test-appdata-"));
    process.env.APPDATA = dir;
    process.env.LOCALAPPDATA = dir;
  });
}
