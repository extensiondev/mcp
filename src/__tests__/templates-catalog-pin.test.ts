import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type * as OsModule from "node:os";

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof OsModule>();
  const fsx = await import("node:fs");
  const fakeHome = fsx.mkdtempSync(`${actual.tmpdir()}/mcp-templates-pin-home-`);
  const homedir = () => fakeHome;

  return { ...actual, homedir, default: { ...actual, homedir } };
});

const POINTER_URL = "https://registry.test/extension-dev/catalog/latest.json";
const OTHER_COMMIT = "f".repeat(40);
const cacheDir = path.join(os.homedir(), ".cache", "extension-js");

type Served = Record<string, unknown>;

const pointerAt = (commit: string): Served => ({
  schema: "templates-catalog-channel/v1",
  channel: "latest",
  commit,
  catalog: `/extension-dev/catalog/${commit}.json`,
});

const documentAt = (commit: string, templates: Served[]): Served => ({
  schema: "templates-catalog/v1",
  source: { repo: "extension-js/examples", commit },
  generatedAt: "2026-10-20T12:55:07.279Z",
  workspace: "extension-dev",
  templates,
});

const ROW = {
  slug: "action",
  surfaces: ["action"],
  description: "A popup",
  downloads: { chrome: "https://registry.test/extension-dev/action/chrome.zip" },
};

function serve(bodies: Record<string, Served | number>) {
  const seen: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL) => {
      const url = String(input);
      seen.push(url);
      const body = bodies[url];
      if (body === undefined) return new Response("not found", { status: 404 });
      if (typeof body === "number") return new Response("down", { status: body });

      return new Response(JSON.stringify(body), { status: 200 });
    }),
  );

  return seen;
}

async function load() {
  vi.resetModules();
  const source = await import("../lib/template-artifact-source");
  const cache = await import("../lib/templates-cache");

  return { ...source, ...cache };
}

let savedCommit: string | undefined;

beforeEach(() => {
  savedCommit = process.env.EXTENSION_TEMPLATES_COMMIT;
  delete process.env.EXTENSION_TEMPLATES_COMMIT;
  process.env.EXTENSION_TEMPLATES_CATALOG_URL = POINTER_URL;
  fs.rmSync(cacheDir, { recursive: true, force: true });
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.EXTENSION_TEMPLATES_CATALOG_URL;
  if (savedCommit === undefined) delete process.env.EXTENSION_TEMPLATES_COMMIT;
  else process.env.EXTENSION_TEMPLATES_COMMIT = savedCommit;
});

describe("the registry catalog behind extension_templates", () => {
  it("lists the pinned catalog live, downloads included, and asks raw GitHub for nothing", async () => {
    const { PINNED_COMMIT, listTemplatesWithSource, resolvedTemplateCommit } = await load();
    const seen = serve({
      [POINTER_URL]: pointerAt(PINNED_COMMIT),
      [`https://registry.test/extension-dev/catalog/${PINNED_COMMIT}.json`]: documentAt(
        PINNED_COMMIT,
        [ROW],
      ),
    });

    const listed = await listTemplatesWithSource();

    expect(listed.source).toBe("live");
    expect(listed.templates.map((t) => t.slug)).toEqual(["action"]);
    expect(listed.templates[0]!.downloads).toEqual(ROW.downloads);
    expect(await resolvedTemplateCommit()).toBe(PINNED_COMMIT);
    expect(seen.some((url) => url.includes("raw.githubusercontent.com"))).toBe(false);
  });

  it("refuses a pointer at another commit and reads raw GitHub at the pin instead", async () => {
    const { PINNED_COMMIT, listTemplatesWithSource, resolvedTemplateCommit, templateFileUrls } =
      await load();
    const seen = serve({
      [POINTER_URL]: pointerAt(OTHER_COMMIT),
      [`https://registry.test/extension-dev/catalog/${OTHER_COMMIT}.json`]: documentAt(
        OTHER_COMMIT,
        [{ ...ROW, slug: "from-the-moved-pointer" }],
      ),
      [`https://raw.githubusercontent.com/extension-js/examples/${PINNED_COMMIT}/templates-meta.json`]:
        { version: "2", templates: [{ ...ROW, slug: "from-raw-github" }] },
    });

    const listed = await listTemplatesWithSource();

    expect(listed.templates.map((t) => t.slug)).toEqual(["from-raw-github"]);
    expect(seen).not.toContain(
      `https://registry.test/extension-dev/catalog/${OTHER_COMMIT}.json`,
    );

    expect(await resolvedTemplateCommit()).toBe(PINNED_COMMIT);
    expect(await templateFileUrls("action", "examples/action/src/manifest.json")).toEqual([
      `https://raw.githubusercontent.com/extension-js/examples/${PINNED_COMMIT}/examples/action/src/manifest.json`,
    ]);
  });

  it("ignores a cached catalog that is not the pinned document and serves the snapshot offline", async () => {
    const { listTemplatesWithSource } = await load();
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(
      path.join(cacheDir, "templates-meta.json"),
      JSON.stringify({ templates: [{ ...ROW, surfaces: ["action"] }] }),
    );

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      }),
    );

    const read = await listTemplatesWithSource({ surface: "devtools" });

    expect(read.source).toBe("bundled-snapshot");
    expect(read.templates.length).toBeGreaterThan(0);
  });

  it("ignores a cached catalog cut at another commit", async () => {
    const { listTemplatesWithSource } = await load();
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(
      path.join(cacheDir, "templates-meta.json"),
      JSON.stringify(documentAt(OTHER_COMMIT, [{ ...ROW, surfaces: ["devtools"] }])),
    );

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      }),
    );

    const read = await listTemplatesWithSource({});

    expect(read.source).toBe("bundled-snapshot");
    expect(read.templates.some((t) => t.slug === "action")).toBe(true);
  });

  it("drops a document cut at another commit and names both shas in the fallback note", async () => {
    const { PINNED_COMMIT, fetchTemplatesMetaWithSource } = await load();
    serve({
      [POINTER_URL]: pointerAt(PINNED_COMMIT),
      [`https://registry.test/extension-dev/catalog/${PINNED_COMMIT}.json`]: documentAt(
        OTHER_COMMIT,
        [ROW],
      ),
      [`https://raw.githubusercontent.com/extension-js/examples/${PINNED_COMMIT}/templates-meta.json`]: 503,
    });

    const read = await fetchTemplatesMetaWithSource();

    expect(read.source).toBe("bundled-snapshot");
    expect(read.note).toContain(OTHER_COMMIT);
    expect(read.note).toContain(PINNED_COMMIT);
    expect(fs.existsSync(path.join(cacheDir, "templates-meta.json"))).toBe(false);
  });
});
