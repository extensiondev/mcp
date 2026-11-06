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

import { channelFillSentence, channelSource } from "../lib/channel-link";
import { handler as publish } from "../tools/publish";
import { channelsServeLine, readReleases } from "../tools/release-list";

const PREVIEW_SHA = "70d148e70d148e70d148e70d148e70d148e70d148e";
const STABLE_SHA = "0c7471e0c7471e0c7471e0c7471e0c7471e0c7471e";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const saved: Record<string, string | undefined> = {};
let tmp: string;

beforeEach(() => {
  for (const key of ["XDG_CONFIG_HOME", "EXTENSION_DEV_API_URL", "EXTENSION_DEV_TOKEN", "EXTENSION_DEV_PROJECT"]) {
    saved[key] = process.env[key];
    delete process.env[key];
  }

  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "extdev-channel-source-"));
  process.env.XDG_CONFIG_HOME = tmp;
  process.env.EXTENSION_DEV_API_URL = "https://api.test";
  process.env.EXTENSION_DEV_TOKEN = `${Buffer.from(
    JSON.stringify({ u: "acme", p: "widget", exp: Math.floor(Date.now() / 1000) + 600 }),
  ).toString("base64url")}.sig`;
});

afterEach(() => {
  vi.unstubAllGlobals();

  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  fs.rmSync(tmp, { recursive: true, force: true });
});

function stubRegistry(channels: Record<string, unknown>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: any) => {
      const pathname = new URL(String(url)).pathname;

      if (pathname.endsWith("/channels.json")) return jsonResponse(channels);
      if (pathname.endsWith("/meta.json")) return jsonResponse({ name: "Widget", visibility: "private" });
      if (pathname.endsWith("/builds/index.json")) return jsonResponse({ items: [] });

      return jsonResponse({ message: "not found" }, 404);
    }),
  );
}

describe("extension_release_status says how each channel fills (ledger 444)", () => {
  it("reads a preview row the build run wrote as environment and never calls its sha pinned", async () => {
    stubRegistry({
      preview: { sha: PREVIEW_SHA, buildId: "70d148e", version: "0.1.0" },
      "chrome-preview": { sha: PREVIEW_SHA, buildId: "70d148e", version: "0.1.0" },
    });

    const out = JSON.parse(await readReleases({ workspace: "acme", project: "widget" }));
    const rows = out.value.channels as Array<Record<string, unknown>>;

    expect(out.ok).toBe(true);
    expect(rows.map((row) => row.source)).toEqual(["environment", "environment"]);
    expect(out.hint).toContain(`preview serves ${PREVIEW_SHA} by environment`);
    expect(out.hint).toContain("no promotion");
    expect(out.hint).not.toMatch(/pin/);
  });

  it("reads a stable row as promotion and says it is pinned", async () => {
    stubRegistry({
      stable: { sha: STABLE_SHA, promotedAt: "2026-11-01T00:00:00Z" },
      "firefox-stable": { sha: STABLE_SHA },
      preview: { sha: "", buildId: "", version: "" },
    });

    const out = JSON.parse(await readReleases({ workspace: "acme", project: "widget" }));
    const rows = out.value.channels as Array<Record<string, unknown>>;

    expect(rows.find((row) => row.channel === "stable")?.source).toBe("promotion");
    expect(rows.find((row) => row.channel === "firefox-stable")?.source).toBe("promotion");
    expect(rows.find((row) => row.channel === "preview")?.source).toBe("environment");
    expect(out.hint).toContain(`stable pins ${STABLE_SHA} (promoted)`);
    expect(out.hint).toContain("preview serves no build yet by environment");
  });

  it("groups the browser rows of one channel into one clause", () => {
    expect(
      channelsServeLine([
        { channel: "preview", sha: PREVIEW_SHA },
        { channel: "chrome-preview", sha: PREVIEW_SHA },
        { channel: "edge-preview", sha: PREVIEW_SHA },
        { channel: "stable", sha: STABLE_SHA },
      ]),
    ).toBe(
      `preview serves ${PREVIEW_SHA} by environment (every successful build lands there, no promotion); stable pins ${STABLE_SHA} (promoted)`,
    );
  });

  it("classifies channel keys with and without a browser prefix", () => {
    expect(channelSource("preview")).toBe("environment");
    expect(channelSource("firefox-preview")).toBe("environment");
    expect(channelSource("stable")).toBe("promotion");
    expect(channelSource("chrome-beta")).toBe("promotion");
  });
});

describe("extension_publish CHANNEL_HAS_NO_BUILD names the read that predicts it (ledger 444)", () => {
  function stubPublish(code: string) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: any) => {
        if (String(url).endsWith("/api/cli/publish")) {
          return new Response(JSON.stringify({ message: "refused", code }), { status: 409 });
        }

        return new Response("not found", { status: 404 });
      }),
    );
  }

  it("sends a preview refusal to a build, not a promotion", async () => {
    stubPublish("CHANNEL_HAS_NO_BUILD");

    const out = JSON.parse(await publish({ channel: "preview" }));

    expect(out.status).toBe("channel-has-no-build");
    expect(out.hint).toContain("extension_release_status (include: ['releases']) value.channels");
    expect(out.hint).toContain("source");
    expect(out.hint).toContain("preview fills by environment");
    expect(out.hint).not.toContain("extension_release_promote");
  });

  it("sends a stable refusal to extension_release_promote", async () => {
    stubPublish("CHANNEL_HAS_NO_BUILD");

    const out = JSON.parse(await publish({ channel: "stable" }));

    expect(out.hint).toContain("value.channels");
    expect(out.hint).toContain("extension_release_promote");
    expect(channelFillSentence("stable")).toContain("extension_release_promote");
  });

  it("points the unknown-channel refusal at the releases read, which exists", async () => {
    stubPublish("CHANNEL_NOT_FOUND");

    const out = JSON.parse(await publish({ channel: "nightly" }));

    expect(out.hint).toContain("include: ['releases']");
    expect(out.hint).not.toContain("include: ['channels']");
  });
});
