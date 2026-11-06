import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { handler } from "../tools/publish";
import { publishAnswer, publishAnswerWithLink } from "./fixtures/platform-answers";

const API = "https://www.extension.dev";

function publicAnswer(withLink: boolean): Record<string, unknown> {
  const overrides = {
    visibility: "public",
    shareUrl: "https://acme.extension.dev/widget/builds/abc1234",
    token: undefined,
    expiresAt: undefined,
    ttlHours: undefined,
    previewCommands: {
      chrome: "npx -y extension@latest preview https://acme.extension.dev/widget/builds/abc1234/chrome.zip",
    },
  };

  return withLink ? publishAnswerWithLink(overrides) : publishAnswer(overrides);
}

describe("405: extension_publish on a public project answers the link it tells the person to send", () => {
  let tmp: string;
  let prevXdg: string | undefined;
  let prevToken: string | undefined;
  let prevApi: string | undefined;
  let prevFetch: typeof fetch;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "extdev-publish-public-"));
    prevXdg = process.env.XDG_CONFIG_HOME;
    prevToken = process.env.EXTENSION_DEV_TOKEN;
    prevApi = process.env.EXTENSION_DEV_API_URL;
    prevFetch = global.fetch;
    process.env.XDG_CONFIG_HOME = tmp;
    delete process.env.EXTENSION_DEV_API_URL;
    process.env.EXTENSION_DEV_TOKEN = `${Buffer.from(
      JSON.stringify({ u: "acme", p: "widget", exp: Math.floor(Date.now() / 1000) + 600 }),
    ).toString("base64url")}.sig`;
  });

  afterEach(() => {
    global.fetch = prevFetch;
    if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prevXdg;
    if (prevToken === undefined) delete process.env.EXTENSION_DEV_TOKEN;
    else process.env.EXTENSION_DEV_TOKEN = prevToken;
    if (prevApi === undefined) delete process.env.EXTENSION_DEV_API_URL;
    else process.env.EXTENSION_DEV_API_URL = prevApi;

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  async function publishAgainst(answer: Record<string, unknown>, channels: Record<string, unknown> = {}) {
    global.fetch = (async (url: string) => {
      const href = String(url);
      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

      if (href.endsWith("/api/cli/publish")) return json(answer);
      if (href.endsWith("/channels.json")) return json(channels);
      if (href.endsWith("/builds/index.json")) return json({ items: [] });

      return json({}, 404);
    }) as unknown as typeof fetch;

    return JSON.parse(await handler({ api: API }));
  }

  it.each([
    ["a platform that answers link", true],
    ["an older platform with no link", false],
  ])("value.link is the channel link that tellThem sends, from %s", async (_name, withLink) => {
    const out = await publishAgainst(publicAnswer(withLink), { "chrome-stable": { sha: "abc1234" } });

    expect(out.ok).toBe(true);
    expect(out.value.link).toMatchObject({
      kind: "channel",
      url: "https://acme.extension.dev/widget/stable",
      audience: "public",
      expiresAt: null,
    });

    expect(out.value.tellThem).toBe(
      "Here is widget to try: https://acme.extension.dev/widget/stable. It always opens the newest stable build.",
    );

    expect(out.value.tellThem).toContain(out.value.link.url);
    expect(out.value.tellThem).not.toContain("/builds/abc1234");
  });

  it("never calls a public project's link long or unminted", async () => {
    const served = await publishAgainst(publicAnswer(true), { "chrome-stable": { sha: "abc1234" } });
    const unserved = await publishAgainst(publicAnswer(true));

    for (const out of [served, unserved]) {
      expect(out.hint).toContain("Send value.tellThem to the person as written.");
      expect(out.hint).not.toContain("long");
      expect(out.hint).not.toContain("has not minted");
    }

    expect(unserved.value.link).toMatchObject({ kind: "build", url: "https://acme.extension.dev/widget/builds/abc1234", audience: "public" });
    expect(unserved.value.tellThem).toContain(unserved.value.link.url);
  });

  it("gives each link one audience word, the same in links[] as in value.link", async () => {
    const out = await publishAgainst(publicAnswer(true), { "chrome-stable": { sha: "abc1234" } });
    const own = out.value.links.filter((row: { url: string }) => row.url.startsWith("https://acme.extension.dev/"));
    const sent = own.find((row: { url: string }) => row.url === out.value.link.url);

    expect(own.map((row: { url: string; audience: string }) => [row.url, row.audience])).toEqual([
      ["https://acme.extension.dev/widget/builds/abc1234", "public"],
      ["https://acme.extension.dev/widget/stable", "public"],
    ]);

    expect(sent.audience).toBe(out.value.link.audience);
    expect(new Set(out.value.links.map((row: { url: string }) => row.url)).size).toBe(out.value.links.length);
  });

  it("still says why a private link is long when the platform minted no short one", async () => {
    const out = await publishAgainst(publishAnswer());

    expect(out.value.link.id).toBeNull();
    expect(out.value.link.url).toContain("?share=");
    expect(out.hint).toContain("its link is long because the platform has not minted a short one yet");
    expect(out.value.links[0]).toMatchObject({ kind: "share", audience: "anyone with the link" });
  });
});
