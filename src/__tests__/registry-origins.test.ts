import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { consoleBase, consoleProjectUrl, registryBase } from "../lib/registry";

const ENV_KEYS = [
  "EXTENSION_DEV_API_URL",
  "EXTENSION_DEV_CONSOLE_URL",
  "EXTENSION_DEV_INSPECT_URL",
  "EXTENSION_DEV_REGISTRY_URL",
  "EXTENSION_MEDIA_ORIGIN",
] as const;

describe("console/registry origin resolution", () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = {};
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  const ref = { workspace: "acme", project: "widget" };

  it("defaults every link to prod when no env is set", () => {
    expect(consoleBase()).toBe("https://console.extension.dev");
    expect(consoleProjectUrl(ref, "builds")).toBe(
      "https://console.extension.dev/acme/widget/builds",
    );
    expect(registryBase()).toBe("https://registry.extension.land");
  });

  it("derives the local console host when the platform base is localhost", () => {
    process.env.EXTENSION_DEV_API_URL = "http://localhost:3100";
    expect(consoleBase()).toBe("http://console.extension.localhost");
    expect(consoleProjectUrl(ref, "settings/access-tokens")).toBe(
      "http://console.extension.localhost/acme/widget/settings/access-tokens",
    );
  });

  it("honors an explicit console override over derivation", () => {
    process.env.EXTENSION_DEV_API_URL = "http://localhost:3100";
    process.env.EXTENSION_DEV_CONSOLE_URL = "http://console.extension.localhost:3102";
    expect(consoleBase()).toBe("http://console.extension.localhost:3102");
  });

  it("lets a per-tool api hint pick the environment for its own link", () => {
    expect(consoleProjectUrl(ref, "stores", "http://localhost:3100")).toBe(
      "http://console.extension.localhost/acme/widget/stores",
    );
  });

  it("keeps registry on prod even in dev (no local proxy) unless overridden", () => {
    process.env.EXTENSION_DEV_API_URL = "http://localhost:3100";
    expect(registryBase()).toBe("https://registry.extension.land");
    process.env.EXTENSION_DEV_REGISTRY_URL = "http://localhost:9000";
    expect(registryBase()).toBe("http://localhost:9000");
  });
});
