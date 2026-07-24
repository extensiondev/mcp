import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { handler, schema } from "../tools/theme-verify";

const tmp: string[] = [];
afterEach(() => {
  for (const f of tmp.splice(0)) fs.rmSync(f, { force: true });
});

function verify(input: Record<string, unknown>) {
  return handler(input as never).then((s) => JSON.parse(s));
}

const CLEAN = {
  name: "Clean",
  version: "1.0",
  theme: { colors: { frame: [30, 60, 90], toolbar: [240, 240, 240] } },
};

describe("schema", () => {
  it("is a well-formed, theme-namespaced tool schema", () => {
    expect(schema.name).toBe("extension_theme_verify");
    expect(schema.inputSchema.type).toBe("object");
    expect(schema.description.length).toBeGreaterThan(10);
  });
});

describe("happy path is honest about what it did NOT verify", () => {
  it("returns headless-clean but still flags the two attended legs", async () => {
    const r = await verify({ manifest: CLEAN });

    expect(r.ok).toBe(true);
    expect(r.verdict).toBe("headless-clean");
    expect(r.needsAttended).toBe(true);
    expect(r.legs.appShows.status).toBe("needs-attended");
    expect(r.legs.chromePaints.realPaint.status).toBe("needs-attended");
    expect(r.legs.chromeAccepts.live.status).toBe("needs-attended");
    expect(JSON.stringify(r.attended)).toMatch(/assert:theme/);
    expect(JSON.stringify(r.attended)).toMatch(/install-parity/);
  });

  it("derives the paint colors as the headless resolver proxy for leg [3]", async () => {
    const r = await verify({ manifest: CLEAN });
    const resolved = r.legs.chromePaints.resolver.resolved;
    expect(r.legs.chromePaints.resolver.status).toBe("reported");
    expect(typeof resolved.frameActive).toBe("string");
    expect(resolved.frameActive).toMatch(/^#[0-9a-f]{6}$/);
    expect(resolved.frameActive).toBe("#1e3c5a");
  });

  it("reports the declared manifest surface for leg [2]", async () => {
    const r = await verify({ manifest: CLEAN });
    expect(r.legs.manifestSays.status).toBe("verified");
    expect(r.legs.manifestSays.declared.colors).toEqual(["frame", "toolbar"]);
  });
});

describe("leg [2] grammar: an uninstallable manifest is invalid, not clean", () => {
  it("rejects a version Chrome cannot load", async () => {
    const r = await verify({
      manifest: { name: "X", version: "v1", theme: { colors: {} } },
    });
    expect(r.verdict).toBe("invalid");
    expect(r.legs.manifestSays.grammar.versionValid).toBe(false);
    expect(r.summary.errors).toBeGreaterThan(0);
    expect(JSON.stringify(r.legs.manifestSays.grammar.errors)).toContain("v1");
  });

  it("rejects an empty name", async () => {
    const r = await verify({
      manifest: { name: "  ", version: "1.0", theme: { colors: {} } },
    });
    expect(r.verdict).toBe("invalid");
    expect(r.legs.manifestSays.grammar.nameValid).toBe(false);
  });
});

describe("leg [4] D4 acceptance gap: keys Chrome silently discards", () => {
  it("flags a dead legacy color key instead of reporting clean", async () => {
    const r = await verify({
      manifest: {
        ...CLEAN,
        theme: { colors: { frame: [30, 60, 90], tab_text_inactive: [1, 2, 3] } },
      },
    });
    expect(r.verdict).toBe("diverged");
    const d4 = r.findings.filter((f: { class: string }) => f.class === "D4");
    expect(d4.some((f: { key: string }) => f.key === "colors.tab_text_inactive")).toBe(
      true,
    );
    expect(
      JSON.stringify(r.legs.chromeAccepts.discarded),
    ).toContain("tab_text_inactive");
  });

  it("flags an incognito color key as parsed-but-never-rendered", async () => {
    const r = await verify({
      manifest: {
        ...CLEAN,
        theme: { colors: { frame: [1, 1, 1], frame_incognito: [2, 2, 2] } },
      },
    });
    const finding = r.findings.find(
      (f: { key?: string }) => f.key === "colors.frame_incognito",
    );
    expect(finding.class).toBe("D4");
    expect(finding.detail).toMatch(/incognito/i);
  });

  it("flags a color value out of Chrome's byte range", async () => {
    const r = await verify({
      manifest: { ...CLEAN, theme: { colors: { frame: [300, 0, 0] } } },
    });
    expect(r.verdict).toBe("diverged");
    expect(
      r.findings.some(
        (f: { key?: string; class: string }) =>
          f.key === "colors.frame" && f.class === "D4",
      ),
    ).toBe(true);
  });

  it("flags an unknown image key and an unknown tint key", async () => {
    const r = await verify({
      manifest: {
        ...CLEAN,
        theme: {
          colors: { frame: [1, 1, 1] },
          images: { not_a_real_image: "x.png" },
          tints: { not_a_real_tint: [0.1, 0.2, 0.3] },
        },
      },
    });
    const keys = r.findings.map((f: { key?: string }) => f.key);
    expect(keys).toContain("images.not_a_real_image");
    expect(keys).toContain("tints.not_a_real_tint");
  });
});

describe("D1 fabrication candidate is advisory, not a false failure", () => {
  it("flags opaque black on a derivable key without flipping the verdict", async () => {
    const r = await verify({
      manifest: {
        name: "Brand",
        version: "1.0",
        theme: { colors: { frame: [30, 60, 90], toolbar_text: [0, 0, 0] } },
      },
    });
    expect(r.verdict).toBe("headless-clean");
    const d1 = r.findings.find((f: { class: string }) => f.class === "D1");
    expect(d1).toBeDefined();
    expect(d1.severity).toBe("info");
    expect(d1.key).toBe("colors.toolbar_text");
    expect(r.summary.advisories).toBeGreaterThan(0);
  });

  it("does not cry fabrication over a required frame set to black", async () => {
    const r = await verify({
      manifest: { name: "Dark", version: "1.0", theme: { colors: { frame: [0, 0, 0] } } },
    });
    expect(r.findings.some((f: { class: string }) => f.class === "D1")).toBe(false);
  });
});

describe("D3 parity gap: image-derived colors the resolver cannot model", () => {
  it("warns that real Chrome may paint image-derived colors differently", async () => {
    const r = await verify({
      manifest: {
        ...CLEAN,
        theme: {
          colors: { frame: [1, 1, 1] },
          images: { theme_frame: "images/frame.png" },
        },
      },
    });
    const d3 = r.findings.filter((f: { class: string }) => f.class === "D3");
    expect(d3.length).toBeGreaterThan(0);
    expect(d3[0].leg).toBe("chrome-paints");
  });
});

describe("input handling", () => {
  it("reads a manifest from a path", async () => {
    const file = path.join(
      os.tmpdir(),
      `theme-verify-${Date.now()}.json`,
    );
    fs.writeFileSync(file, JSON.stringify(CLEAN));
    tmp.push(file);

    const r = await verify({ manifestPath: file });
    expect(r.ok).toBe(true);
    expect(r.legs.manifestSays.name).toBe("Clean");
  });

  it("accepts a { manifest } seed wrapper like assert:theme --theme", async () => {
    const r = await verify({ manifest: { manifest: CLEAN } });
    expect(r.ok).toBe(true);
    expect(r.legs.manifestSays.declared.colors).toEqual(["frame", "toolbar"]);
  });

  it("errors when given neither manifest nor manifestPath", async () => {
    const r = await verify({});
    expect(r.ok).toBe(false);
    expect(r.error.name).toBe("InputError");
  });

  it("errors on an unreadable manifest path", async () => {
    const r = await verify({ manifestPath: "/nope/does/not/exist.json" });
    expect(r.ok).toBe(false);
    expect(r.error.message).toMatch(/Cannot read/);
  });
});
