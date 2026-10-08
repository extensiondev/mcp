
import { describe, it, expect } from "vitest";

import { schema as authSchema } from "../tools/auth";
import { schema as createSchema, laneClosedHint } from "../tools/project-create";
import { createRateLimitNote } from "../lib/project-batch";
import { HOLD_STILL_WORKS_SENTENCE } from "../lib/platform-hold";
import { pollDeviceGrant } from "../lib/device-flow";

describe("the auth and create tools describe what the platform does", () => {
  it("auth status names the statuses it emits, and create names who approves", () => {
    expect(authSchema.description).toMatch(/value\.server\.verdict as confirmed, refused or unavailable/);
    expect(authSchema.description).not.toMatch(/or unverified when the server cannot be reached/);
    expect(createSchema.description).toMatch(/a signed-in member of the workspace approves/);
    expect(createSchema.description).not.toMatch(/signed-in workspace owner approves/);
  });

  it("the lane hint defers to the platform's message and names the hold's console state", () => {
    const hint = laneClosedHint();
    expect(hint).toMatch(/its own message above says which case this is/);
    expect(hint).not.toMatch(/this workspace is not on it, so the console is the route/);
    expect(hint).toMatch(/console answers its gate page/);
  });

  it("the rate note says what the platform counts", () => {
    const note = createRateLimitNote();
    expect(note).toMatch(/counted before the existence check/);
    expect(note).not.toMatch(/creates at most .* projects per hour/);
    expect(note).not.toMatch(/lives 15 minutes/);
  });

  it("the hold sentence lists approvals and workspace create among what is closed, and claims no 'free forever'", () => {
    const text = HOLD_STILL_WORKS_SENTENCE;
    expect(text).toMatch(/requesting an approval/);
    expect(text).toMatch(/project or workspace/);
    expect(text).not.toMatch(/free forever/);
  });

  it("an expired_token answer carries the platform's own sentence", async () => {
    const result = await pollDeviceGrant({
      apiBase: "https://api.test",
      path: "/api/cli/device/token",
      project: "acme/widget",
      deviceCode: "d",
      interval: 1,
      budgetMs: 500,
      fetchImpl: (async () =>
        new Response(JSON.stringify({ error: "expired_token", error_description: "The device code has expired or is unknown. Start login again." }), { status: 400, headers: { "content-type": "application/json" } })) as unknown as typeof fetch,
    });
    expect(result.ok).toBe(false);
    expect((result as { reason: string; message?: string }).reason).toBe("expired");
    expect((result as { message?: string }).message).toMatch(/expired or is unknown/);
  });
});
