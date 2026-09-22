import { describe, expect, it } from "vitest";

import {
  parseSafariDriverHelp,
  safariAutomationHint,
  safariDriverCandidates,
} from "../lib/safari-automation";

const SAFARI_26_HELP = `Usage: safaridriver [options]
\t-h, --help                Prints out this usage information.
\t--version                 Prints out version information and exits.
\t-p, --port                Port number the driver should use.
\t-b, --bidi                Port number the driver should use to listen for incoming
\t                          WebSocket connections.
\t--enable                  Applies configuration changes so that subsequent WebDriver
\t                          sessions will run without further authentication.
\t--diagnose                Causes safaridriver to log diagnostic information.`;

const SAFARI_27_HELP = `${SAFARI_26_HELP}
\t--mcp                     Starts a Model Context Protocol server over standard input and output.`;

describe("parseSafariDriverHelp", () => {
  it("reads the Safari 26 driver as BiDi-capable and MCP-less", () => {
    expect(parseSafariDriverHelp(SAFARI_26_HELP)).toEqual({
      mcp: false,
      bidi: true,
    });
  });

  it("reads the Safari 27 driver as MCP-capable", () => {
    expect(parseSafariDriverHelp(SAFARI_27_HELP)).toEqual({
      mcp: true,
      bidi: true,
    });
  });

  it("does not mistake prose for a flag", () => {
    expect(
      parseSafariDriverHelp("safaridriver speaks mcp when asked to").mcp,
    ).toBe(false);
  });
});

describe("safariDriverCandidates", () => {
  it("prefers the driver bundled beside the Safari binary, then the system one", () => {
    expect(
      safariDriverCandidates(
        "/Applications/Safari Technology Preview.app/Contents/MacOS/Safari Technology Preview",
      ),
    ).toEqual([
      "/Applications/Safari Technology Preview.app/Contents/MacOS/safaridriver",
      "/usr/bin/safaridriver",
    ]);
  });

  it("falls back to the system driver alone without a Safari binary", () => {
    expect(safariDriverCandidates(null)).toEqual(["/usr/bin/safaridriver"]);
  });
});

describe("safariAutomationHint", () => {
  it("names the setting and the add command when MCP is available", () => {
    const hint = safariAutomationHint({
      safaridriver: "/usr/bin/safaridriver",
      mcp: true,
      bidi: true,
    });
    expect(hint).toContain("Allow remote automation and external agents");
    expect(hint).toContain("claude mcp add safari-mcp");
    expect(hint).toContain("no extension-aware tool");
  });

  it("names the version floor when the driver predates MCP", () => {
    const hint = safariAutomationHint({
      safaridriver: "/usr/bin/safaridriver",
      mcp: false,
      bidi: true,
    });
    expect(hint).toContain("Safari 27");
    expect(hint).not.toContain("claude mcp add");
  });
});
