import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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
