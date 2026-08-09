import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DRAFT_SEEDED_EVENT,
  captureCreationFunnelEvent,
  captureTemplateSeed,
  creationFunnelPayload,
  funnelEnvironment,
  posthogKeyForEnvironment,
  seedRef,
  shouldSendCreationFunnelEvent,
} from "../lib/funnel-telemetry";
import { resetSessionIdentityForTests } from "../lib/session-identity";

const TEST_COMMIT = "f7f4e6efb56a7e5ae08d58dbff3972d94af7d021";

const WEB_LANE_PROPERTY_KEYS = [
  "$process_person_profile",
  "draft_id",
  "emitted_from",
  "entry",
  "environment",
  "seed_ref",
  "seed_slug",
  "seed_source",
  "session_id",
  "source",
].sort();

const HEX_128 = /^[0-9a-f]{32}$/;

const saved: Record<string, string | undefined> = {};
const ENV_KEYS = [
  "EXTENSION_DEV_API_URL",
  "EXTENSION_DEV_NO_TELEMETRY",
  "DO_NOT_TRACK",
  "EXTENSION_DEV_POSTHOG_KEY",
  "EXTENSION_DEV_POSTHOG_KEY_NONPRODUCTION",
  "EXTENSION_DEV_POSTHOG_HOST",
  "EXTENSION_TEMPLATES_COMMIT",
];

beforeEach(() => {
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  process.env.EXTENSION_TEMPLATES_COMMIT = TEST_COMMIT;
  resetSessionIdentityForTests();
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  resetSessionIdentityForTests();
});

describe("creation funnel payload", () => {
  it("carries exactly the web lane's property keys and nothing else", () => {
    const payload = creationFunnelPayload(DRAFT_SEEDED_EVENT, {
      seed_source: "template",
      seed_ref: seedRef("react", TEST_COMMIT),
      seed_slug: "react",
    });

    expect(payload).not.toBeNull();
    expect(Object.keys(payload!.properties).sort()).toEqual(
      WEB_LANE_PROPERTY_KEYS,
    );
  });

  it("stamps the mcp entry, the platform key and a session distinct id", () => {
    const payload = creationFunnelPayload(DRAFT_SEEDED_EVENT, {
      seed_source: "template",
      seed_ref: seedRef("react", TEST_COMMIT),
      seed_slug: "react",
    });

    expect(payload!.event).toBe("draft_seeded");
    expect(payload!.api_key).toBe(
      "phc_t8hwHt3uJdjxil8TUA9AIWUFeWyJtTxhfXV58bPiV6T",
    );
    expect(payload!.distinct_id).toBe(payload!.properties.session_id);
    expect(String(payload!.distinct_id)).toMatch(HEX_128);
    expect(payload!.properties).toMatchObject({
      draft_id: null,
      seed_source: "template",
      seed_ref: `react@${TEST_COMMIT}`,
      seed_slug: "react",
      entry: "mcp",
      environment: "production",
      emitted_from: "node",
      source: "@extension.dev/mcp",
      $process_person_profile: false,
    });
  });

  it("never sends the install id, only the process session id", () => {
    const payload = creationFunnelPayload(DRAFT_SEEDED_EVENT, {
      seed_slug: "react",
    });
    const body = JSON.stringify(payload);

    expect(body).not.toContain("install");
    expect(payload!.properties.session_id).toBe(payload!.distinct_id);
  });

  it("refuses the Extension.js CLI project key as its destination", () => {
    expect(posthogKeyForEnvironment("production")).not.toBe(
      "phc_Np5x3Jg3h2V7kTFtNch2uz6QBaWDycQpIidzX5PetaN",
    );
  });
});

describe("creation funnel gates", () => {
  it("sends nothing when telemetry is disabled", async () => {
    process.env.EXTENSION_DEV_NO_TELEMETRY = "1";
    const fetchMock = vi.fn(async () => new Response("{}"));

    expect(shouldSendCreationFunnelEvent()).toBe(false);
    expect(
      await captureTemplateSeed({ slug: "react" }, fetchMock as never),
    ).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends nothing when DO_NOT_TRACK is set", async () => {
    process.env.DO_NOT_TRACK = "1";
    const fetchMock = vi.fn(async () => new Response("{}"));

    expect(shouldSendCreationFunnelEvent()).toBe(false);
    expect(
      await captureTemplateSeed({ slug: "react" }, fetchMock as never),
    ).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends nothing off production when no non-production key exists", async () => {
    process.env.EXTENSION_DEV_API_URL = "http://localhost:3000";
    const fetchMock = vi.fn(async () => new Response("{}"));

    expect(funnelEnvironment()).toBe("development");
    expect(shouldSendCreationFunnelEvent()).toBe(false);
    expect(
      await captureTemplateSeed({ slug: "react" }, fetchMock as never),
    ).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends off production once a non-production key is configured", async () => {
    process.env.EXTENSION_DEV_API_URL = "http://localhost:3000";
    process.env.EXTENSION_DEV_POSTHOG_KEY_NONPRODUCTION = "phc_local";
    const fetchMock = vi.fn(async () => new Response("{}"));

    const payload = await captureTemplateSeed(
      { slug: "react" },
      fetchMock as never,
    );

    expect(payload!.api_key).toBe("phc_local");
    expect(payload!.properties.environment).toBe("development");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("refuses an empty slug rather than seeding a nameless start", async () => {
    const fetchMock = vi.fn(async () => new Response("{}"));

    expect(
      await captureTemplateSeed({ slug: "  " }, fetchMock as never),
    ).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never throws or rejects when the capture request fails", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("offline");
    });

    await expect(
      captureCreationFunnelEvent(
        DRAFT_SEEDED_EVENT,
        { seed_slug: "react" },
        fetchMock as never,
      ),
    ).resolves.not.toBeNull();
  });
});

describe("capture request", () => {
  it("posts the payload to the PostHog capture endpoint", async () => {
    const fetchMock = vi.fn(async () => new Response("{}"));

    await captureTemplateSeed({ slug: "react" }, fetchMock as never);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      { method: string; body: string },
    ];
    expect(url).toBe("https://us.i.posthog.com/capture/");
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body) as {
      event: string;
      properties: Record<string, unknown>;
    };
    expect(body.event).toBe("draft_seeded");
    expect(body.properties.seed_ref).toBe(`react@${TEST_COMMIT}`);
    expect(body.properties.entry).toBe("mcp");
  });
});
