import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { handler } from "../tools/manifest-validate";

describe("extension_manifest_validate: content_scripts world MAIN on firefox", () => {
  let tmp: string;
  let prevFetch: typeof fetch;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "extdev-manifest-world-"));
    prevFetch = global.fetch;
    global.fetch = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    fs.writeFileSync(path.join(tmp, "content.js"), "console.log('hi');\n");
    fs.writeFileSync(
      path.join(tmp, "manifest.json"),
      JSON.stringify({
        name: "world-main",
        version: "1.0.0",
        manifest_version: 3,
        content_scripts: [
          {
            matches: ["<all_urls>"],
            js: ["content.js"],
            world: "MAIN",
          },
        ],
      }),
    );
  });

  afterEach(() => {
    global.fetch = prevFetch;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("validates for firefox instead of raising a build-blocking error", async () => {
    const out = JSON.parse(
      await handler({ projectPath: tmp, browsers: ["firefox"] }),
    );
    expect(out.ok).toBe(true);
    expect(out.value.valid).toBe(true);
    expect(out.value.buildBlocking).toBe(false);
    expect(out.value.browserSupport.firefox.supported).toBe(true);
    expect(out.value.browserSupport.firefox.issues).toEqual([]);
  });

  it("keeps the version nuance as an advisory note, once", async () => {
    const out = JSON.parse(
      await handler({ projectPath: tmp, browsers: ["firefox", "waterfox"] }),
    );
    const notes = out.value.warnings.filter((w: string) =>
      w.includes("Firefox 128"),
    );
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("strict_min_version");
    expect(out.value.errors).toEqual([]);
  });
});
