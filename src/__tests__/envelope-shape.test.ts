import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { tools as ALL_TOOLS } from "../index";
import { ERROR_CODES, envelopeObject } from "../lib/envelope";
import { validateAgainstSchema } from "./envelope-validate";

const here = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.resolve(here, "..");
const schema = JSON.parse(
  fs.readFileSync(path.join(here, "contract", "envelope.schema.json"), "utf8"),
);

const registered = new Set(ALL_TOOLS.map((t) => t.schema.name));

const walk = (dir: string): string[] => {
  const out: string[] = [];

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.name.endsWith(".ts")) out.push(full);
  }

  return out;
};

const sources = [
  ...walk(path.join(srcDir, "tools")),
  ...walk(path.join(srcDir, "lib")),
  path.join(srcDir, "index.ts"),
].map((file) => ({
  relative: path.relative(srcDir, file).split(path.sep).join("/"),
  text: fs.readFileSync(file, "utf8"),
}));

const RAW_SERIALIZER_ALLOWED = new Map<string, string>([
  ["lib/envelope.ts", "it is the serializer itself"],
  [
    "lib/act.ts",
    "owns the wire form of an act frame: a tool that annotated the CLI's own frame hands it back through actFrameJson, so no tool hand-builds one",
  ],
  [
    "lib/hosted-forwarder.ts",
    "relays the envelope the hosted lane's own envelope() built, byte for byte, so the forwarded answer is the in-process answer; anything the lane sends that is not an envelope goes through envelope()",
  ],
]);

describe("envelope() and envelopeObject() are the only serializers allowed to produce a handler's return value", () => {
  for (const { relative, text } of sources) {
    if (RAW_SERIALIZER_ALLOWED.has(relative)) continue;

    it(`${relative} returns no hand-built frame`, () => {
      const hits = [...text.matchAll(/return JSON\.stringify\(/g)];
      expect(
        hits.length,
        `${relative} returns a hand-built JSON frame. Use envelope() from src/lib/envelope.ts.`,
      ).toBe(0);
    });
  }

  for (const [relative, why] of RAW_SERIALIZER_ALLOWED) {
    it(`${relative} may hand-serialize because ${why}`, () => {
      expect(
        sources.some((s) => s.relative === relative),
        `${relative} is allowlisted but no longer exists`,
      ).toBe(true);
    });
  }

  it("names only registered tools in `command`", () => {
    const named = new Set<string>();

    for (const { text } of sources) {
      for (const match of text.matchAll(/command:\s*"(extension_[a-z_]+)"/g)) {
        named.add(match[1]);
      }
    }

    expect(named.size).toBeGreaterThan(0);

    for (const name of named) {
      expect(registered, `${name} is not a registered tool`).toContain(name);
    }
  });

  it("uses only declared error codes", () => {
    const declared = new Set<string>(ERROR_CODES);

    for (const { relative, text } of sources) {
      if (relative === "lib/envelope.ts") continue;

      for (const match of text.matchAll(/code:\s*"(E_[A-Z0-9_]+)"/g)) {
        expect(
          declared,
          `${relative} emits ${match[1]}, which is not in the ErrorCode union`,
        ).toContain(match[1]);
      }
    }
  });

  it("builds a frame the copied CLI schema accepts, for every tool name", () => {
    for (const tool of ALL_TOOLS) {
      const okFrame = envelopeObject({
        ok: true,
        command: tool.schema.name,
        status: "done",
        value: {},
      });
      const failFrame = envelopeObject({
        ok: false,
        command: tool.schema.name,
        status: "failed",
        error: { code: "E_INTERNAL", message: "x" },
      });
      expect(validateAgainstSchema(okFrame, schema)).toEqual([]);
      expect(validateAgainstSchema(failFrame, schema)).toEqual([]);
    }
  });
});

describe("513: every failed frame says in error.retry whether repeating the call is safe", () => {
  const failed = (command: string, error: { code: string; retry?: "safe" | "after-read" | "no"; platformCode?: string }) =>
    envelopeObject({ ok: false, command, status: "failed", error: { code: error.code, message: "x", ...(error.retry ? { retry: error.retry } : {}), ...(error.platformCode ? { platformCode: error.platformCode } : {}) } }).error as Record<string, unknown>;

  it("answers one of safe, after-read and no for every declared code, on a read and on an act", () => {
    for (const code of ERROR_CODES) {
      for (const command of ["extension_templates", "extension_publish"]) {
        expect(["safe", "after-read", "no"], `${code} on ${command}`).toContain(failed(command, { code }).retry);
      }
    }
  });

  it("a transient failure is safe on a read, after-read on an act, and safe on an act whose repeat changes nothing", () => {
    expect(failed("extension_templates", { code: "E_NETWORK" }).retry).toBe("safe");
    expect(failed("extension_publish", { code: "E_NETWORK" }).retry).toBe("after-read");
    expect(failed("extension_screenshot", { code: "E_CDP" }).retry).toBe("safe");
    expect(failed("extension_eval", { code: "E_WAIT_TIMEOUT" }).retry).toBe("after-read");
    expect(validateAgainstSchema(envelopeObject({ ok: false, command: "extension_publish", status: "failed", error: { code: "E_NETWORK", message: "x" } }), schema)).toEqual([]);
  });

  it("a refusal that waits on a change is no, whether the tool reads or acts, and so is a code the table does not know", () => {
    expect(failed("extension_templates", { code: "E_BAD_REQUEST" }).retry).toBe("no");
    expect(failed("extension_eval", { code: "E_NO_SESSION" }).retry).toBe("no");
    expect(failed("extension_submit", { code: "E_APPROVAL_REQUIRED" }).retry).toBe("no");
    expect(failed("extension_builds", { code: "E_TOOL_DISABLED" }).retry).toBe("no");
    expect(failed("extension_act", { code: "E_CONTROL_DENIED" }).retry).toBe("no");
    expect(failed("extension_publish", { code: "E_PLATFORM", platformCode: "CHANNEL_NOT_FOUND" }).retry).toBe("no");
    expect(failed("extension_publish", { code: "E_PLATFORM" }).retry).toBe("after-read");
  });

  it("keeps a builder's own verdict, reads a refunded approval as safe, and puts nothing on a success", () => {
    expect(failed("extension_templates", { code: "E_BAD_REQUEST", retry: "after-read" }).retry).toBe("after-read");
    const refunded = envelopeObject({ ok: false, command: "extension_submit", status: "platform-unavailable", value: { approvalRefunded: true }, error: { code: "E_PLATFORM", message: "x" } });
    expect(refunded.error?.retry).toBe("safe");
    expect(envelopeObject({ ok: true, command: "extension_templates", status: "ok", value: {} }).error).toBeNull();
  });
});
