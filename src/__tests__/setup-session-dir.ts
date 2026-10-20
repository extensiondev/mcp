import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { beforeEach } from "vitest";

import { outcomeClock } from "../lib/act-outcome";

process.env.EXTENSION_MCP_SESSION_DIR = fs.mkdtempSync(
  path.join(os.tmpdir(), "mcp-test-session-markers-"),
);

process.env.EXTENSION_DEV_NO_TELEMETRY = "1";

let slept = 0;
outcomeClock.now = () => Date.now() + slept;

outcomeClock.sleep = async (ms: number) => {
  slept += ms;
};

beforeEach(() => {
  slept = 0;
});

if (process.platform === "win32") {
  beforeEach(() => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-test-appdata-"));
    process.env.APPDATA = dir;
    process.env.LOCALAPPDATA = dir;
  });
}
