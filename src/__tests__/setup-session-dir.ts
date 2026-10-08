import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { beforeEach } from "vitest";

process.env.EXTENSION_MCP_SESSION_DIR = fs.mkdtempSync(
  path.join(os.tmpdir(), "mcp-test-session-markers-"),
);

process.env.EXTENSION_DEV_NO_TELEMETRY = "1";

if (process.platform === "win32") {
  beforeEach(() => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-test-appdata-"));
    process.env.APPDATA = dir;
    process.env.LOCALAPPDATA = dir;
  });
}
