import fs from "node:fs";
import os from "node:os";
import path from "node:path";


import { describe, it, expect, vi, beforeEach } from "vitest";

import { envelope } from "../lib/envelope";

import type * as ActModule from "../lib/act";

const act = vi.hoisted(() => ({
  calls: [] as string[][],
  stored: {} as Record<string, unknown>,
  getFails: false,
}));
vi.mock("../lib/act", async (importOriginal) => {
  const actual = await importOriginal<typeof ActModule>();

  return {
    ...actual,
    runActVerb: async (cli: string[]) => {
      act.calls.push(cli);
      const key = cli[cli.indexOf("--key") + 1];

      if (cli[1] === "set") {
        return envelope({ ok: true, command: "extension_storage", status: "ok", value: { set: [key] } });
      }

      if (act.getFails) {
        return envelope({ ok: false, command: "extension_storage", status: "failed", error: { code: "E_CONTROL_CHANNEL", name: "StorageError", message: "storage.local unavailable" } });
      }

      return envelope({ ok: true, command: "extension_storage", status: "ok", value: key in act.stored ? { [key]: act.stored[key] } : {} });
    },
  };
});

vi.mock("../lib/session-browser", () => ({ resolveSessionBrowser: () => ({ browser: "chrome" }) }));

const storage = await import("../tools/storage");

beforeEach(() => {
  act.calls.length = 0;
  act.stored = {};
  act.getFails = false;
});

describe("extension_storage reads a set back before calling it set", () => {
  it("offers no context, since the engine honours none", () => {
    expect((storage.schema.inputSchema.properties as Record<string, unknown>).context).toBeUndefined();
    expect(storage.schema.description).toMatch(/background/);
  });

  it("reads a set back and says it matches", async () => {
    act.stored = { theme: "dark" };
    const out = JSON.parse(await storage.handler({ projectPath: "/p", action: "set", key: "theme", value: "dark" }));
    expect(out.ok).toBe(true);
    expect(out.status).toBe("set");
    expect(out.value.readBack).toEqual({ key: "theme", value: "dark", present: true, matches: true });
    expect(act.calls.map((c) => c[1])).toEqual(["set", "get"]);
  });

  it("does not call a set set when the read-back differs", async () => {
    act.stored = { theme: "light" };
    const out = JSON.parse(await storage.handler({ projectPath: "/p", action: "set", key: "theme", value: "dark" }));
    expect(out.ok).toBe(false);
    expect(out.status).toBe("set-unconfirmed");
    expect(out.error.message).toMatch(/answered "light", not the value sent/);
  });

  it("does not call a set set when the key is absent afterwards or the read-back failed", async () => {
    const absent = JSON.parse(await storage.handler({ projectPath: "/p", action: "set", key: "theme", value: "dark" }));
    expect(absent.status).toBe("set-unconfirmed");
    expect(absent.error.message).toMatch(/no such key/);
    act.getFails = true;
    const failed = JSON.parse(await storage.handler({ projectPath: "/p", action: "set", key: "theme", value: "dark" }));
    expect(failed.status).toBe("set-unconfirmed");
    expect(failed.value.readBack.unreadable).toMatch(/storage.local unavailable/);
  });

  it("names a passed context as not honoured and never forwards it", async () => {
    act.stored = { k: 1 };
    const out = JSON.parse(await storage.handler({ projectPath: "/p", action: "get", key: "k", context: "content" } as never));
    expect(out.warnings.join("\n")).toMatch(/context: "content" is not honoured/);
    expect(act.calls[0]).not.toContain("--context");
  });
});

describe("extension_storage says when the source manifest does not declare storage", () => {
  function projectWith(manifest: Record<string, unknown>): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-storage-perm-"));
    fs.mkdirSync(path.join(dir, "src"));
    fs.writeFileSync(path.join(dir, "src", "manifest.json"), JSON.stringify(manifest));

    return dir;
  }

  it("warns and marks manifestDeclaresStorage false when the permission is missing", async () => {
    act.stored = { theme: "dark" };
    const dir = projectWith({ manifest_version: 3, permissions: ["tabs"] });
    const out = JSON.parse(await storage.handler({ projectPath: dir, action: "set", key: "theme", value: "dark" }));
    expect(out.ok).toBe(true);
    expect(out.value.manifestDeclaresStorage).toBe(false);
    expect(out.warnings.join(" ")).toMatch(/src\/manifest\.json does not declare the "storage" permission/);
  });

  it("stays quiet when the manifest declares storage, including a browser-prefixed list", async () => {
    act.stored = { theme: "dark" };
    const dir = projectWith({ manifest_version: 3, "chromium:permissions": ["storage"] });
    const out = JSON.parse(await storage.handler({ projectPath: dir, action: "set", key: "theme", value: "dark" }));
    expect(out.value.manifestDeclaresStorage).toBeUndefined();
    expect((out.warnings ?? []).join(" ")).not.toMatch(/does not declare/);
  });
});
