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
  writeThrough: false,
}));
vi.mock("../lib/act", async (importOriginal) => {
  const actual = await importOriginal<typeof ActModule>();

  return {
    ...actual,
    runActVerb: async (cli: string[]) => {
      act.calls.push(cli);
      const key = cli[cli.indexOf("--key") + 1];

      if (cli[1] === "set") {
        if (act.writeThrough) act.stored[key!] = JSON.parse(cli[cli.indexOf("--value") + 1]!);

        return envelope({ ok: true, command: "extension_storage", status: "ok", value: { set: [key] } });
      }

      if (act.getFails) {
        return envelope({ ok: false, command: "extension_storage", status: "failed", error: { code: "E_CONTROL_CHANNEL", name: "StorageError", message: "storage.local unavailable" } });
      }

      return envelope({ ok: true, command: "extension_storage", status: "ok", value: key in act.stored ? { [key]: act.stored[key] } : {} });
    },
  };
});

vi.mock("../lib/session-browser", () => ({
  ambiguousSessionRefusal: () => null,
  resolveSessionBrowser: () => ({ browser: "chrome" }),
}));

const storage = await import("../tools/storage");

beforeEach(() => {
  act.calls.length = 0;
  act.stored = {};
  act.getFails = false;
  act.writeThrough = false;
  vi.stubGlobal("fetch", () => {
    throw new Error("extension_storage specs never reach the network");
  });
});

describe("extension_storage reads a set back before calling it set", () => {
  it("offers no context, since the engine honors none", () => {
    expect((storage.schema.inputSchema.properties as Record<string, unknown>).context).toBeUndefined();
    expect(storage.schema.description).toMatch(/background/);
  });

  it("reads a set back and says it matches", async () => {
    act.stored = { theme: "dark" };
    const out = JSON.parse(await storage.handler({ projectPath: "/p", action: "set", key: "theme", value: "dark" }));
    expect(out.ok).toBe(true);
    expect(out.status).toBe("set");
    expect(out.value.readBack).toEqual({ key: "theme", value: "dark", present: true, type: "string", sentType: "string", matches: true });
    expect(act.calls.map((c) => c[1])).toEqual(["set", "get"]);
  });

  it("does not call a set set when the read-back differs", async () => {
    act.stored = { theme: "light" };
    const out = JSON.parse(await storage.handler({ projectPath: "/p", action: "set", key: "theme", value: "dark" }));
    expect(out.ok).toBe(false);
    expect(out.status).toBe("set-unconfirmed");
    expect(out.error.message).toMatch(/answered "light" \(string\), not the value sent \("dark", string\)/);
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

  it("names a passed context as not honored and never forwards it", async () => {
    act.stored = { k: 1 };
    const out = JSON.parse(await storage.handler({ projectPath: "/p", action: "get", key: "k", context: "content" } as never));
    expect(out.warnings.join("\n")).toMatch(/context: "content" is not honored/);
    expect(act.calls[0]).not.toContain("--context");
  });
});

describe("extension_storage keeps every JSON value's type from the call to the store and back", () => {
  const sentValue = (cli: string[]) => cli[cli.indexOf("--value") + 1];

  it.each([
    ["null", null, "null"],
    ["an empty string", "", "string"],
    ["zero", 0, "number"],
    ["false", false, "boolean"],
    ["a nested object", { a: { b: [1, null, ""] }, c: false }, "object"],
    ["an array", [0, "", null, { x: [] }], "array"],
  ] as const)("round-trips %s sent as value, and the read-back names its type", async (_label, value, type) => {
    act.writeThrough = true;
    const out = JSON.parse(await storage.handler({ projectPath: "/p", action: "set", key: "k", value }));

    expect(out.ok).toBe(true);
    expect(out.status).toBe("set");
    expect(JSON.parse(sentValue(act.calls[0]!)!)).toEqual(value);
    expect(out.value.readBack).toEqual({ key: "k", value, present: true, type, sentType: type, matches: true });
  });

  it.each([
    ["null", "null", null],
    ["an empty string", '""', ""],
    ["zero", "0", 0],
    ["false", "false", false],
    ["a nested object", '{"a":{"b":[1,null,""]},"c":false}', { a: { b: [1, null, ""] }, c: false }],
    ["an array", '[0,"",null]', [0, "", null]],
  ] as const)("parses valueJson for %s into its own type before the engine sees it", async (_label, valueJson, value) => {
    act.writeThrough = true;
    const out = JSON.parse(await storage.handler({ projectPath: "/p", action: "set", key: "k", valueJson }));

    expect(out.status).toBe("set");
    expect(act.stored.k).toEqual(value);
    expect(out.value.readBack.matches).toBe(true);
    expect(out.value.readBack.value).toEqual(value);
  });

  it("refuses null and an empty string that arrived as their JSON text, the Rebeccat walk's two values, and never writes them", async () => {
    act.writeThrough = true;

    for (const value of ["null", '""']) {
      const out = JSON.parse(await storage.handler({ projectPath: "/p", action: "set", key: "rebeccatLicense", value }));

      expect(out.ok).toBe(false);
      expect(out.error.code).toBe("E_BAD_REQUEST");
      expect(out.error.message).toContain(`valueJson: ${JSON.stringify(value)}`);
    }

    expect(act.calls).toEqual([]);
    expect(act.stored).toEqual({});
  });

  it("reads matches:false when the store answers the text of a value instead of the value, and names both types", async () => {
    act.stored = { k: "null" };
    const nulled = JSON.parse(await storage.handler({ projectPath: "/p", action: "set", key: "k", value: null }));

    expect(nulled.status).toBe("set-unconfirmed");
    expect(nulled.value.readBack).toMatchObject({ value: "null", type: "string", sentType: "null", matches: false });
    expect(nulled.error.message).toContain('answered "null" (string), not the value sent (null, null)');

    act.stored = { k: "0" };
    const zero = JSON.parse(await storage.handler({ projectPath: "/p", action: "set", key: "k", value: 0 }));
    expect(zero.value.readBack).toMatchObject({ type: "string", sentType: "number", matches: false });

    act.stored = { k: { a: 1, b: [2] } };
    const reordered = JSON.parse(await storage.handler({ projectPath: "/p", action: "set", key: "k", value: { b: [2], a: 1 } }));
    expect(reordered.value.readBack.matches).toBe(true);

    act.stored = { k: [1, 2] };
    const shorter = JSON.parse(await storage.handler({ projectPath: "/p", action: "set", key: "k", value: [1, 2, 3] }));
    expect(shorter.value.readBack.matches).toBe(false);
  });

  it("stores a string that reads as JSON as the string it is, and says how to send the typed value", async () => {
    act.writeThrough = true;
    const out = JSON.parse(await storage.handler({ projectPath: "/p", action: "set", key: "k", value: "false" }));

    expect(out.status).toBe("set");
    expect(act.stored.k).toBe("false");
    expect(out.value.readBack).toMatchObject({ type: "string", sentType: "string", matches: true });
    expect(out.warnings.join(" ")).toContain('valueJson: "false"');
  });

  it("refuses value and valueJson together, and valueJson that is not JSON", async () => {
    const both = JSON.parse(await storage.handler({ projectPath: "/p", action: "set", key: "k", value: 1, valueJson: "1" }));
    expect(both.error.message).toMatch(/not both/);

    const broken = JSON.parse(await storage.handler({ projectPath: "/p", action: "set", key: "k", valueJson: "{a:1}" }));
    expect(broken.error.message).toMatch(/valueJson is not JSON text/);
    expect(act.calls).toEqual([]);
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
