import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { sanitizeMcpProperties } from "../lib/analytics-scrub";
import { creationFunnelPayload } from "../lib/funnel-telemetry";
import { resetSessionIdentityForTests } from "../lib/session-identity";

describe("the mcp lane's scrub", () => {
  it("closes a repository reference welded into a compound string", () => {
    expect(
      sanitizeMcpProperties({ seed_ref: "acme-inc/secret-extension@abc123" }),
    ).toEqual({ seed_ref: "[owner]/[repo]@abc123" });
  });

  it("keeps a catalogue seed ref, which carries no slash and names nobody", () => {
    expect(sanitizeMcpProperties({ seed_ref: "react@abc123" })).toEqual({
      seed_ref: "react@abc123",
    });
  });

  it("drops an unlisted query key from an address and keeps the counted ones", () => {
    expect(
      sanitizeMcpProperties({
        url: "https://www.extension.dev/new?utm_source=mcp&token=sh_secret&ref=abc",
      }),
    ).toEqual({
      url: "https://www.extension.dev/new?utm_source=mcp&ref=abc",
    });
  });

  it("leaves every non-string scalar exactly as it arrived", () => {
    expect(
      sanitizeMcpProperties({ draft_id: null, count: 3, ok: true }),
    ).toEqual({ draft_id: null, count: 3, ok: true });
  });

  it("runs the query scrub before the mask, which is the order that matters", () => {
    expect(
      sanitizeMcpProperties({
        referrer: "https://www.extension.dev/a/b?token=sh_secret",
      }),
    ).toEqual({ referrer: "https://www.extension.dev/a/b" });
  });
});

const saved: Record<string, string | undefined> = {};
const ENV_KEYS = [
  "EXTENSION_DEV_API_URL",
  "EXTENSION_DEV_NO_TELEMETRY",
  "DO_NOT_TRACK",
  "EXTENSION_DEV_POSTHOG_KEY",
  "EXTENSION_DEV_POSTHOG_KEY_NONPRODUCTION",
  "EXTENSION_DEV_POSTHOG_HOST",
];

describe("the emitter applies it", () => {
  beforeEach(() => {
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
    resetSessionIdentityForTests();
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    resetSessionIdentityForTests();
  });

  it("scrubs a caller-supplied property on the way into the payload", () => {
    const payload = creationFunnelPayload("draft_seeded", {
      seed_ref: "acme-inc/secret-extension@abc123",
      seed_slug: "secret-extension",
      seed_source: "fork",
    });

    expect(payload).not.toBeNull();
    expect(payload!.properties.seed_ref).toBe("[owner]/[repo]@abc123");
  });

  it("does not let the scrub touch the keys the emitter itself sets", () => {
    const payload = creationFunnelPayload("draft_seeded", {
      source: "spoofed",
      entry: "spoofed",
    });

    expect(payload!.properties.source).toBe("@extension.dev/mcp");
    expect(payload!.properties.entry).toBe("mcp");
  });
});
