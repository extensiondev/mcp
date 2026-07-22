import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { tools as ALL_TOOLS } from "../index";
import * as listBrowsers from "../tools/list-browsers";

import * as manifestValidate from "../tools/manifest-validate";
import * as inspect from "../tools/inspect";
import * as sourceInspect from "../tools/source-inspect";
import * as logs from "../tools/logs";
import * as storage from "../tools/storage";
import * as addFeature from "../tools/add-feature";

describe("MCP Server tool registry", () => {
  it("has exactly 33 tools", () => {
    expect(ALL_TOOLS.length).toBe(33);
  });

  for (const tool of ALL_TOOLS) {
    describe(`tool: ${tool.schema.name}`, () => {
      it("exports a schema with name, description, and inputSchema", () => {
        expect(tool.schema).toBeDefined();
        expect(typeof tool.schema.name).toBe("string");
        expect(tool.schema.name).toMatch(/^extension_/);
        expect(typeof tool.schema.description).toBe("string");
        expect(tool.schema.description.length).toBeGreaterThan(10);
        expect(tool.schema.inputSchema).toBeDefined();
        expect(tool.schema.inputSchema.type).toBe("object");
        expect(tool.schema.inputSchema.properties).toBeDefined();
      });

      it("exports a handler function", () => {
        expect(typeof tool.handler).toBe("function");
      });

      it("has unique tool name", () => {
        const otherTools = ALL_TOOLS.filter((t) => t !== tool);
        const duplicate = otherTools.find(
          (t) => t.schema.name === tool.schema.name,
        );
        expect(duplicate).toBeUndefined();
      });
    });
  }
});

describe("Tool schema validation", () => {
  it("required fields reference existing properties", () => {
    for (const tool of ALL_TOOLS) {
      const required = (tool.schema.inputSchema.required ?? []) as string[];
      const properties = Object.keys(
        (tool.schema.inputSchema.properties ?? {}) as Record<string, unknown>,
      );
      for (const field of required) {
        expect(properties).toContain(field);
      }
    }
  });
});

describe("list-browsers handler", () => {
  it("returns valid JSON with expected fields", async () => {
    const result = await listBrowsers.handler();
    const parsed = JSON.parse(result);
    expect(typeof parsed.cacheRoot).toBe("string");
    expect(typeof parsed.cacheExists).toBe("boolean");
    expect(Array.isArray(parsed.installed)).toBe(true);
    expect(Array.isArray(parsed.availableToInstall)).toBe(true);
  });
});

describe("manifest-validate handler", () => {
  const writeManifest = (manifest: Record<string, unknown>): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "extjs-manifest-"));
    const file = path.join(dir, "manifest.json");
    fs.writeFileSync(file, JSON.stringify(manifest));
    return file;
  };

  it("returns error for non-existent manifest", async () => {
    const result = await manifestValidate.handler({
      manifestPath: "/tmp/nonexistent-manifest.json",
    });
    const parsed = JSON.parse(result);
    expect(parsed.valid).toBe(false);
    expect(parsed.errors.length).toBeGreaterThan(0);
  });

  it("recognizes chrome:/edge: prefixes, not just chromium:", async () => {
    const file = writeManifest({
      name: "prefixed",
      version: "1.0.0",
      "chrome:manifest_version": 2,
    });
    const parsed = JSON.parse(
      await manifestValidate.handler({ manifestPath: file, browsers: ["chrome"] }),
    );
    expect(parsed.errors).not.toContain(
      expect.stringContaining("Missing manifest_version"),
    );
    expect(parsed.browserSupport.chrome.issues.join(" ")).toContain(
      "Manifest V2 is deprecated",
    );
  });

  it("accepts nested firefox:scripts as the background fallback", async () => {
    const file = writeManifest({
      name: "bg",
      version: "1.0.0",
      manifest_version: 3,
      background: {
        service_worker: "sw.js",
        "firefox:scripts": ["bg.js"],
      },
    });
    const parsed = JSON.parse(
      await manifestValidate.handler({
        manifestPath: file,
        browsers: ["firefox"],
      }),
    );
    expect(parsed.browserSupport.firefox.issues.join(" ")).not.toContain(
      "firefox:scripts",
    );
  });

  it("flags a Firefox background missing its scripts fallback", async () => {
    const file = writeManifest({
      name: "bg",
      version: "1.0.0",
      manifest_version: 3,
      background: { service_worker: "sw.js" },
    });
    const parsed = JSON.parse(
      await manifestValidate.handler({
        manifestPath: file,
        browsers: ["firefox"],
      }),
    );
    expect(parsed.browserSupport.firefox.issues.join(" ")).toContain(
      "firefox:scripts",
    );
  });
});

describe("inspect handler", () => {
  it("returns error when dist does not exist", async () => {
    const result = await inspect.handler({
      projectPath: "/tmp/nonexistent-project",
    });
    const parsed = JSON.parse(result);
    expect(parsed.error).toBeDefined();
    expect(parsed.error).toContain("not found");
  });

  // A zip:true build writes the store zip INSIDE dist/<browser>/, so every
  // file used to count twice: once loose and once inside its own package,
  // and the reported size inflated right after packaging (DevX swarm).
  // Archives follow the sourcemap pattern: counted in totalSize, excluded
  // from shippableSize.
  it("excludes .zip artifacts from the shippable size", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-inspect-zip-"));
    try {
      const distDir = path.join(dir, "dist", "chrome");
      fs.mkdirSync(distDir, { recursive: true });
      fs.writeFileSync(
        path.join(distDir, "manifest.json"),
        JSON.stringify({ manifest_version: 3, name: "F", version: "1.0.0" }),
      );
      fs.writeFileSync(path.join(distDir, "background.js"), "x".repeat(1000));
      // Big enough to push totalSize past the 10MB store gate on its own, so
      // the under10MB assertion below proves the archive is excluded there.
      const zipSize = 11 * 1024 * 1024;
      fs.writeFileSync(
        path.join(distDir, "zipprobeext-1.0.0.zip"),
        Buffer.alloc(zipSize),
      );

      const parsed = JSON.parse(await inspect.handler({ projectPath: dir }));

      expect(parsed.byType.archive.count).toBe(1);
      expect(parsed.totalSize).toBe(parsed.shippableSize + zipSize);
      expect(parsed.shippableSize).toBe(
        parsed.totalSize - parsed.byType.archive.size,
      );
      expect(parsed.archiveNote).toContain("shippableSize excludes them");
      // The zip is the package, not payload: it must not read as a dev build
      // artifact or flip the 10MB store gate.
      expect(parsed.buildType).toBe("production");
      expect(parsed.totalSize).toBeGreaterThan(10 * 1024 * 1024);
      expect(parsed.storeReadiness.under10MB).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps shippableSize intact when no archive is present", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-inspect-nozip-"));
    try {
      const distDir = path.join(dir, "dist", "chrome");
      fs.mkdirSync(distDir, { recursive: true });
      fs.writeFileSync(
        path.join(distDir, "manifest.json"),
        JSON.stringify({ manifest_version: 3, name: "F", version: "1.0.0" }),
      );
      fs.writeFileSync(path.join(distDir, "background.js"), "x".repeat(1000));

      const parsed = JSON.parse(await inspect.handler({ projectPath: dir }));

      expect(parsed.shippableSize).toBe(parsed.totalSize);
      expect(parsed.archiveNote).toBeUndefined();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("add-feature handler", () => {
  it("returns error when manifest does not exist", async () => {
    const result = await addFeature.handler({
      projectPath: "/tmp/nonexistent-project",
      feature: "sidebar",
    });
    const parsed = JSON.parse(result);
    expect(parsed.error).toBeDefined();
    expect(parsed.error).toContain("manifest.json");
  });
});

describe("source-inspect handler", () => {
  it("documents the Firefox bridge pairing instead of a Chromium-only claim", () => {
    // Firefox sessions are served over the agent bridge (see
    // gecko-bridge-pairing.test.ts for the behavior); the description must
    // say so, and must not read as CDP/Chromium-only.
    expect(sourceInspect.schema.description).toContain("agent bridge");
    expect(sourceInspect.schema.description).toContain("Firefox");
    expect(sourceInspect.schema.description).not.toMatch(/Chromium only/i);
  });

  it("returns error when no dev session is running", async () => {
    const result = await sourceInspect.handler({
      projectPath: "/tmp/nonexistent-project",
    });
    const parsed = JSON.parse(result);
    expect(parsed.error).toBeDefined();
    expect(parsed.hint).toContain("dev session");
  });
});

describe("logs handler", () => {
  it("returns error when no logs file exists (one-shot)", async () => {
    const result = await logs.handler({
      projectPath: "/tmp/nonexistent-project-logs",
    });
    const parsed = JSON.parse(result);
    expect(parsed.error).toBeDefined();
    expect(parsed.error).toContain("No logs found");
  });

  it("reads, filters, and caps events from logs.ndjson", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "extjs-logs-"));
    // Matches resolveSessionBrowser's fallback, which is "chrome" (not
    // "chromium") since the 5.0.0 pass.
    const dir = path.join(root, "dist", "extension-js", "chrome");
    fs.mkdirSync(dir, { recursive: true });
    const lines = [
      { v: 1, type: "header", runId: "run-xyz", startedAt: "2026-05-27T00:00:00.000Z" },
      { v: 1, id: "a", seq: 1, timestamp: 1, level: "info", context: "background", messageParts: ["boot"], runId: "run-xyz" },
      { v: 1, id: "b", seq: 2, timestamp: 2, level: "error", context: "content", messageParts: ["boom"], eventType: "dx.signal", code: "X", status: "fail", url: "https://shop.example/checkout", hostname: "shop.example", tabId: 7, runId: "run-xyz" },
      { v: 1, id: "c", seq: 3, timestamp: 3, level: "debug", context: "background", messageParts: ["noise"], runId: "run-xyz" },
    ];
    fs.writeFileSync(
      path.join(dir, "logs.ndjson"),
      lines.map((l) => JSON.stringify(l)).join("\n") + "\n",
    );

    const all = JSON.parse(await logs.handler({ projectPath: root }));
    expect(all.ok).toBe(true);
    expect(all.source).toBe("file");
    expect(all.runId).toBe("run-xyz");
    expect(all.count).toBe(3);
    expect(all.nextSince).toBe(3);

    const signals = JSON.parse(await logs.handler({ projectPath: root, signalsOnly: true }));
    expect(signals.count).toBe(1);
    expect(signals.events[0].code).toBe("X");

    const errors = JSON.parse(await logs.handler({ projectPath: root, level: "error" }));
    expect(errors.count).toBe(1);
    expect(errors.events[0].seq).toBe(2);

    const since = JSON.parse(await logs.handler({ projectPath: root, since: 2 }));
    expect(since.count).toBe(1);
    expect(since.events[0].seq).toBe(3);

    const byUrl = JSON.parse(await logs.handler({ projectPath: root, url: "shop.example/*" }));
    expect(byUrl.count).toBe(1);
    expect(byUrl.events[0].seq).toBe(2);
    const byUrlSubstr = JSON.parse(await logs.handler({ projectPath: root, url: "checkout" }));
    expect(byUrlSubstr.count).toBe(1);
    expect(byUrlSubstr.events[0].seq).toBe(2);

    const byTab = JSON.parse(await logs.handler({ projectPath: root, tab: 7 }));
    expect(byTab.count).toBe(1);
    expect(byTab.events[0].seq).toBe(2);
    const byTabMiss = JSON.parse(await logs.handler({ projectPath: root, tab: 999 }));
    expect(byTabMiss.count).toBe(0);

    const capped = JSON.parse(await logs.handler({ projectPath: root, limit: 1 }));
    expect(capped.count).toBe(1);
    expect(capped.truncated).toBe(true);
    expect(capped.events[0].seq).toBe(3);

    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe("storage act tool", () => {
  it("rejects set without a value before shelling out", async () => {
    const result = JSON.parse(
      await storage.handler({
        projectPath: "/tmp/whatever",
        action: "set",
        key: "k",
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatchObject({ name: "BadRequest" });
  });
});
