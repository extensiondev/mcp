import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.EXTENSION_MCP_SESSION_DIR = fs.mkdtempSync(
  path.join(os.tmpdir(), "mcp-test-session-markers-"),
);
