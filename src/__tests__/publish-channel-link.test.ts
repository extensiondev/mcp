import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { handler } from "../tools/publish";
import { publishAnswerWithLink, publishChannelAnswer } from "./fixtures/platform-answers";

const saved: Record<string, string | undefined> = {};
let tmp: string;
let sent: Array<Record<string, unknown>> = [];

function stubPublish(body: unknown, status = 200) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: any, init?: RequestInit) => {
      const href = String(url);

      if (href.endsWith("/api/cli/publish")) {
        sent.push(JSON.parse(String(init?.body ?? "{}")));

        return new Response(JSON.stringify(body), { status });
      }

      return new Response("not found", { status: 404 });
    }),
  );
}

beforeEach(() => {
  for (const key of ["XDG_CONFIG_HOME", "EXTENSION_DEV_API_URL", "EXTENSION_DEV_TOKEN", "EXTENSION_DEV_PROJECT"]) {
    saved[key] = process.env[key];
  }

  sent = [];
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "extdev-publish-channel-"));
  process.env.XDG_CONFIG_HOME = tmp;
  process.env.EXTENSION_DEV_API_URL = "https://api.test";
  process.env.EXTENSION_DEV_TOKEN = `${Buffer.from(
    JSON.stringify({ u: "acme", p: "widget", exp: Math.floor(Date.now() / 1000) + 600 }),
  ).toString("base64url")}.sig`;

  delete process.env.EXTENSION_DEV_PROJECT;
});

afterEach(() => {
  vi.unstubAllGlobals();

  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("extension_publish channel link on a private project", () => {
  it("asks the platform for the channel's link", async () => {
    stubPublish(publishChannelAnswer());

    await handler({ channel: "preview", ttlHours: 720 });

    expect(sent).toEqual([{ channel: "preview", ttlHours: 720 }]);
  });

  it("refuses a channel and a build together before calling the platform", async () => {
    stubPublish(publishChannelAnswer());

    const out = JSON.parse(await handler({ channel: "preview", buildSha: "abc1234" }));

    expect(out.ok).toBe(false);
    expect(out.error.code).toBe("E_BAD_REQUEST");
    expect(sent).toHaveLength(0);
  });

  it.each(["../stable", "preview/x", "Preview Two", ""])("refuses the channel name %j before calling the platform", async (channel) => {
    stubPublish(publishChannelAnswer());

    const out = JSON.parse(await handler({ channel }));

    expect(out.ok).toBe(false);
    expect(out.error.code).toBe("E_BAD_REQUEST");
    expect(sent).toHaveLength(0);
  });

  it("answers the channel link as the link to send, with its end date", async () => {
    stubPublish(publishChannelAnswer());

    const out = JSON.parse(await handler({ channel: "preview", ttlHours: 720 }));

    expect(out.ok).toBe(true);
    expect(out.value.link).toMatchObject({
      kind: "channel",
      url: "https://acme.extension.dev/widget/preview?share=chn_share01",
      scope: "channel:preview",
      serves: { channel: "preview", follows: true },
    });

    expect(out.value.tellThem).toContain("https://acme.extension.dev/widget/preview?share=chn_share01");
    expect(out.value.tellThem).toContain("newest preview build");
    expect(out.value.tellThem).toMatch(/until [A-Z][a-z]+ \d+, \d{4}/);
    expect(out.value.channelUrlWithheld).toBeUndefined();
  });

  it("says which builds it serves and when and how it is renewed", async () => {
    stubPublish(publishChannelAnswer());

    const out = JSON.parse(await handler({ channel: "preview", ttlHours: 720 }));
    const said = [...out.warnings, ...out.value.notes].join(" ");

    expect(out.value.link.renewBy).toEqual({
      tool: "extension_publish",
      args: { channel: "preview", ttlHours: 720 },
    });

    expect(said).toContain("b2b2b2b");
    expect(said).toContain("every build preview serves from now");
    expect(said).toContain("1 build it served before");
    expect(said).toMatch(/renew before [A-Z][a-z]+ \d+, \d{4}/);
    expect(said).toContain("new address");
  });

  it("lists the channel link as one it made", async () => {
    stubPublish(publishChannelAnswer());

    const out = JSON.parse(await handler({ channel: "preview" }));
    const row = out.value.links.find((link: { kind: string }) => link.kind === "channel");

    expect(row).toMatchObject({ url: "https://acme.extension.dev/widget/preview?share=chn_share01", made: true });
  });

  it.each([
    ["CHANNEL_NOT_FOUND", 404, "channel-unknown"],
    ["CHANNEL_HAS_NO_BUILD", 409, "channel-has-no-build"],
  ])("answers the platform's %s with its own status and a next step", async (code, status, word) => {
    stubPublish({ message: "refused", code }, status);

    const out = JSON.parse(await handler({ channel: "preview" }));

    expect(out.ok).toBe(false);
    expect(out.status).toBe(word);
    expect(out.error.platformCode).toBe(code);
    expect(out.hint).toMatch(/extension_release_(promote|status)/);
  });
});

describe("extension_publish channel link from a platform that does not mint one", () => {
  it("says the link is a build link and will change, never a channel link", async () => {
    stubPublish(publishAnswerWithLink());

    const out = JSON.parse(await handler({ channel: "preview" }));

    expect(out.ok).toBe(true);
    expect(out.value.link.kind).toBe("build");
    expect(out.warnings.join(" ")).toContain("answered a build link, not a channel link");
    expect(out.warnings.join(" ")).toContain("changes with the next build");
  });
});

describe("extension_publish build link on a private project", () => {
  it("points at the channel link when it withholds the public one", async () => {
    stubPublish(publishAnswerWithLink());

    const out = JSON.parse(await handler({}));

    expect(out.value.link.kind).toBe("build");
    expect(out.value.channelUrlWithheld).toContain("channel: 'preview'");
  });
});
