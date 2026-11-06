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

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { writeCredentials } from "../lib/credentials";
import { createToolDispatcher, type ToolModule } from "../lib/tool-dispatch";
import * as releaseStatus from "../tools/release-status";

const READ_AT = "2026-11-06T12:40:00.000Z";

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    headers: { get: () => null },
    text: async () => JSON.stringify(body),
    json: async () => body,
  } as unknown as Response;
}

function serve(): typeof fetch {
  return (async (url: string) => {
    const at = String(url);

    if (at.endsWith("stores/health.json")) {
      const healthy = { ok: true, message: "ok", checkedAt: READ_AT };

      return jsonResponse({ updatedAt: READ_AT, stores: { chrome: healthy, firefox: healthy, edge: healthy, safari: healthy } });
    }

    return jsonResponse({ message: "not found" }, false, 404);
  }) as unknown as typeof fetch;
}

async function call(args: Record<string, unknown>) {
  const dispatch = createToolDispatcher({
    tools: [releaseStatus] as unknown as ToolModule[],
    options: { features: ["local", "platform"], noShip: false },
  });
  const frame = await dispatch({ name: "extension_release_status", arguments: args });

  return JSON.parse(frame.content[0]?.text ?? "{}");
}

describe("extension_release_status include stores answers only the store named (ledger 443, seen again)", () => {
  let tmp: string;
  let prevXdg: string | undefined;
  let prevFetch: typeof fetch;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "extdev-release-status-store-"));
    prevXdg = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = tmp;
    prevFetch = global.fetch;
    global.fetch = serve();
    writeCredentials({
      version: 1,
      token: "claims.sig",
      workspaceSlug: "cezaraugusto",
      projectSlug: "rebeccat",
      projectId: "prj_1",
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      api: "https://www.extension.dev",
    });
  });

  afterEach(() => {
    if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prevXdg;

    global.fetch = prevFetch;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("answers the firefox row alone when store names firefox", async () => {
    if (process.platform === "win32") return;

    const all = await call({ include: ["stores"], project: "cezaraugusto/rebeccat" });
    const one = await call({ include: ["stores"], project: "cezaraugusto/rebeccat", store: "firefox" });

    expect(all.value.stores.value.stores.map((row: { store: string }) => row.store)).toEqual(["chrome", "firefox", "edge", "safari"]);
    expect(one.ok).toBe(true);
    expect(one.value.stores.value.stores.map((row: { store: string }) => row.store)).toEqual(["firefox"]);
    expect(one.value.stores.hint).not.toMatch(/\b(chrome|edge|safari)\b:/);
  });

  it("refuses a store it does not know before reading anything", async () => {
    const out = await call({ include: ["stores"], project: "cezaraugusto/rebeccat", store: "opera" });

    expect(out.status).toBe("invalid-arguments");
    expect(out.error.message).toContain("store: must be one of: chrome, firefox, edge, safari");
  });
});
