import { describe, expect, it } from "vitest";

import { handler as builds, schema } from "../tools/builds";
import { API, CHANNELS_ROUTE, SUITE, login, world } from "./builds-acts-harness";

describe(SUITE, () => {
  it("create-channel adds the channel and answers with the project's channels", async () => {
    if (process.platform === "win32") return;

    login();
    world.routes[`POST ${CHANNELS_ROUTE}`] = () => ({
      body: { id: "beta", name: "beta", description: "", color: "#22c55e", createdAt: "2026-10-11T18:00:00.000Z" },
    });

    world.routes[`GET ${CHANNELS_ROUTE}`] = () => ({
      body: [
        { id: "beta", name: "beta" },
        { id: "stable", name: "stable" },
      ],
    });

    const out = JSON.parse(await builds({ action: "create-channel", channel: "beta", color: "#22c55e", api: API }));
    const post = world.calls.find((call) => call.method === "POST");

    expect(post?.body).toEqual({ name: "beta", color: "#22c55e" });
    expect(out.ok).toBe(true);
    expect(out.status).toBe("channel-created");
    expect(out.value.trackUrl).toContain("/acme/widget/");
    expect(out.value.channel).toMatchObject({ id: "beta", name: "beta" });
    expect(out.value.channels.map((c: any) => c.name)).toEqual(["beta", "stable"]);
    expect(out.hint).toContain("extension_release_promote");
  });

  it("create-channel reads an existing channel as already there, not as a failure", async () => {
    if (process.platform === "win32") return;

    login();
    world.routes[`POST ${CHANNELS_ROUTE}`] = () => ({ body: { message: "Channel already exists" }, status: 409 });
    world.routes[`GET ${CHANNELS_ROUTE}`] = () => ({ body: [{ id: "beta", name: "beta" }] });

    const out = JSON.parse(await builds({ action: "create-channel", channel: "beta", api: API }));

    expect(out.ok).toBe(true);
    expect(out.status).toBe("exists");
    expect(out.value.created).toBe(false);
  });

  it("create-channel without a name is refused before any request", async () => {
    login();

    const out = JSON.parse(await builds({ action: "create-channel", api: API }));

    expect(out.ok).toBe(false);
    expect(out.error.code).toBe("E_BAD_REQUEST");
    expect(world.calls).toHaveLength(0);
  });

  it("create-channel passes a private audience through as a plain call", async () => {
    if (process.platform === "win32") return;

    login();
    world.routes[`POST ${CHANNELS_ROUTE}`] = () => ({
      body: { id: "beta", name: "beta", description: "", color: "#22c55e", createdAt: "2026-10-18T18:00:00.000Z", audience: "private" },
    });

    world.routes[`GET ${CHANNELS_ROUTE}`] = () => ({ body: [{ id: "beta", name: "beta", audience: "private" }] });

    const out = JSON.parse(await builds({ action: "create-channel", channel: "beta", audience: "private", api: API } as never));
    const post = world.calls.find((call) => call.method === "POST");

    expect(post?.body).toEqual({ name: "beta", audience: "private" });
    expect(out.status).toBe("channel-created");
    expect(out.value.channel.audience).toBe("private");
    expect(out.warnings).toEqual([]);
    expect(world.calls.some((call) => call.url.includes("/api/cli/approvals"))).toBe(false);
  });

  it("create-channel keeps a public audience on a person: it answers approval-required naming the Releases page and sends nothing", async () => {
    if (process.platform === "win32") return;

    login();
    world.routes[`POST ${CHANNELS_ROUTE}`] = () => ({ body: { id: "beta", name: "beta", audience: "public" } });

    const out = JSON.parse(await builds({ action: "create-channel", channel: "beta", audience: "public", api: API } as never));

    expect(out.ok).toBe(false);
    expect(out.status).toBe("approval-required");
    expect(out.error.name).toBe("ChannelAudienceNeedsAPerson");
    expect(out.value).toMatchObject({ action: "create-channel", channel: "beta", audience: "public" });
    expect(out.value.trackUrl).toMatch(/\/acme\/widget\/releases$/);
    expect(out.hint).toContain("Releases page");
    expect(out.hint).toContain("configure-channel");
    expect(out.error.message).toContain('action:"configure-channel" (channel: "beta", audience: "public")');
    expect(world.calls.filter((call) => call.method === "POST")).toHaveLength(0);
  });

  it("create-channel leaves the audience to the project's visibility when none is asked for", async () => {
    if (process.platform === "win32") return;

    login();
    world.routes[`POST ${CHANNELS_ROUTE}`] = () => ({ body: { id: "beta", name: "beta", audience: "private" } });
    world.routes[`GET ${CHANNELS_ROUTE}`] = () => ({ body: [{ id: "beta", name: "beta", audience: "private" }] });

    const out = JSON.parse(await builds({ action: "create-channel", channel: "beta", api: API }));
    const post = world.calls.find((call) => call.method === "POST");

    expect(post?.body).toEqual({ name: "beta" });
    expect(out.warnings).toEqual([]);
  });

  it("create-channel refuses an audience other than public or private before any request", async () => {
    login();

    const out = JSON.parse(await builds({ action: "create-channel", channel: "beta", audience: "secret", api: API } as never));

    expect(out.ok).toBe(false);
    expect(out.error.code).toBe("E_BAD_REQUEST");
    expect(out.error.message).toMatch(/public or private/);
    expect(world.calls).toHaveLength(0);
  });

  it("names audience in the schema with the two values and the project's visibility as the default", () => {
    const audience = (schema.inputSchema.properties as Record<string, any>).audience;

    expect(audience.enum).toEqual(["public", "private"]);
    expect(audience.description).toMatch(/project's visibility/);
  });
});
