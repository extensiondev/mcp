import { describe, it, expect, afterEach, vi } from "vitest";

// The shell CLI (`extension-mcp login`) and the MCP tool (extension_login) must
// pick the SAME auth flow. They drifted once: runCli called the GitHub-direct
// helpers unconditionally while only the tool branched on config.provider, so a
// server advertising provider:"extensiondev" still forced the legacy GitHub flow
// from a shell. Fixed in d3be1ff (v4.7.0); this pins it.

let provider = "extensiondev";
const flowsUsed: string[] = [];

vi.mock("../lib/login-flow", () => ({
  resolveApiBase: (v?: string) => v ?? "https://api.test",
  fetchLoginConfig: async () => ({
    provider,
    clientId: "gh-client",
    scope: "repo",
    deviceCodeUrl: "/device/code",
    deviceTokenUrl: "/device/token",
  }),
  exchangeAndPersist: async () => {
    flowsUsed.push("github:exchange");
    return { workspaceSlug: "ws", projectSlug: "proj" };
  },
}));

vi.mock("../lib/device-flow", () => ({
  requestDeviceCode: async () => {
    flowsUsed.push("extensiondev:request");
    return {
      verificationUri: "https://extension.dev/device",
      userCode: "ABCD-1234",
      deviceCode: "dev-code",
      interval: 0,
      expiresIn: 1,
    };
  },
  pollDeviceToken: async () => {
    flowsUsed.push("extensiondev:poll");
    return { ok: true, creds: { workspaceSlug: "ws", projectSlug: "proj" } };
  },
}));

vi.mock("../lib/github-device", () => ({
  startDeviceCode: async () => {
    flowsUsed.push("github:start");
    return {
      verificationUri: "https://github.com/login/device",
      userCode: "WXYZ-9999",
      deviceCode: "gh-code",
      interval: 0,
      expiresIn: 1,
    };
  },
  pollForToken: async () => {
    flowsUsed.push("github:poll");
    return { ok: true, githubToken: "gho_test" };
  },
}));

const { runCli } = await import("../index");

const stderr = vi
  .spyOn(process.stderr, "write")
  .mockImplementation(() => true);

afterEach(() => {
  flowsUsed.length = 0;
  stderr.mockClear();
});

describe("extension-mcp login provider branch", () => {
  it("uses the extension.dev device flow when the server advertises it", async () => {
    provider = "extensiondev";

    const code = await runCli("login", ["--project", "ws/proj"]);

    expect(code).toBe(0);
    expect(flowsUsed).toEqual([
      "extensiondev:request",
      "extensiondev:poll",
    ]);
    // The regression was silently falling back to GitHub here.
    expect(flowsUsed.some((f) => f.startsWith("github:"))).toBe(false);
  });

  it("falls back to the GitHub-direct flow for any other provider", async () => {
    provider = "github";

    const code = await runCli("login", ["--project", "ws/proj"]);

    expect(code).toBe(0);
    expect(flowsUsed).toEqual([
      "github:start",
      "github:poll",
      "github:exchange",
    ]);
  });

  it("rejects a malformed project slug before touching any auth flow", async () => {
    provider = "extensiondev";

    const code = await runCli("login", ["--project", "not-a-slug"]);

    expect(code).toBe(1);
    expect(flowsUsed).toEqual([]);
  });
});
