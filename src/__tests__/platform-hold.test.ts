import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  PLATFORM_HOLD_CODE,
  PLATFORM_HOLD_RELAYS_THE_PLATFORM_DATE,
  platformHoldMessage,
} from "../lib/platform-hold";
import { fetchRegistryJson } from "../lib/registry";
import { handler as publishHandler } from "../tools/publish";
import { handler as promoteHandler } from "../tools/release-promote";
import { handler as submitHandler } from "../tools/submit";

const srcDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const HELD_HOSTS = [
  "console.extension.dev",
  "www.extension.dev",
  "code.extension.dev",
  "docs.extension.dev",
  "inspect.extension.dev",
  "preview.extension.dev",
  "themes.extension.dev",
  "userland.extension.dev",
  "extension.dev/new",
];

const HELD_BODY = {
  message:
    "extension.dev is not open to the public yet. This action is not available yet.",
  code: PLATFORM_HOLD_CODE,
};

const heldResponse = (body: unknown = HELD_BODY) =>
  new Response(JSON.stringify(body), {
    status: 403,
    headers: { "content-type": "application/json" },
  });

describe("the published client had no hold awareness at all, so this file is the whole contract", () => {
  let tmp: string;
  let prevXdg: string | undefined;
  let prevToken: string | undefined;
  let prevApi: string | undefined;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "extdev-hold-"));
    prevXdg = process.env.XDG_CONFIG_HOME;
    prevToken = process.env.EXTENSION_DEV_TOKEN;
    prevApi = process.env.EXTENSION_DEV_API_URL;
    process.env.XDG_CONFIG_HOME = tmp;
    process.env.EXTENSION_DEV_TOKEN = "tok_hold_test";
    delete process.env.EXTENSION_DEV_API_URL;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prevXdg;
    if (prevToken === undefined) delete process.env.EXTENSION_DEV_TOKEN;
    else process.env.EXTENSION_DEV_TOKEN = prevToken;
    if (prevApi === undefined) delete process.env.EXTENSION_DEV_API_URL;
    else process.env.EXTENSION_DEV_API_URL = prevApi;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("carries the refusal body across the registry hop instead of collapsing it to a status", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ message: "the sentence we wrote" }), {
          status: 403,
        }),
    ) as unknown as typeof fetch;

    const result = await fetchRegistryJson(
      "https://registry.extension.dev/ws/proj/_extension-dev/channels.json",
      fetchImpl,
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.message).toContain("the sentence we wrote");
    expect(result.status).toBe(403);
  });

  it("marks a held registry read and never buys an access grant for it", async () => {
    const fetchImpl = vi.fn(async () => heldResponse()) as unknown as typeof fetch;
    const tokens = {
      peek: () => "",
      get: vi.fn(async () => ({ status: "ok" as const, token: "grant" })),
      forget: () => {},
    };

    const result = await fetchRegistryJson(
      "https://registry.extension.dev/ws/proj/_extension-dev/channels.json",
      fetchImpl,
      { ref: { workspace: "ws", project: "proj" }, tokens: tokens as never },
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.held).toBe(true);
    expect(result.code).toBe(PLATFORM_HOLD_CODE);
    expect(tokens.get).not.toHaveBeenCalled();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  /* @invariant Gabe's three parts, asserted one at a time so a failure names
     which part went missing. (b) is the one the published bytes lacked
     entirely, and it is the reason a reader concludes the product works
     rather than that it is broken. */
  it("answers a held publish with the condition, what still works, and a way back", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => heldResponse()),
    );
    const out = JSON.parse(await publishHandler({}));

    expect(out.ok).toBe(false);
    expect(out.status).toBe("platform-held");
    expect(out.error.platformCode).toBe(PLATFORM_HOLD_CODE);

    expect(out.error.message).toContain(
      "extension.dev is not open to the public yet",
    );
    expect(out.error.message).toContain("extension_create");
    expect(out.error.message).toContain("extension_build");
    expect(out.error.message).toContain("free forever");
    expect(out.error.message).toContain("https://templates.extension.dev");

    expect(out.value.stillWorks).toContain("extension_dev");
    expect(out.value.openSurface).toBe("https://templates.extension.dev");
    expect(out.hint).toContain("templates.extension.dev");
  });

  it("sends a held reader to no held surface, on any lane", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => heldResponse()),
    );

    const frames = [
      JSON.parse(await publishHandler({})),
      JSON.parse(
        await promoteHandler({ buildId: "abc1234", channel: "stable" }),
      ),
      JSON.parse(
        await submitHandler({ browsers: ["chrome"], buildSha: "abc1234" }),
      ),
    ];

    for (const frame of frames) {
      const text = JSON.stringify(frame);
      expect(frame.status).toBe("platform-held");
      for (const host of HELD_HOSTS) {
        expect(text, `${frame.command} points at ${host}`).not.toContain(host);
      }
      expect(text).toContain("templates.extension.dev");
    }
  });

  /* @invariant The date is not merely absent from the sentence, it is absent
     from the shipped bytes. A tarball is public, so a date parked in a string
     behind a false flag would disclose the day to anyone who ran npm pack. */
  it("names no date, and the source tree holds none to name", () => {
    const message = platformHoldMessage(HELD_BODY);
    expect(message).not.toMatch(/\b20\d\d-\d\d-\d\d\b/);
    expect(message).not.toMatch(/September|Sept\b/i);

    const walk = (dir: string): string[] => {
      const out: string[] = [];
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.name === "__tests__") continue;
        if (entry.isDirectory()) out.push(...walk(full));
        else if (entry.name.endsWith(".ts")) out.push(full);
      }
      return out;
    };

    for (const file of walk(srcDir)) {
      const text = fs.readFileSync(file, "utf8");
      expect(text, `${file} ships a launch date`).not.toContain("2026-09-06");
      expect(text, `${file} ships a launch date`).not.toContain(
        "September 6, 2026",
      );
    }
  });

  it("keeps the date relay off, so a date the platform sends today is dropped", () => {
    expect(PLATFORM_HOLD_RELAYS_THE_PLATFORM_DATE).toBe(false);
    const message = platformHoldMessage({
      ...HELD_BODY,
      opensAt: "a day the platform named",
    });
    expect(message).not.toContain("a day the platform named");
  });

  it("reads the machine field and not the sentence, so www may reword the refusal", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              message: "some other wording entirely",
              code: PLATFORM_HOLD_CODE,
            }),
            { status: 403 },
          ),
      ),
    );
    const out = JSON.parse(await publishHandler({}));
    expect(out.status).toBe("platform-held");
    expect(out.error.message).toContain("some other wording entirely");
    expect(out.error.message).toContain("templates.extension.dev");
  });

  it("does not read our own way through the hold as a refusal", async () => {
    const enroll = new Response(JSON.stringify({ message: "nope" }), {
      status: 403,
      headers: { "x-extensiondev-hold": "operator-enroll" },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => enroll),
    );
    const out = JSON.parse(await publishHandler({}));
    expect(out.status).toBe("publish-failed");
  });

  it("leaves an ordinary platform failure alone", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ message: "project not found" }), {
            status: 404,
          }),
      ),
    );
    const out = JSON.parse(await publishHandler({}));
    expect(out.status).toBe("publish-failed");
    expect(out.error.message).toContain("project not found");
  });
});
