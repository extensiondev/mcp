import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { mcpOrigins, withCallApi } from "../lib/origins";
import { handler as createProject } from "../tools/project-create";
import { handler as createWorkspace } from "../tools/workspace-create";

const LOCAL = "http://localhost:3100";
const PROD = "https://www.extension.dev";
const OPEN_LANE_MESSAGE =
  "Headless project creation is not open on this host yet. Create the project in the console instead, then run the device login against it.";
const HELD_MESSAGE = "extension.dev is not open to the public yet. Project creation will be available when the platform opens.";

const ENV_KEYS = [
  "EXTENSION_DEV_API_URL",
  "EXTENSION_DEV_CONSOLE_URL",
  "EXTENSION_DEV_USERLAND_URL",
  "EXTENSION_DEV_REGISTRY_URL",
  "XDG_CONFIG_HOME",
];
const saved: Record<string, string | undefined> = {};

function closedLaneFetch(message: string, code = "CLI_PROJECT_CREATE_DISABLED") {
  return vi.fn(async (url: unknown) => {
    const href = String(url);

    if (href.endsWith("/api/cli/login/config")) {
      return new Response(
        JSON.stringify({
          deviceCodeUrl: "/api/cli/device/code",
          deviceTokenUrl: "/api/cli/device/token",
          verificationUri: `${href.split("/api/")[0]}/device`,
        }),
      );
    }

    if (href.endsWith("/api/cli/device/code")) {
      return new Response(JSON.stringify({ error: "access_denied", message, code }), { status: 403 });
    }

    throw new Error(`Unexpected fetch: ${href}`);
  });
}

async function laneClosed(api: string | undefined, message = OPEN_LANE_MESSAGE) {
  vi.stubGlobal("fetch", closedLaneFetch(message));

  return JSON.parse(
    await createProject({
      project: "cezaraugusto/pii-shield",
      repo: "cezaraugusto/pii-shield",
      ...(api ? { api } : {}),
    }),
  );
}

beforeEach(() => {
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  for (const key of ENV_KEYS) delete process.env[key];
});

afterEach(() => {
  vi.unstubAllGlobals();

  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("a call's api picks the console in a lane-closed answer", () => {
  it("names production's console when the env points local and the call names production", async () => {
    process.env.EXTENSION_DEV_API_URL = LOCAL;
    process.env.EXTENSION_DEV_CONSOLE_URL = "http://console.extension.localhost";

    const out = await laneClosed(PROD);

    expect(out.status).toBe("lane-closed");
    expect(out.hint).toContain("https://console.extension.dev");
    expect(out.hint).not.toContain("extension.localhost");
    expect(out.value.server).toBe(PROD);
    expect(out.value.consoleUrl).toBe("https://console.extension.dev");
  });

  it("names the local console when the env points at production and the call names a local server", async () => {
    process.env.EXTENSION_DEV_API_URL = PROD;

    const out = await laneClosed(LOCAL);

    expect(out.hint).toContain("http://console.extension.localhost");
    expect(out.hint).not.toContain("https://console.extension.dev");
  });

  it("falls back to the env server when the call names none", async () => {
    process.env.EXTENSION_DEV_API_URL = LOCAL;

    const out = await laneClosed(undefined);

    expect(out.hint).toContain("http://console.extension.localhost");
    expect(out.value.server).toBe(LOCAL);
  });

  it("states the public hold plainly and suggests no console route the hold blocks", async () => {
    process.env.EXTENSION_DEV_API_URL = LOCAL;

    const out = await laneClosed(PROD, HELD_MESSAGE);

    expect(out.error.message).toBe(HELD_MESSAGE);
    expect(out.hint).toContain(`public hold on ${PROD}`);
    expect(out.hint).toContain("allowlist");
    expect(out.hint).toContain("names no allowlisted workspace");
    expect(out.hint).not.toMatch(/https?:\/\/console\./);
    expect(out.hint).not.toContain("New project");
    expect(out.value.publicHold).toBe(true);
    expect(out.value.allowlistNamed).toBe(false);
    expect(out.value.consoleUrl).toBeUndefined();
  });

  it("gives workspace creation the same rule", async () => {
    process.env.EXTENSION_DEV_API_URL = LOCAL;
    vi.stubGlobal(
      "fetch",
      closedLaneFetch(
        "Headless workspace creation is not open on this host yet. Create the workspace in the console instead.",
        "CLI_WORKSPACE_CREATE_DISABLED",
      ),
    );

    const out = JSON.parse(await createWorkspace({ workspace: "acme", api: PROD }));

    expect(out.status).toBe("lane-closed");
    expect(out.hint).toContain("https://console.extension.dev");
    expect(out.hint).not.toContain("extension.localhost");
  });
});

describe("one resolver derives every host from the call's server", () => {
  it("ignores local surface overrides when the call names production", () => {
    process.env.EXTENSION_DEV_API_URL = LOCAL;
    process.env.EXTENSION_DEV_CONSOLE_URL = "http://console.extension.localhost";
    process.env.EXTENSION_DEV_USERLAND_URL = "http://userland.extension.localhost";

    const origins = mcpOrigins(PROD);

    expect(origins.console).toBe("https://console.extension.dev");
    expect(origins.userland).toBe("https://extension.dev");
    expect(origins.registry).toBe("https://registry.extension.land");
  });

  it("keeps the surface overrides for the server the env names", () => {
    process.env.EXTENSION_DEV_API_URL = LOCAL;
    process.env.EXTENSION_DEV_CONSOLE_URL = "http://console.custom.localhost";

    expect(mcpOrigins().console).toBe("http://console.custom.localhost");
    expect(mcpOrigins(LOCAL).console).toBe("http://console.custom.localhost");
  });

  it("reads the call's api from the dispatch scope when a helper passes none", () => {
    process.env.EXTENSION_DEV_API_URL = LOCAL;

    expect(withCallApi(PROD, () => mcpOrigins().console)).toBe("https://console.extension.dev");
    expect(withCallApi(undefined, () => mcpOrigins().console)).toBe("http://console.extension.localhost");
  });
});
