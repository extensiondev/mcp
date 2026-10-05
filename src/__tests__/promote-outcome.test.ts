import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { handler, schema } from "../tools/release-promote";
import { readPromoteOutcome } from "../lib/promote-outcome";
import { promoteAnswer } from "./fixtures/platform-answers";

const API = "https://api.test";
const saved: Record<string, string | undefined> = {};
let tmp: string;

function stubPromote(body: unknown, status = 200) {
  const calls: Array<{ url: string; body: any }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: any, init?: RequestInit) => {
      const href = String(url);
      if (href.endsWith("/api/cli/release/promote")) {
        calls.push({ url: href, body: JSON.parse(String(init?.body ?? "{}")) });
        return new Response(
          typeof body === "string" ? body : JSON.stringify(body),
          { status },
        );
      }
      throw new Error(`Unexpected fetch: ${href}`);
    }),
  );
  return calls;
}

async function promote(extra: Record<string, unknown> = {}) {
  return JSON.parse(
    await handler({
      buildId: "abc1234",
      channel: "beta",
      browsers: ["chrome", "firefox"],
      ...extra,
    } as never),
  );
}

beforeEach(() => {
  for (const key of [
    "XDG_CONFIG_HOME",
    "EXTENSION_DEV_API_URL",
    "EXTENSION_DEV_TOKEN",
    "EXTENSION_DEV_APPROVAL_GATE",
  ]) {
    saved[key] = process.env[key];
  }
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "extdev-promote-"));
  process.env.XDG_CONFIG_HOME = tmp;
  process.env.EXTENSION_DEV_API_URL = API;
  process.env.EXTENSION_DEV_TOKEN = "release-token";
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

describe("extension_release_promote reads the platform's answer, not its status code", () => {
  it("says promoted when every asked browser was dispatched and the pointer moved", async () => {
    stubPromote(promoteAnswer({ queuedBrowsers: ["chrome", "firefox"] }));
    const out = await promote();

    expect(out.ok).toBe(true);
    expect(out.status).toBe("promoted");
    expect(out.warnings ?? []).toEqual([]);
    expect(out.hint).toContain("chrome, firefox");
    expect(out.hint).toContain("extension_release_status");
    expect(out.value.incomplete).toBeUndefined();
  });

  it("does not say promoted when the channel pointer was not moved", async () => {
    stubPromote(
      promoteAnswer({
        status: "degraded",
        mirrorSync: { ok: false, pending: ["channels"] },
        queuedBrowsers: ["chrome", "firefox"],
      }),
    );
    const out = await promote();

    expect(out.status).toBe("promoted-partially");
    expect(out.value.incomplete.pendingMirrors).toEqual(["channels"]);
    expect(out.warnings.join(" ")).toContain("channel pointer was NOT moved");
    expect(out.hint).toContain("Do not repeat the whole promote");
  });

  it("names the browser whose dispatch failed and how to retry only that one", async () => {
    stubPromote(promoteAnswer({ failedBrowsers: ["firefox"] }));
    const out = await promote();

    expect(out.status).toBe("promoted-partially");
    expect(out.value.incomplete.failedBrowsers).toEqual(["firefox"]);
    expect(out.warnings.join(" ")).toContain("NOT dispatched for firefox");
    expect(out.warnings.join(" ")).toContain("browsers limited to firefox");
    expect(out.warnings.join(" ")).toContain("do not repeat chrome");
  });

  it("names release notes the platform could not write without blaming the pointer", async () => {
    stubPromote(
      promoteAnswer({
        status: "degraded",
        mirrorSync: { ok: false, pending: ["release-notes"] },
      }),
    );
    const out = await promote();

    expect(out.status).toBe("promoted-partially");
    expect(out.warnings.join(" ")).toContain("release-notes");
    expect(out.warnings.join(" ")).not.toContain("pointer was NOT moved");
  });

  it("says so when the platform calls the promote degraded and names no part", async () => {
    stubPromote(promoteAnswer({ status: "degraded", mirrorSync: undefined }));
    const out = await promote();

    expect(out.status).toBe("promoted-partially");
    expect(out.warnings.join(" ")).toContain("without saying which part");
  });

  it("names a GitHub Release that was not published", async () => {
    stubPromote(promoteAnswer({ githubRelease: { ok: false } }));
    const out = await promote();

    expect(out.status).toBe("promoted-partially");
    expect(out.warnings.join(" ")).toContain("GitHub Release");
  });

  it.each([
    ["an empty object", {}],
    ["a bare ok", { ok: true }],
    ["a message only", { message: "promoted" }],
    ["ok without browsers", { ok: true, status: "ok", queuedBrowsers: [] }],
    ["a page of html", "<html>ok</html>"],
    ["nothing at all", ""],
  ])("refuses to call %s a promote", async (_label, body) => {
    stubPromote(body);
    const out = await promote();

    expect(out.ok).toBe(false);
    expect(out.status).toBe("promote-unconfirmed");
    expect(out.error.message).toContain("is unknown");
    expect(out.hint).toContain("Do not promote again blind");
    expect(out.hint).toContain("extension_release_status");
  });

  it("promises the partial and unconfirmed statuses in its description", () => {
    expect(schema.description).toContain("promoted-partially");
    expect(schema.description).toContain("promote-unconfirmed");
  });
});

describe("readPromoteOutcome", () => {
  it("takes the real whole answer as promoted", () => {
    expect(readPromoteOutcome(promoteAnswer())).toEqual({
      state: "promoted",
      queuedBrowsers: ["chrome"],
      notarization: { pending: [], refused: null },
    });
  });

  it("does not let a truthy but non-literal ok through", () => {
    expect(readPromoteOutcome(promoteAnswer({ ok: "true" })).state).toBe(
      "unconfirmed",
    );
  });

  it("never lets notarization change the verdict of a whole promote", () => {
    for (const notarization of [
      { ok: false, started: [], pending: ["safari"] },
      { ok: true, started: ["safari"], pending: [] },
      {
        ok: true,
        started: [],
        pending: [],
        refused: {
          browsers: ["safari"],
          reason: "macos_notarization_not_included",
          upgradeUrl: "https://extension.dev/pricing",
        },
      },
    ]) {
      expect(readPromoteOutcome(promoteAnswer({ notarization })).state).toBe(
        "promoted",
      );
    }
  });
});

describe("extension_release_promote says what notarization will not do", () => {
  it("warns on a whole promote whose notarization the plan refused", async () => {
    stubPromote(
      promoteAnswer({
        queuedBrowsers: ["chrome", "firefox"],
        notarization: {
          ok: true,
          started: [],
          pending: [],
          refused: {
            browsers: ["safari"],
            reason: "macos_notarization_not_included",
            upgradeUrl: "https://extension.dev/pricing",
          },
        },
      }),
    );
    const out = await promote();

    expect(out.status).toBe("promoted");
    expect(out.warnings.join(" ")).toContain("will NOT happen for safari");
    expect(out.warnings.join(" ")).toContain("macos_notarization_not_included");
    expect(out.warnings.join(" ")).toContain("https://extension.dev/pricing");
  });

  it("says a pending notarization is not part of the answer", async () => {
    stubPromote(
      promoteAnswer({
        queuedBrowsers: ["chrome", "firefox"],
        notarization: { ok: false, started: [], pending: ["safari"] },
      }),
    );
    const out = await promote();

    expect(out.status).toBe("promoted");
    expect(out.warnings.join(" ")).toContain("still pending for safari");
  });
});
