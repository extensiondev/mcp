// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { serverInstructions } from "../index";
import { handler as publish, schema as publishSchema } from "../tools/publish";
import { handler as promote, schema as promoteSchema } from "../tools/release-promote";
import { readReleases } from "../tools/release-list";
import { schema as releaseStatusSchema } from "../tools/release-status";
import { promoteAnswer, publishAnswer } from "./fixtures/platform-answers";

const API = "https://www.extension.dev";
const PROJECT = "https://acme.extension.dev/widget";
const CHANNELS = {
  "chrome-stable": { sha: "abc1234" },
  "firefox-stable": { sha: "abc1234" },
  beta: { sha: "bead5ee" },
};
const SENTENCE = "on a public project, or a public channel, send testers the channel link";

const saved: Record<string, string | undefined> = {};
let tmp: string;

function registry(visibility: "public" | "private") {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: unknown) => {
      const href = String(url);
      const json = (body: unknown) =>
        new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

      if (href.endsWith("/api/cli/publish")) return json(publishAnswer({ visibility, buildSha: "abc1234" }));
      if (href.endsWith("/api/cli/release/promote")) return json(promoteAnswer({ queuedBrowsers: ["chrome", "firefox"] }));
      if (href.endsWith("/api/cli/whoami")) return json({ login: "acme/widget", projectId: "prj_1", workspaceSlug: "acme", projectSlug: "widget" });
      if (href.endsWith("/api/projects/prj_1/releases")) return json({ items: [{ id: "rel_1", channel: "stable", buildId: "abc1234", status: "completed" }] });
      if (href.endsWith("/channels.json")) return json(CHANNELS);
      if (href.endsWith("/meta.json")) return json({ name: "Widget", visibility });
      if (href.endsWith("/builds/index.json")) return json({ items: [] });

      return new Response("{}", { status: 404, headers: { "content-type": "application/json" } });
    }),
  );
}

beforeEach(() => {
  for (const key of ["XDG_CONFIG_HOME", "EXTENSION_DEV_API_URL", "EXTENSION_DEV_TOKEN", "EXTENSION_DEV_APPROVAL_GATE"]) {
    saved[key] = process.env[key];
  }

  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "extdev-channel-link-"));
  process.env.XDG_CONFIG_HOME = tmp;
  process.env.EXTENSION_DEV_API_URL = API;
  process.env.EXTENSION_DEV_TOKEN = `${Buffer.from(
    JSON.stringify({ u: "acme", p: "widget", exp: Math.floor(Date.now() / 1000) + 600 }),
  ).toString("base64url")}.sig`;

  process.env.EXTENSION_DEV_APPROVAL_GATE = "0";
});

afterEach(() => {
  vi.unstubAllGlobals();

  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("a public project's answers carry the link that follows a release channel", () => {
  it("extension_publish names the channel that serves the published build", async () => {
    registry("public");
    const out = JSON.parse(await publish({ api: API }));

    expect(out.ok).toBe(true);
    expect(out.value.channelUrl).toBe(`${PROJECT}/channels/stable`);
  });

  it("extension_release_status links each channel, per browser where the channel is", async () => {
    registry("public");
    const out = JSON.parse(await readReleases({ workspace: "acme", project: "widget", api: API }));
    const byName = Object.fromEntries(
      (out.value.channels as Array<{ channel: string; channelUrl?: string }>).map((c) => [c.channel, c.channelUrl]),
    );

    expect(byName).toEqual({
      "chrome-stable": `${PROJECT}/channels/chrome/stable`,
      "firefox-stable": `${PROJECT}/channels/firefox/stable`,
      beta: `${PROJECT}/channels/beta`,
    });
  });

  it("extension_release_promote names the channel it moved", async () => {
    registry("public");
    const out = JSON.parse(
      await promote({ buildId: "abc1234", channel: "stable", browsers: ["chrome", "firefox"], api: API } as never),
    );

    expect(out.status).toBe("promoted");
    expect(out.value.outcome).toMatchObject({ recorded: true, status: "completed" });
    expect(out.value.channelUrl).toBe(`${PROJECT}/channels/stable`);
    expect(out.value.links).toContainEqual({ kind: "channel", url: `${PROJECT}/channels/stable`, audience: "anyone with the link", expiresAt: null, made: false });
  });
});

describe("a private project's answers withhold the channel link and say why", () => {
  it.each([
    ["extension_publish", () => publish({ api: API })],
    ["extension_release_status", () => readReleases({ workspace: "acme", project: "widget", api: API })],
    [
      "extension_release_promote",
      () => promote({ buildId: "abc1234", channel: "stable", browsers: ["chrome", "firefox"], api: API } as never),
    ],
  ])("%s", async (_tool, call) => {
    registry("private");
    const out = JSON.parse(await call());
    const said = JSON.stringify(out);

    expect(out.ok).toBe(true);
    expect(said).not.toContain("/channels/");
    expect(out.value.channelUrlWithheld).toMatch(/private/);
    expect(out.value.channelUrlWithheld).toContain("extension_publish");
    expect(out.value.channelUrlWithheld).toContain("extension.dev project settings");
    expect(out.value.channelUrlWithheld).toMatch(/console Settings, Visibility section/);
    expect(out.value.channelUrlWithheld).not.toMatch(/repositor/i);
  });
});

describe("the tools tell an agent which link to send testers", () => {
  it.each([
    ["extension_publish", publishSchema.description],
    ["extension_release_status", releaseStatusSchema.description],
    ["extension_release_promote", promoteSchema.description],
    ["the server instructions", serverInstructions({ features: ["local", "platform"], noShip: false })],
  ])("%s", (_where, text) => {
    expect(text.toLowerCase()).toContain(SENTENCE);
  });
});

describe("extension_release_status carries each channel's audience when the platform records it", () => {
  it("passes audience through on a channel row and leaves it off a row that has none", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown) => {
        const href = String(url);
        const json = (body: unknown) =>
          new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

        if (href.endsWith("/channels.json")) {
          return json({ "chrome-stable": { sha: "abc1234", audience: "public" }, beta: { sha: "bead5ee", audience: "private" }, nightly: { sha: "c0ffee1" } });
        }

        if (href.endsWith("/meta.json")) return json({ name: "Widget", visibility: "public" });
        if (href.endsWith("/builds/index.json")) return json({ items: [] });

        return new Response("{}", { status: 404, headers: { "content-type": "application/json" } });
      }),
    );

    const out = JSON.parse(await readReleases({ workspace: "acme", project: "widget", api: API }));
    const byName = Object.fromEntries(
      (out.value.channels as Array<{ channel: string; audience?: string }>).map((c) => [c.channel, c.audience ?? null]),
    );

    expect(byName).toEqual({ "chrome-stable": "public", beta: "private", nightly: null });
  });

  it("says where a build link's validity is read today", () => {
    expect(releaseStatusSchema.description).toMatch(/Settings, Share links section/);
    expect(releaseStatusSchema.description).toMatch(/audience/);
  });
});
