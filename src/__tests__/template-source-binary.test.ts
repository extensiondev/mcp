import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../lib/templates-cache", () => ({
  getTemplateBySlug: async (slug: string) =>
    slug === "action"
      ? {
          slug: "action",
          description: "An action template",
          uiFramework: "vanilla",
          surfaces: ["action"],
          permissions: [],
          patternExplanation: "",
          keyFiles: [],
          repositoryUrl: "https://example.invalid/action",
          files: ["action/src/images/icon.png", "action/manifest.json"],
        }
      : null,
}));

vi.mock("../lib/template-artifact-source", () => ({
  stripTemplatePathPrefix: (slug: string, file: string) =>
    file.startsWith(`${slug}/`) ? file.slice(slug.length + 1) : file,
  templateCatalogUrl: (slug: string) => `https://example.invalid/${slug}`,
  templateFileUrls: async (slug: string, file: string) => [
    `https://example.invalid/${slug}/${file}`,
  ],
}));

import { readTemplateSource } from "../tools/get-template-source";

const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
  0x49, 0x48, 0x44, 0x52, 0xff, 0xfe, 0xc0, 0x80,
]);

const MANIFEST = '{\n  "name": "Ação"\n}\n';
const MANIFEST_BYTES = Buffer.from(MANIFEST, "utf8");

const bytesOf = (buffer: Buffer): ArrayBuffer =>
  buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength,
  ) as ArrayBuffer;

function serve() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => ({
      ok: true,
      status: 200,
      arrayBuffer: async () =>
        url.endsWith(".png") ? bytesOf(PNG) : bytesOf(MANIFEST_BYTES),
      text: async () => {
        throw new Error("text() would corrupt the bytes");
      },
    })),
  );
}

async function readValue(files: string[]) {
  const frame = JSON.parse(
    await readTemplateSource({ slug: "action", files }),
  ) as {
    hint?: string;
    value: {
      fileContents: Record<string, string>;
      fileEncodings: Record<string, string>;
    };
  };
  return frame;
}

describe("a template icon reaches the agent as an image, not as mojibake", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    serve();
  });

  it("returns a png base64-encoded and round-trips it byte for byte", async () => {
    const frame = await readValue(["src/images/icon.png"]);
    expect(frame.value.fileEncodings["src/images/icon.png"]).toBe("base64");
    expect(
      Buffer.from(frame.value.fileContents["src/images/icon.png"], "base64"),
    ).toEqual(PNG);
  });

  it("names the base64 files in the hint so the agent decodes before writing", async () => {
    const frame = await readValue(["src/images/icon.png"]);
    expect(frame.hint).toContain("Base64-encoded, not text");
    expect(frame.hint).toContain("src/images/icon.png");
    expect(frame.hint).toContain("fileEncodings");
  });

  it("still returns text as text, non-ascii included, and no hint for it", async () => {
    const frame = await readValue(["manifest.json"]);
    expect(frame.value.fileEncodings["manifest.json"]).toBe("utf8");
    expect(frame.value.fileContents["manifest.json"]).toBe(MANIFEST);
    expect(frame.hint).toBeUndefined();
  });
});
