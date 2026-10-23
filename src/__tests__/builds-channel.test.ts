import { describe, expect, it } from "vitest";

import { actionFingerprint } from "../lib/approval-gate";
import { handler as builds, schema } from "../tools/builds";
import { CONFIGURE_CHANNEL_ACTION } from "../tools/builds-channel";
import { API, PROJECT_ROUTE, useProjectRoutes } from "./fixtures/project-routes";

const BETA = `${PROJECT_ROUTE}/channels/beta`;
const APPROVALS = "/api/cli/approvals";

function approvalRequired(scope: Record<string, string>) {
  return {
    status: 403,
    body: {
      code: "APPROVAL_REQUIRED",
      message: "Opening a channel to anyone with the link needs a workspace owner's approval.",
      approvalRequest: { action: CONFIGURE_CHANNEL_ACTION, scope, fingerprint: actionFingerprint(CONFIGURE_CHANNEL_ACTION, scope) },
      changes: ["beta.audience: private -> public"],
    },
  };
}

describe("extension_builds configure-channel changes a channel as a plain call and keeps a public audience on the approve page", () => {
  const platform = useProjectRoutes("extdev-builds-channel-");

  it("names configure-channel and delete-channel beside create-channel, with the fields each takes", () => {
    const properties = schema.inputSchema.properties as Record<string, any>;

    expect(schema.inputSchema.properties.action.enum).toContain("configure-channel");
    expect(schema.inputSchema.properties.action.enum).toContain("delete-channel");
    expect(properties.channel.description).toContain("configure-channel or delete-channel");
    expect(properties.description.description).toContain("configure-channel");
    expect(properties.color.description).toContain("configure-channel");
    expect(properties.audience.description).toMatch(/Private is a plain call; public keeps a workspace owner's approval/);
    expect(properties.approvalId.description).toContain("configure-channel");
  });

  it("sends a description, a color and a private audience as one PATCH under the owner's token, minting nothing", async () => {
    if (process.platform === "win32") return;

    platform.login();
    platform.routes[`PATCH ${BETA}`] = (call) => ({
      body: { id: "beta", name: "beta", audience: "private", description: call.body.description, color: call.body.color, changes: ['beta.description: "" -> "Nightly testers"', 'beta.color: "#22c55e" -> "#0ea5e9"', "beta.audience: public -> private"] },
    });

    const out = JSON.parse(
      await builds({ action: "configure-channel", channel: "Beta", audience: "private", description: " Nightly testers ", color: "#0ea5e9", api: API } as never),
    );
    const patches = platform.sent("PATCH", BETA);

    expect(patches).toHaveLength(1);
    expect(patches[0].body).toEqual({ audience: "private", description: "Nightly testers", color: "#0ea5e9" });
    expect(patches[0].auth).toBe("Bearer claims.sig");
    expect(out.ok).toBe(true);
    expect(out.status).toBe("channel-configured");
    expect(out.value).toMatchObject({
      action: "configure-channel",
      project: "acme/widget",
      channel: { name: "beta", audience: "private", description: "Nightly testers", color: "#0ea5e9" },
      changes: ['beta.description: "" -> "Nightly testers"', 'beta.color: "#22c55e" -> "#0ea5e9"', "beta.audience: public -> private"],
    });

    expect(out.value.channel.changes).toBeUndefined();
    expect(out.value.trackUrl).toMatch(/\/acme\/widget\/releases\?channel=beta$/);
    expect(out.hint).toContain("no approval page was involved");
    expect(out.hint).toContain("workspace members and build links only");
    expect(platform.calls.some((call) => call.path.startsWith(APPROVALS))).toBe(false);
  });

  it("keeps a public audience on the approve page: the platform asks, the approval names the channel and the audience, and nothing is written", async () => {
    if (process.platform === "win32") return;

    platform.login();
    const scope = { channel: "beta", audience: "public" };
    platform.routes[`PATCH ${BETA}`] = () => approvalRequired(scope);
    platform.routes[`POST ${APPROVALS}`] = () => ({
      status: 201,
      body: { approvalId: "apr_open", approvalUrl: `${API}/device/approve/apr_open`, changes: ["beta.audience: private -> public"] },
    });

    const out = JSON.parse(await builds({ action: "configure-channel", channel: "beta", audience: "public", api: API } as never));
    const [post] = platform.sent("POST", APPROVALS);

    expect(post.body).toMatchObject({ action: CONFIGURE_CHANNEL_ACTION, scope, fingerprint: actionFingerprint(CONFIGURE_CHANNEL_ACTION, scope) });
    expect(post.body.description).toBe("Open the beta channel of acme/widget to anyone with the link.");
    expect(out.ok).toBe(false);
    expect(out.status).toBe("approval-required");
    expect(out.value).toMatchObject({ approvalId: "apr_open", approvalUrl: `${API}/device/approve/apr_open`, changes: ["beta.audience: private -> public"] });
    expect(out.error.message).toContain("anyone with the link");
    expect(out.error.message).toContain("approvalId apr_open");
    expect(platform.sent("PATCH", BETA)).toHaveLength(1);
  });

  it("applies a public audience once with an approved approval and says the channel link now opens for anyone", async () => {
    if (process.platform === "win32") return;

    platform.login();
    platform.routes[`GET ${APPROVALS}/apr_open`] = () => ({
      body: {
        status: "approved",
        used: false,
        fingerprint: actionFingerprint(CONFIGURE_CHANNEL_ACTION, { channel: "beta", audience: "public" }),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    });

    platform.routes[`PATCH ${BETA}`] = (call) => ({
      body: { id: "beta", name: "beta", audience: call.body.audience, builds: ["abc1234"], changes: ["beta.audience: private -> public"] },
    });

    const out = JSON.parse(await builds({ action: "configure-channel", channel: "beta", audience: "public", approvalId: "apr_open", api: API } as never));
    const [patch] = platform.sent("PATCH", BETA);

    expect(patch.body).toEqual({ audience: "public", approvalId: "apr_open" });
    expect(out.ok).toBe(true);
    expect(out.status).toBe("channel-configured");
    expect(out.value.channel).toMatchObject({ name: "beta", audience: "public", builds: ["abc1234"] });
    expect(out.hint).toContain("opens for anyone");
    expect(out.hint).not.toContain("no approval page was involved");
  });

  it("is refused OWNER_REQUIRED when the token's minter is not an owner, before any approval is asked", async () => {
    if (process.platform === "win32") return;

    platform.login();
    platform.routes[`PATCH ${BETA}`] = () => ({
      status: 403,
      body: { code: "OWNER_REQUIRED", message: "Changing a channel with a token is a workspace owner action, and this token was minted by an account that is not an owner of this workspace." },
    });

    const out = JSON.parse(await builds({ action: "configure-channel", channel: "beta", description: "x", api: API } as never));

    expect(out.ok).toBe(false);
    expect(out.error.platformCode).toBe("OWNER_REQUIRED");
    expect(platform.calls.some((call) => call.path.startsWith(APPROVALS))).toBe(false);
  });

  it("passes on a public project's refusal and an unknown channel with the platform's own words", async () => {
    if (process.platform === "win32") return;

    platform.login();
    platform.routes[`PATCH ${BETA}`] = () => ({
      status: 400,
      body: { code: "PROJECT_IS_PUBLIC", message: "This project is public, so every channel is public. Make the project private to choose a channel's audience." },
    });

    const isPublic = JSON.parse(await builds({ action: "configure-channel", channel: "beta", audience: "private", api: API } as never));

    expect(isPublic.status).toBe("bad-request");
    expect(isPublic.error.platformCode).toBe("PROJECT_IS_PUBLIC");

    platform.routes[`PATCH ${PROJECT_ROUTE}/channels/nightly`] = () => ({
      status: 404,
      body: { code: "CHANNEL_NOT_FOUND", message: "This project has no channel with that name." },
    });

    const missing = JSON.parse(await builds({ action: "configure-channel", channel: "nightly", color: "#0ea5e9", api: API } as never));

    expect(missing.status).toBe("not-found");
    expect(missing.error.message).toContain("no channel with that name");
    expect(platform.calls.some((call) => call.path.startsWith(APPROVALS))).toBe(false);
  });

  it("refuses a missing channel name, an unknown audience and an empty change before any request", async () => {
    platform.login();

    const noName = JSON.parse(await builds({ action: "configure-channel", audience: "private", api: API } as never));
    const badAudience = JSON.parse(await builds({ action: "configure-channel", channel: "beta", audience: "everyone", api: API } as never));
    const empty = JSON.parse(await builds({ action: "configure-channel", channel: "beta", api: API } as never));

    expect(noName.error.message).toContain("needs channel");
    expect(badAudience.error.message).toMatch(/public or private/);
    expect(empty.error.message).toContain("at least one of audience, description or color");
    expect(platform.calls).toHaveLength(0);
  });

  it("never deletes a channel: delete-channel answers console-only with the Channels settings page and sends nothing", async () => {
    platform.login();

    const out = JSON.parse(await builds({ action: "delete-channel", channel: "beta", api: API } as never));

    expect(out.ok).toBe(false);
    expect(out.status).toBe("console-only");
    expect(out.error.code).toBe("E_CONSOLE_ONLY");
    expect(out.error.name).toBe("ChannelDeleteConsoleOnly");
    expect(out.value).toMatchObject({ action: "delete-channel", channel: "beta", verdict: "console" });
    expect(out.value.trackUrl).toMatch(/\/acme\/widget\/project-settings\/channels$/);
    expect(out.value.sayToPerson).toContain("Channels section of the project settings");
    expect(platform.calls).toHaveLength(0);
  });
});
