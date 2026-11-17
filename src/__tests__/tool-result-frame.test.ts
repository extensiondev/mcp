import { describe, expect, it } from "vitest";

import { toolResultFrame } from "../index";
import { refusedFrame } from "../lib/tool-frames";
import { envelope } from "../lib/envelope";

describe("toolResultFrame maps the envelope verdict onto the transport flag", () => {
  it("marks a refusing envelope (ok:false) as isError", () => {
    const text = envelope({
      ok: false,
      command: "extension_publish",
      status: "publish-failed",
      error: {
        code: "E_PLATFORM",
        name: "PublishError",
        message: "publish failed (404): Project not found",
      },
    });

    const frame = toolResultFrame(text);

    expect(frame.isError).toBe(true);
    expect(frame.content[0].text).toBe(text);
  });

  it("leaves a succeeding envelope (ok:true) unflagged", () => {
    const text = envelope({
      ok: true,
      command: "extension_templates",
      status: "listed",
      value: { count: 52 },
    });

    const frame = toolResultFrame(text);

    expect(frame.isError).toBeUndefined();
  });

  it("never flags a non-envelope payload", () => {
    expect(toolResultFrame("plain text").isError).toBeUndefined();
    expect(toolResultFrame('{"ok":false}').isError).toBeUndefined();
  });
});

describe("912: no refusal leaves the dispatcher's frames without error.code and error.hint", () => {
  const bare = JSON.stringify({ schema: 1, ok: false, command: "extension_storage", status: "failed", value: null, error: { code: "E_CONTROL_UNAVAILABLE", message: "no executor connected" }, warnings: [] });
  const errorless = JSON.stringify({ schema: 1, ok: false, command: "extension_stop", status: "not-found", value: null, error: null, warnings: [] });

  it.each([
    ["toolResultFrame", (text: string) => toolResultFrame(text)],
    ["refusedFrame", (text: string) => refusedFrame(text)],
    ["toolResultFrame for an untrusted tool", (text: string) => toolResultFrame(text, true)],
  ])("%s completes a failure a raw serializer wrote", (_label, frameOf) => {
    for (const [text, code] of [[bare, "E_CONTROL_UNAVAILABLE"], [errorless, "E_UNSPECIFIED"]] as const) {
      const frame = frameOf(text);
      const out = JSON.parse(frame.content[0]!.text);

      expect(frame.isError).toBe(true);
      expect(out.error.code).toBe(code);
      expect(out.error.hint.length).toBeGreaterThan(40);
      expect(out.error.hint).toMatch(/extension_(wait|doctor)/);
    }
  });
});
