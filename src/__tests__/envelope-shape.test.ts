import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { tools as ALL_TOOLS } from "../index";
import { ERROR_CODES, envelope, envelopeObject, hintedAnswer, reframed, type EnvelopeInit } from "../lib/envelope";
import { ENGINE_CODE_HINT, REFUSAL_HINTS, REFUSAL_MESSAGES, defaultRefusalHint } from "../lib/refusal-hints";
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

describe("922: a session that is still starting has a refusal of its own", () => {
  it("is declared, safe to repeat on a read and on an act, and its floor hint sends to extension_wait and never to a new session", () => {
    const refused = (command: string) => envelopeObject({ ok: false, command, status: "starting", error: { code: "E_SESSION_STARTING", message: "x" } }).error;

    expect(ERROR_CODES).toContain("E_SESSION_STARTING");
    expect(refused("extension_dom_snapshot")).toEqual({
      code: "E_SESSION_STARTING",
      message: "x",
      retry: "safe",
      hint: "The dev session exists and is still starting. Call extension_wait, then call extension_dom_snapshot again; do not start or replace the session.",
    });

    expect(refused("extension_reload")?.retry).toBe("safe");
    expect(REFUSAL_HINTS.E_SESSION_STARTING).not.toMatch(/extension_dev|replace: true/);
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
    expect(failed("extension_stop", { code: "E_STOP_INCOMPLETE" }).retry).toBe("safe");
    expect(failed("extension_try", { code: "E_STOP_INCOMPLETE" }).retry).toBe("after-read");
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

describe("912: every refusal carries error.code and a non-empty error.hint that names the next step", () => {
  const quoted = new Set<string>();

  for (const { text } of sources) {
    for (const match of text.matchAll(/["'`](E_[A-Z0-9]+(?:_[A-Z0-9]+)+)["'`]/g)) quoted.add(match[1]);
  }

  it("holds one line of its own for every code in the union and for every code the source spells out", () => {
    expect(Object.keys(REFUSAL_HINTS).sort()).toEqual([...ERROR_CODES].sort());
    expect(quoted.size).toBeGreaterThan(90);

    for (const code of quoted) {
      expect(Object.keys(REFUSAL_HINTS), `${code} is spelled out in src and has no line in REFUSAL_HINTS (add it to the ErrorCode union)`).toContain(code);
    }
  });

  it("builds a failure frame with a usable hint for every code, with no hint given by the call site", () => {
    for (const code of new Set([...ERROR_CODES, ...quoted])) {
      const error = envelopeObject({ ok: false, command: "extension_dev", status: "failed", error: { code, message: "x" } }).error;
      const hint = error?.hint ?? "";

      expect(error?.code, code).toBe(code);
      expect(hint.trim().length, `${code} has a hint too short to act on: ${JSON.stringify(hint)}`).toBeGreaterThanOrEqual(40);
      expect(hint.length, `${code} has a hint of ${hint.length} characters; it is paid on every refusal`).toBeLessThanOrEqual(200);
      expect(hint, `${code} leaves a placeholder in its hint`).not.toMatch(/[{}]/);
      expect(hint, `${code} answers with the line kept for codes this server does not know`).not.toBe(ENGINE_CODE_HINT);
      expect(hint, `${code} tells the reader to check something and names nothing`).not.toMatch(/check (the|your) (arguments|input)|try again later\.?$/i);
    }
  });

  it("names only registered tools, and puts the answering tool where a line says to call again", () => {
    for (const [code, line] of Object.entries(REFUSAL_HINTS)) {
      for (const [name] of line.matchAll(/\bextension_[a-z_]+/g)) {
        expect(registered, `${code} sends the reader to ${name}, which is not a registered tool`).toContain(name);
      }
    }

    expect(defaultRefusalHint("E_BAD_REQUEST", "extension_open")).toBe("Nothing ran. Change the argument error.message names and call extension_open again.");
  });

  it("918: a failed submit preflight and an unavailable release status each have a code, a message and a hint of their own", () => {
    const preflight = envelopeObject({ ok: false, command: "extension_submit", status: "preflight-failed", error: { code: "E_PREFLIGHT_FAILED", message: REFUSAL_MESSAGES.E_PREFLIGHT_FAILED } }).error;
    const status = envelopeObject({ ok: false, command: "extension_release_status", status: "status-unavailable", error: { code: "E_STATUS_UNAVAILABLE", message: REFUSAL_MESSAGES.E_STATUS_UNAVAILABLE } }).error;

    expect(ERROR_CODES).toEqual(expect.arrayContaining(["E_PREFLIGHT_FAILED", "E_STATUS_UNAVAILABLE"]));
    expect(preflight).toEqual({
      code: "E_PREFLIGHT_FAILED",
      message: "The submit preflight failed, so nothing was sent to a store.",
      retry: "no",
      hint: "Nothing was sent. Fix each failing check this answer lists, then call extension_submit again.",
    });

    expect(status).toEqual({
      code: "E_STATUS_UNAVAILABLE",
      message: "The release status could not be read right now.",
      retry: "safe",
      hint: "Nothing changed and the release is as it was. Call extension_release_status again in about a minute with the same arguments.",
    });

    expect(defaultRefusalHint("E_PREFLIGHT_FAILED", "extension_submit_check")).toContain("call extension_submit_check again");
  });

  it("979: a Safari target not found points at a step Safari can follow, never at listTargets", () => {
    const recorded = {
      ok: false,
      command: "extension_inspect",
      status: "not-found",
      error: {
        name: "TargetNotFound",
        message: "the expression never executed in tab 354: no injectable frame returned a result (restricted page, or outside host_permissions)",
        engine: "webkit",
        code: "E_TARGET_NOT_FOUND",
      },
    } as const;
    const safari = envelopeObject(recorded).error;
    const chromium = envelopeObject({ ...recorded, error: { ...recorded.error, engine: "chromium" } }).error;

    expect(safari?.hint).not.toContain("listTargets");
    expect(safari?.hint).toContain("listTabs: true");
    expect(safari?.hint).toContain("extension_open url");
    expect(chromium?.hint).toBe(REFUSAL_HINTS.E_TARGET_NOT_FOUND);
  });

  it("answers a code this server has never seen with the engine's line, which still names a tool", () => {
    const error = envelopeObject({ ok: false, command: "extension_dev", status: "failed", error: { code: "E_FROM_A_NEWER_ENGINE", message: "x" } }).error;

    expect(error?.hint).toBe(ENGINE_CODE_HINT);
    expect(ENGINE_CODE_HINT).toContain("extension_doctor");
  });

  it("keeps the call site's own hint, then the frame's hint, before the code's line", () => {
    const own = envelopeObject({ ok: false, command: "extension_dev", status: "failed", error: { code: "E_NO_SESSION", message: "x", hint: "Site hint." }, hint: "Frame hint." });
    const framed = envelopeObject({ ok: false, command: "extension_dev", status: "failed", error: { code: "E_NO_SESSION", message: "x" }, hint: "Frame hint." });
    const blank = envelopeObject({ ok: false, command: "extension_dev", status: "failed", error: { code: "E_NO_SESSION", message: "x", hint: "  " } });

    expect(own.error?.hint).toBe("Site hint.");
    expect(own.hint).toBe("Frame hint.");
    expect(framed.error?.hint).toBe("Frame hint.");
    expect(blank.error?.hint).toBe(REFUSAL_HINTS.E_NO_SESSION);
    expect(envelopeObject({ ok: true, command: "extension_dev", status: "ready", value: {} }).error).toBeNull();
  });

  it("does not compile a failure with no error, and completes one that reaches the serializer untyped", () => {
    // @ts-expect-error a failure takes an error
    const untyped: EnvelopeInit = { ok: false, command: "extension_stop", status: "not-found" };
    // @ts-expect-error a failure takes an error, not null
    const nulled: EnvelopeInit = { ok: false, command: "extension_stop", status: "not-found", error: null };

    for (const init of [untyped, nulled]) {
      const error = envelopeObject(init).error;

      expect(error?.code).toBe("E_UNSPECIFIED");
      expect(error?.message).toBe("extension_stop answered not-found and named no error.");
      expect(error?.hint).toBe(REFUSAL_HINTS.E_UNSPECIFIED);
      expect(error?.retry).toBe("no");
    }

    expect(JSON.parse(reframed({ ok: false, command: "extension_doctor", status: "unhealthy", error: null })).error.code).toBe("E_UNSPECIFIED");
  });

  it("completes a failure another program serialized, and hands back a complete one as the same string", () => {
    const fromEngine = JSON.stringify({ schema: 1, ok: false, command: "extension_eval", status: "failed", value: null, error: { code: "E_SESSION_NOT_FOUND", message: "no session" }, warnings: [] });
    const withNull = JSON.stringify({ schema: 1, ok: false, command: "extension_stop", status: "not-found", value: null, error: null, warnings: [] });
    const complete = envelope({ ok: false, command: "extension_eval", status: "failed", error: { code: "E_EVAL", message: "x" } });
    const fine = envelope({ ok: true, command: "extension_eval", status: "ok", value: { nested: '"ok":false' } });

    expect(JSON.parse(hintedAnswer(fromEngine)).error).toEqual({ code: "E_SESSION_NOT_FOUND", message: "no session", retry: "no", hint: REFUSAL_HINTS.E_SESSION_NOT_FOUND });
    expect(JSON.parse(hintedAnswer(withNull)).error.code).toBe("E_UNSPECIFIED");
    expect(hintedAnswer(complete)).toBe(complete);
    expect(hintedAnswer(fine)).toBe(fine);
    expect(hintedAnswer("not json")).toBe("not json");
    expect(validateAgainstSchema(JSON.parse(hintedAnswer(fromEngine)), schema)).toEqual([]);
  });
});
