import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  const fsx = await import("node:fs");
  const fakeHome = fsx.mkdtempSync(
    `${actual.tmpdir()}/mcp-templates-home-`,
  );
  const homedir = () => fakeHome;
  return { ...actual, homedir, default: { ...actual, homedir } };
});

vi.mock("../lib/template-artifact-source", () => ({
  templateMetaUrls: async () => ["https://example.invalid/templates-meta.json"],
}));

import os from "node:os";
import { fetchTemplatesMeta, listTemplates } from "../lib/templates-cache";

const fakeHome = os.homedir();
const cacheDir = path.join(fakeHome, ".cache", "extension-js");
const cacheFile = path.join(cacheDir, "templates-meta.json");

beforeEach(() => {
  fs.rmSync(cacheDir, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("templates cache resilience", () => {
  it("falls back to the bundled snapshot on first run offline", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      }),
    );
    const meta = await fetchTemplatesMeta();
    expect(meta.templates.length).toBeGreaterThan(0);
    const templates = await listTemplates();
    expect(templates.length).toBeGreaterThan(0);
  });

  it("survives a corrupted fresh cache file instead of throwing", async () => {
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(cacheFile, "{ torn json");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      }),
    );
    const meta = await fetchTemplatesMeta();
    expect(meta.templates.length).toBeGreaterThan(0);
  });

  it("refuses to cache a shapeless 200 response and serves the snapshot", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({}),
      })),
    );
    const meta = await fetchTemplatesMeta();
    expect(meta.templates.length).toBeGreaterThan(0);
    expect(fs.existsSync(cacheFile)).toBe(false);
  });

  it("caches a usable response atomically and reuses it", async () => {
    const payload = {
      version: "2",
      templates: [{ slug: "one", surfaces: [], description: "" }],
    };
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => payload,
    }));
    vi.stubGlobal("fetch", fetchMock);
    const meta = await fetchTemplatesMeta();
    expect(meta.templates[0].slug).toBe("one");
    expect(JSON.parse(fs.readFileSync(cacheFile, "utf8")).templates[0].slug).toBe(
      "one",
    );
    const again = await fetchTemplatesMeta();
    expect(again.templates[0].slug).toBe("one");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
