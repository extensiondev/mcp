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

import { userlandChannelUrl } from "@extension.dev/urls/userland";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { serverInstructions, tools } from "../index";
import { handler as publish, schema as publishSchema } from "../tools/publish";
import { handler as promote, schema as promoteSchema } from "../tools/release-promote";
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

describe("the tools tell an agent which link to send testers", () => {
  it.each([
    ["extension_publish", publishSchema.description],
    ["the server instructions", serverInstructions({ features: ["local", "platform"], noShip: false })],
  ])("%s", (_where, text) => {
    expect(text.toLowerCase()).toContain(SENTENCE);
  });
});

describe("extension_release_status carries each channel's audience when the platform records it", () => {

  it("says where a build link's validity is read today", () => {
    expect(releaseStatusSchema.description).toMatch(/channels/);
  });
});

function spelledChannelLink(browser?: string): string {
  const url = userlandChannelUrl({ workspace: "workspace", project: "project" }, "channel", browser ? { browser } : {});

  return url
    .replace(/^https:\/\//, "")
    .replace(/^workspace\./, "<workspace>.")
    .replace("/project/", "/<project>/")
    .replace(/\/channel(?=\/|$)/, "/<channel>")
    .replace(/\/browser$/, "/<browser>");
}

describe("a tool names the channel link it answers and spells no path for it", () => {
  it.each([
    ["the server instructions", () => serverInstructions({ features: ["local", "platform"], noShip: false }), undefined],
    ["extension_publish", () => publishSchema.description, undefined],
  ])("%s", (_where, read, browser) => {
    const text = read();

    expect(text).toContain("channel link");
    expect(text).not.toContain(spelledChannelLink(browser));
    expect(text).not.toMatch(/\/channels\/<|\/channels\/\$\{/);
  });

  it("no tool spells a channel page under the old channels path, nor the path at all (ledger 1141)", () => {
    const spelled = JSON.stringify(tools.map((tool) => tool.schema));

    expect(spelled).not.toContain("<project>/<channel>");
    expect(spelled).not.toMatch(/\/channels\/</);
  });
});
