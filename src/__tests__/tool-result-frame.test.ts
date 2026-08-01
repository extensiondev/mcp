import { describe, expect, it } from "vitest";

import { toolResultFrame } from "../index";
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
