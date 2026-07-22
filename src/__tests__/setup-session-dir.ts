import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Session markers default to a machine-global dir under os.tmpdir() so they
// survive MCP restarts. Tests must never write there: a stale marker from a
// test run would surface in a real extension_stop all:true sweep. Every test
// file gets its own throwaway marker dir instead.
process.env.EXTENSION_MCP_SESSION_DIR = fs.mkdtempSync(
  path.join(os.tmpdir(), "mcp-test-session-markers-"),
);
